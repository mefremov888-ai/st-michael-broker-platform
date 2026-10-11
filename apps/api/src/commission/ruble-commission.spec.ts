import { confirmedAgencySalesRub, currentRubleDisplayPolicies, isRublePolicy, prospectiveRubleBonus, RUB_COMMISSION_LEVELS, rubleBonus, rublePaymentRate } from './ruble-commission';
import { CommissionService, rateForWithPolicy } from './commission.service';

describe('Published ruble commission rules', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-10-11T14:00:00Z')); });
  afterEach(() => jest.useRealTimers());
  it.each([[0,.2],[149999999,.2],[150000000,.3],[200000000,.4],[250000000,.5],[300000000,.6],[350000000,.7],[450000000,.8],[550000000,.9],[650000000,1]])('volume %s -> bonus %s', (volume, bonus) => expect(rubleBonus(volume)).toBe(bonus));
  it.each([NaN, Infinity, -1])('does not invent unknown volume %s', value => expect(() => rubleBonus(value)).toThrow());
  it('separates down payment at the strict 50% boundary', () => {
    expect(rublePaymentRate('FULL')).toBe(5);
    expect(rublePaymentRate('SUBSIDIZED_MORTGAGE')).toBe(4);
    expect(rublePaymentRate('INSTALLMENT', 50)).toBe(4);
    expect(rublePaymentRate('INSTALLMENT', 50.01)).toBe(4.5);
    expect(() => rublePaymentRate('INSTALLMENT')).toThrow();
  });
  it('does not identify historical sqm policy as the current rule', () => {
    expect(isRublePolicy({ levels: RUB_COMMISSION_LEVELS })).toBe(true);
    expect(isRublePolicy({ levels: [{ minSqm: 0, rate: 5 }] })).toBe(false);
  });
  it('sums both projects, deduplicates parent cards and performs no writes', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id:'a', amount:100000000, contractType:'DDU', amoDealId:1 },
      { id:'b', amount:100000000, contractType:'DDU', amoParentDealId:1, amoDealId:2 },
      { id:'c', amount:50000000, contractType:'DKP', amoDealId:3 },
    ]);
    expect(await confirmedAgencySalesRub({ deal: { findMany } }, 'agency', new Date('2027-01-31'))).toBe(150000000);
    expect(findMany.mock.calls[0][0].where).toMatchObject({ agencyId: 'agency', project: { in: ['ZORGE9','SILVER_BOR'] }, signedAt: { lte: new Date('2026-12-31T20:59:59.999Z') } });
  });
  it('does not assume agency or incomplete contract values', async () => {
    expect(await confirmedAgencySalesRub({}, undefined)).toBeNull();
    expect(await confirmedAgencySalesRub({ deal: { findMany: async () => [] } }, 'a')).toBeNull();
    expect(await confirmedAgencySalesRub({ deal: { findMany: async () => [{ id:'a', amount:1, contractType:null }] } }, 'a')).toBeNull();
  });
  it('calculates payment base plus bonus without mutating saved deal history', async () => {
    const prisma = {
      broker: { findUnique: jest.fn().mockResolvedValue({ brokerAgencies:[{ agency:{ id:'agency',name:'Agency' } }] }) },
      commissionPolicy: { findFirst: jest.fn().mockResolvedValue({ mode:'PROGRESSIVE', levels:RUB_COMMISSION_LEVELS }) },
      deal: { findMany: jest.fn().mockResolvedValue([{ id:'d', amount:150000000, contractType:'DDU' }]), update:jest.fn(), updateMany:jest.fn() },
    };
    const result = await new CommissionService(prisma as any).calculateCommission({ brokerId:'b', project:'ZORGE9', amount:10000000, paymentMode:'INSTALLMENT', downPaymentPercent:50 });
    expect(result).toMatchObject({ baseRate:4, bonusRate:.3, rate:4.3, commission:430000 });
    expect(prisma.deal.update).not.toHaveBeenCalled();
    expect(prisma.deal.updateMany).not.toHaveBeenCalled();
    await expect(rateForWithPolicy(prisma, 'ZORGE9', 700)).rejects.toThrow('первоначальный взнос');
  });
  it('uses current display terms instead of stale accounting sqm policy and leaves that policy unchanged', async () => {
    const stale = { mode:'PROGRESSIVE', levels:[{ level:'START',minSqm:0,rate:8 }] };
    const prisma = {
      broker: { findUnique:async () => ({ brokerAgencies:[{agency:{id:'a',name:'A'}}] }) },
      commissionPolicy:{ findFirst:async () => stale },
      deal:{findMany:async () => [{ id:'d', amount:150000000, contractType:'DDU' }] },
    };
    const result = await new CommissionService(prisma as any).calculateCommission({ brokerId:'b', project:'SILVER_BOR', amount:10000000, paymentMode:'FULL' });
    expect(result).toMatchObject({ rate:5.3, baseRate:5, bonusRate:.3, isEstimate:true });
    expect(stale.levels[0].rate).toBe(8);
    expect(currentRubleDisplayPolicies()![0]).toMatchObject({ basis:'SALES_RUB_2026', source:'PUBLISHED_COOPERATION_TERMS' });
  });
  it('versioned display rules expire and never pretend an old source was renewed', () => {
    expect(currentRubleDisplayPolicies(new Date('2027-02-01T00:00:00Z'))).toEqual([]);
  });
  it('applies the reached threshold already to the proposed new 2026 contract', async () => {
    const prisma = {
      broker:{findUnique:async () => ({brokerAgencies:[{agency:{id:'a',name:'A'}}]})},
      deal:{findMany:async () => [{id:'d',amount:149000000,contractType:'DDU'}]},
    };
    const result = await new CommissionService(prisma as any).calculateCommission({brokerId:'b',project:'ZORGE9',amount:1000000,paymentMode:'FULL'});
    expect(result).toMatchObject({totalSalesRub:149000000,bonusBasisRub:150000000,includesProposedDeal:true,bonusRate:.3,rate:5.3,commission:53000});
  });
  it('freezes 2026 level in January and does not count the new 2027 contract', async () => {
    jest.setSystemTime(new Date('2027-01-15T12:00:00Z'));
    const prisma = {
      broker:{findUnique:async () => ({brokerAgencies:[{agency:{id:'a',name:'A'}}]})},
      deal:{findMany:async () => [{id:'d',amount:149000000,contractType:'DDU'}]},
    };
    const result = await new CommissionService(prisma as any).calculateCommission({brokerId:'b',project:'SILVER_BOR',amount:1000000,paymentMode:'FULL'});
    expect(result).toMatchObject({totalSalesRub:149000000,bonusBasisRub:149000000,includesProposedDeal:false,bonusRate:.2,rate:5.2,commission:52000});
    expect(result.bonusBasisNote).toMatch(/сохранённый уровень/);
  });
  it('uses Moscow year boundary, not UTC year boundary, for bonus volume', () => {
    expect(prospectiveRubleBonus(149000000,1000000,new Date('2026-12-31T20:59:59.999Z')).bonusRate).toBe(.3);
    expect(prospectiveRubleBonus(149000000,1000000,new Date('2026-12-31T21:00:00Z')).bonusRate).toBe(.2);
  });
});
