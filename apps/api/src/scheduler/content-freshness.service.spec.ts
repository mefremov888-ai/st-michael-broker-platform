import { ContentFreshnessService, conditionsWarning, moscowCalendar } from './content-freshness.service';

describe('content freshness', () => {
  const now = new Date('2026-10-11T06:15:00Z');
  const setup = () => {
    const rows = new Map<string, any>();
    const prisma = {
      document: { findMany: jest.fn().mockResolvedValue([{ name: 'Условия сотрудничества октябрь 2026' }]) },
      systemSetting: {
        findUnique: jest.fn(async ({ where }) => rows.get(where.key) || null),
        create: jest.fn(async ({ data }) => { if (rows.has(data.key)) throw { code: 'P2002' }; rows.set(data.key, data); return data; }),
        upsert: jest.fn(async ({ where, create, update }) => { rows.set(where.key, rows.has(where.key) ? { ...rows.get(where.key), ...update } : create); }),
      },
    };
    const catalog = { getFreshnessReport: jest.fn().mockResolvedValue([
      { project: 'ZORGE9', lastSuccessfulImportAt: now.toISOString(), sourceGeneratedAt: now.toISOString() },
      { project: 'SILVER_BOR', lastSuccessfulImportAt: now.toISOString(), sourceGeneratedAt: now.toISOString() },
    ]) };
    const alerts = { sendSafely: jest.fn().mockResolvedValue(true) };
    return { prisma, catalog, alerts, rows, service: new ContentFreshnessService(prisma as any, catalog as any, alerts as any) };
  };
  it('uses Moscow date at UTC midnight boundary', () => {
    expect(moscowCalendar(new Date('2026-10-31T22:00:00Z')).date).toBe('2026-11-01');
  });
  it('flags a prior month title without falsely claiming the offer expired', () => {
    expect(conditionsWarning(['Условия сотрудничества сентябрь'], now)).toContain('не подтверждает прекращение');
  });
  it('reminds five days before end of month', () => {
    expect(conditionsWarning(['Условия сотрудничества октябрь 2026'], new Date('2026-10-26T06:00:00Z'))).toContain('5 дней');
  });
  it('does not remind when next month edition is already published', () => {
    expect(conditionsWarning(['Условия сотрудничества октябрь 2026', 'Условия сотрудничества ноябрь 2026'], new Date('2026-10-26T06:00:00Z'))).toBeNull();
  });
  it('handles December rollover and excludes an old year edition', () => {
    expect(conditionsWarning(['Условия сотрудничества январь 2027'], new Date('2026-12-30T06:00:00Z'))).toBeNull();
    expect(conditionsWarning(['Условия сотрудничества октябрь 2025'], now)).not.toBeNull();
  });
  it('reports missing and unversioned conditions', () => {
    expect(conditionsWarning([], now)).toContain('не опубликован');
    expect(conditionsWarning(['Условия сотрудничества'], now)).toContain('не указан');
  });
  it('sends nothing when both sources are healthy', async () => {
    const f = setup(); await f.service.check(now); expect(f.alerts.sendSafely).not.toHaveBeenCalled();
  });
  it('distinguishes stale source from successful import and unknown timestamp', async () => {
    const f = setup(); f.catalog.getFreshnessReport.mockResolvedValue([
      { project: 'ZORGE9', lastSuccessfulImportAt: now.toISOString(), sourceGeneratedAt: '2026-10-01T06:00:00Z' },
      { project: 'SILVER_BOR', lastSuccessfulImportAt: null, sourceGeneratedAt: null },
    ] as any);
    await f.service.check(now);
    expect(f.alerts.sendSafely.mock.calls[0][0]).toContain('дата формирования');
    expect(f.alerts.sendSafely.mock.calls[0][0]).toContain('нет подтверждённой даты');
    expect(f.alerts.sendSafely.mock.calls[0][0]).toContain('Неизменные цены не считаются ошибкой');
  });
  it('deduplicates across service instances and repeats next day', async () => {
    const f = setup(); f.prisma.document.findMany.mockResolvedValue([{ name: 'Условия сотрудничества сентябрь' }]);
    await f.service.check(now);
    await new ContentFreshnessService(f.prisma as any, f.catalog as any, f.alerts as any).check(now);
    expect(f.alerts.sendSafely).toHaveBeenCalledTimes(1);
    await f.service.check(new Date('2026-10-12T06:15:00Z'));
    expect(f.alerts.sendSafely).toHaveBeenCalledTimes(2);
  });
  it('keeps reservation after uncertain Telegram delivery without marking recovered', async () => {
    const f = setup(); f.prisma.document.findMany.mockResolvedValue([]); f.alerts.sendSafely.mockResolvedValue(false);
    await f.service.check(now); await f.service.check(now);
    expect(f.alerts.sendSafely).toHaveBeenCalledTimes(1);
    expect(f.prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });
  it('sends a single recovery after a confirmed warning', async () => {
    const f = setup(); f.prisma.document.findMany.mockResolvedValue([]); await f.service.check(now);
    f.prisma.document.findMany.mockResolvedValue([{ name: 'Условия сотрудничества октябрь 2026' }]);
    await f.service.check(now); await f.service.check(now);
    expect(f.alerts.sendSafely).toHaveBeenCalledTimes(2);
    expect(f.alerts.sendSafely.mock.calls[1][0]).toContain('снова проходит');
  });
  it('continues conditions check if feed inspection fails', async () => {
    const f = setup(); f.catalog.getFreshnessReport.mockRejectedValue(new Error('private-url-secret'));
    f.prisma.document.findMany.mockResolvedValue([]); await f.service.check(now);
    expect(f.alerts.sendSafely).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.alerts.sendSafely.mock.calls)).not.toContain('private-url-secret');
  });
});
