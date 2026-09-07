import {
  AMO_CREATE_RECONCILIATION_REQUIRED_MARKER,
  AMO_UNIQUENESS_RECHECK_MARKER,
  isSafeAmoCreateRetry,
  markAmoCreateFailure,
  publicAmoSyncError,
  requeueAmoAuthDeadLetters,
  requiresAmoCreateReconciliation,
  sanitizeAmoSyncError,
} from './amo-sync-retry';

describe('amo sync retry safety', () => {
  it('turns a raw WAF response into a stable non-sensitive category', () => {
    const raw =
      'amoCRM 403 /contacts?query=+79990000001: <html>secret diagnostic</html>';
    const stored = sanitizeAmoSyncError(raw);
    const shown = publicAmoSyncError(raw);

    expect(stored).toBe('AMO_FORBIDDEN_403');
    expect(shown).toBe('amoCRM отклонила запрос. Проверьте права интеграции.');
    expect(`${stored} ${shown}`).not.toContain('+79990000001');
    expect(`${stored} ${shown}`).not.toContain('<html>');
  });

  it('preserves the uniqueness state-machine marker but hides it from UI', () => {
    const marker = `${AMO_UNIQUENESS_RECHECK_MARKER}previous-client-id`;
    expect(sanitizeAmoSyncError(marker)).toBe(marker);
    expect(publicAmoSyncError(marker)).toBe(
      'Ожидается повторная проверка уникальности в amoCRM',
    );
  });

  it('keeps sanitized codes idempotent for later API reads', () => {
    expect(sanitizeAmoSyncError('AMO_TEMPORARY_UNAVAILABLE')).toBe(
      'AMO_TEMPORARY_UNAVAILABLE',
    );
    expect(publicAmoSyncError('AMO_TEMPORARY_UNAVAILABLE')).toBe(
      'amoCRM временно недоступна.',
    );
    expect(publicAmoSyncError('AMO_FIXATION_CREATE_UNCONFIRMED_NO_LEAD')).toBe(
      'Ответ amoCRM не получен, лид не найден. Повтор будет выполнен автоматически.',
    );
  });

  it.each([
    new Error('fetch failed after timeout'),
    new Error('amoCRM 503 unavailable'),
    new Error('amoCRM did not return a lead id'),
    new Error('unexpected adapter failure'),
  ])('marks an ambiguous create response for manual reconciliation', (error) => {
    const stored = markAmoCreateFailure(error);

    expect(stored.startsWith(AMO_CREATE_RECONCILIATION_REQUIRED_MARKER)).toBe(true);
    expect(requiresAmoCreateReconciliation(stored)).toBe(true);
    expect(isSafeAmoCreateRetry(stored)).toBe(false);
    expect(publicAmoSyncError(stored)).toBe(
      'Ответ amoCRM неоднозначен. Автоповтор заблокирован до ручной сверки.',
    );
  });

  it.each([
    ['amoCRM 401 Unauthorized', 'AMO_AUTH_401'],
    ['amoCRM 403 Forbidden', 'AMO_FORBIDDEN_403'],
    ['amoCRM 429 rate limit', 'AMO_RATE_LIMIT_429'],
    ['AMO_FIXATION_CREATE_UNCONFIRMED_NO_LEAD', 'AMO_FIXATION_CREATE_UNCONFIRMED_NO_LEAD'],
  ])('keeps a definite rejected create eligible for the existing retry policy', (raw, code) => {
    expect(markAmoCreateFailure(new Error(raw))).toBe(code);
    expect(isSafeAmoCreateRetry(code)).toBe(true);
  });

  it('requeues only exhausted auth failures with no recorded amo lead', async () => {
    const prisma = {
      client: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };

    const count = await requeueAmoAuthDeadLetters(
      prisma as any,
      'test-recovery',
      'admin-id',
    );

    expect(count).toBe(3);
    expect(prisma.client.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        amoSyncStatus: { in: ['FAILED', 'PENDING'] },
        amoSyncAttempts: { gte: 10 },
        amoLeadId: null,
      }),
      data: {
        amoSyncStatus: 'PENDING',
        amoSyncAttempts: 0,
        amoSyncLastAttemptAt: new Date(0),
        amoSyncError: null,
      },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'admin-id',
        action: 'AMO_AUTH_DEAD_LETTERS_REQUEUED',
        payload: { count: 3, source: 'test-recovery' },
      }),
    });
  });
});
