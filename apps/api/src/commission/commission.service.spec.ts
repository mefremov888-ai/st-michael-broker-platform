import {
  CommissionService,
  paymentTermsForPolicy,
} from './commission.service';

describe('paymentTermsForPolicy', () => {
  it('uses values from CommissionPolicy instead of legacy CMS values', () => {
    const result = paymentTermsForPolicy(
      {
        installmentEnabled: false,
        installmentDiscount: 1.25,
        subsidizedMortgageEnabled: true,
        subsidizedMortgageRate: 3.4,
      },
      'ZORGE9',
      {
        installmentEnabledByProject: { ZORGE9: true },
        installmentDiscountByProject: { ZORGE9: 0.1 },
        subsidizedMortgageEnabledByProject: { ZORGE9: false },
        subsidizedMortgageRateByProject: { ZORGE9: 9.9 },
      },
    );

    expect(result).toEqual({
      installmentEnabled: false,
      installmentDiscount: 1.25,
      subsidizedMortgageEnabled: true,
      subsidizedMortgageRate: 3.4,
    });
  });

  it('falls back to project-specific legacy CMS values for an old nullable policy', () => {
    const result = paymentTermsForPolicy(
      {
        installmentEnabled: null,
        installmentDiscount: null,
        subsidizedMortgageEnabled: null,
        subsidizedMortgageRate: null,
      },
      'SILVER_BOR',
      {
        installmentEnabled: true,
        installmentDiscount: 0.5,
        subsidizedMortgageEnabled: true,
        subsidizedMortgageRate: 4,
        installmentEnabledByProject: { SILVER_BOR: false },
        installmentDiscountByProject: { SILVER_BOR: 0.8 },
        subsidizedMortgageEnabledByProject: { SILVER_BOR: false },
        subsidizedMortgageRateByProject: { SILVER_BOR: 2.9 },
      },
    );

    expect(result).toEqual({
      installmentEnabled: false,
      installmentDiscount: 0.8,
      subsidizedMortgageEnabled: false,
      subsidizedMortgageRate: 2.9,
    });
  });
});
describe('CommissionService.calculateCommission', () => {
  const activePolicy = {
    id: 'policy-1',
    project: 'ZORGE9',
    mode: 'FLAT',
    flatRate: 7,
    levels: null,
    isActive: true,
    startDate: new Date('2026-01-01T00:00:00.000Z'),
    endDate: new Date('2026-12-31T23:59:59.999Z'),
    installmentEnabled: true,
    installmentDiscount: 1.25,
    subsidizedMortgageEnabled: true,
    subsidizedMortgageRate: 3.2,
  };

  function createService() {
    const prisma = {
      broker: {
        findUnique: jest.fn().mockResolvedValue({
          brokerAgencies: [
            {
              agency: {
                name: 'Тестовое агентство',
                totalSqmSold: 0,
              },
            },
          ],
        }),
      },
      commissionPolicy: {
        findFirst: jest.fn().mockResolvedValue(activePolicy),
      },
      siteContent: {
        findUnique: jest.fn().mockResolvedValue({
          value: {
            installmentDiscountByProject: { ZORGE9: 0.1 },
            subsidizedMortgageRateByProject: { ZORGE9: 9.9 },
          },
        }),
      },
    };

    return {
      prisma,
      service: new CommissionService(prisma as any),
    };
  }

  it('subtracts installmentDiscount from the active CommissionPolicy', async () => {
    const { service, prisma } = createService();

    const result = await service.calculateCommission({
      amount: 2_000_000,
      project: 'ZORGE9',
      paymentMode: 'INSTALLMENT',
      brokerId: 'broker-1',
    });

    expect(result).toMatchObject({
      mode: 'FLAT',
      rate: 5.75,
      commission: 115_000,
      paymentMode: 'INSTALLMENT',
      installmentDiscount: 1.25,
    });
    expect(prisma.commissionPolicy.findFirst).toHaveBeenCalled();
  });

  it('uses subsidizedMortgageRate from the active CommissionPolicy', async () => {
    const { service } = createService();

    const result = await service.calculateCommission({
      amount: 2_000_000,
      project: 'ZORGE9',
      paymentMode: 'SUBSIDIZED_MORTGAGE',
      brokerId: 'broker-1',
    });

    expect(result).toMatchObject({
      mode: 'FLAT',
      rate: 3.2,
      commission: 64_000,
      paymentMode: 'SUBSIDIZED_MORTGAGE',
      subsidizedMortgageRate: 3.2,
    });
  });
});
