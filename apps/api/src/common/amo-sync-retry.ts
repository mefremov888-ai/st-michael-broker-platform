import type { PrismaClient } from '@st-michael/database';

export const AMO_UNIQUENESS_RECHECK_MARKER =
  'AMO_UNIQUENESS_RECHECK_REQUIRED:';
export const AMO_RETRY_MAX_ATTEMPTS = 10;
const AMO_SYNC_ERROR_CODES = new Set([
  'AMO_AUTH_401',
  'AMO_FORBIDDEN_403',
  'AMO_RATE_LIMIT_429',
  'AMO_TEMPORARY_UNAVAILABLE',
  'AMO_NETWORK_ERROR',
  'AMO_CONFIGURATION_ERROR',
  'AMO_INVALID_RESPONSE',
  'FIXATION_AGENCY_MISSING',
  'BROKER_AMO_CONTACT_MISSING',
  'AMO_SYNC_FAILED',
]);

/**
 * amoCRM sometimes returns an HTML WAF page (and the request URL can contain a
 * phone number). Persisting that response makes it visible in the admin UI and
 * copies dependency internals/PII into audit and logs. Store a stable category
 * instead. The uniqueness marker is deliberately preserved because it controls
 * the retry state machine.
 */
export function sanitizeAmoSyncError(error: unknown): string {
  const raw = String((error as any)?.message || error || '');
  if (raw.startsWith(AMO_UNIQUENESS_RECHECK_MARKER)) return raw.slice(0, 200);
  if (AMO_SYNC_ERROR_CODES.has(raw)) return raw;

  const normalized = raw.toLowerCase();
  if (/\b401\b/.test(normalized) || normalized.includes('unauthoriz')) {
    return 'AMO_AUTH_401';
  }
  if (/\b403\b/.test(normalized) || normalized.includes('forbidden')) {
    return 'AMO_FORBIDDEN_403';
  }
  if (/\b429\b/.test(normalized) || normalized.includes('rate limit')) {
    return 'AMO_RATE_LIMIT_429';
  }
  if (/\b5\d\d\b/.test(normalized)) return 'AMO_TEMPORARY_UNAVAILABLE';
  if (
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('network') ||
    normalized.includes('socket') ||
    normalized.includes('fetch') ||
    normalized.includes('econn') ||
    normalized.includes('enotfound')
  ) {
    return 'AMO_NETWORK_ERROR';
  }
  if (normalized.includes('agency')) return 'FIXATION_AGENCY_MISSING';
  if (normalized.includes('broker') && normalized.includes('contact')) {
    return 'BROKER_AMO_CONTACT_MISSING';
  }
  if (
    normalized.includes('not configured') ||
    normalized.includes('не настроен') ||
    normalized.includes('missing token')
  ) {
    return 'AMO_CONFIGURATION_ERROR';
  }
  if (
    normalized.includes('did not return a lead id') ||
    normalized.includes('не вернула id')
  ) {
    return 'AMO_INVALID_RESPONSE';
  }
  return 'AMO_SYNC_FAILED';
}

/** Safe, operator-facing text. Never returns the stored raw dependency body. */
export function publicAmoSyncError(error: unknown): string | null {
  if (!error) return null;
  const code = sanitizeAmoSyncError(error);
  if (code.startsWith(AMO_UNIQUENESS_RECHECK_MARKER)) {
    return 'Ожидается повторная проверка уникальности в amoCRM';
  }
  const messages: Record<string, string> = {
    AMO_AUTH_401: 'amoCRM отклонила авторизацию. Проверьте подключение.',
    AMO_FORBIDDEN_403: 'amoCRM отклонила запрос. Проверьте права интеграции.',
    AMO_RATE_LIMIT_429: 'amoCRM временно ограничила частоту запросов.',
    AMO_TEMPORARY_UNAVAILABLE: 'amoCRM временно недоступна.',
    AMO_NETWORK_ERROR: 'Нет связи с amoCRM. Повтор будет выполнен автоматически.',
    AMO_CONFIGURATION_ERROR: 'Интеграция amoCRM не настроена.',
    AMO_INVALID_RESPONSE: 'amoCRM вернула неполный ответ.',
    FIXATION_AGENCY_MISSING: 'У заявки не указана компания. Нужна ручная проверка.',
    BROKER_AMO_CONTACT_MISSING:
      'Ответственный брокер не связан с контактом amoCRM.',
    AMO_SYNC_FAILED: 'Не удалось передать заявку в amoCRM.',
  };
  return messages[code] || messages.AMO_SYNC_FAILED;
}

export function hasConfiguredAmoCredentials(): boolean {
  // Imported lazily so tests that mutate env do not depend on module-load time.
  // In production AmoTokenBootstrapService keeps the shared adapter state in
  // sync with SystemSetting; the env fallback supports older deployments.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getAmoTokens } = require('@st-michael/integrations') as {
    getAmoTokens: () => { access?: string; refresh?: string };
  };
  const tokens = getAmoTokens();
  return Boolean(
    tokens?.access ||
      tokens?.refresh ||
      process.env.AMO_ACCESS_TOKEN ||
      process.env.AMO_REFRESH_TOKEN,
  );
}

/**
 * Re-opens only dead-letter auth failures for which no amo lead id was ever
 * recorded. A 401/403 cannot create the lead, so this subset is safe to retry
 * after a verified recovery. Network/5xx failures stay dead-lettered because
 * an ambiguous POST response could otherwise create a duplicate lead.
 */
export async function requeueAmoAuthDeadLetters(
  prisma: PrismaClient | any,
  source: string,
  actorId?: string,
): Promise<number> {
  const result = await prisma.client.updateMany({
    where: {
      amoSyncStatus: { in: ['FAILED', 'PENDING'] },
      amoSyncAttempts: { gte: AMO_RETRY_MAX_ATTEMPTS },
      amoLeadId: null,
      OR: [
        { amoSyncError: 'AMO_AUTH_401' },
        { amoSyncError: 'AMO_FORBIDDEN_403' },
        // Backward compatibility for records created before sanitized codes.
        { amoSyncError: { contains: 'amoCRM 401', mode: 'insensitive' } },
        { amoSyncError: { contains: 'amoCRM 403', mode: 'insensitive' } },
        { amoSyncError: { contains: 'Unauthorized', mode: 'insensitive' } },
        { amoSyncError: { contains: 'Forbidden', mode: 'insensitive' } },
      ],
    },
    data: {
      amoSyncStatus: 'PENDING',
      amoSyncAttempts: 0,
      amoSyncLastAttemptAt: new Date(0),
      amoSyncError: null,
    },
  });
  const count = Number(result?.count || 0);
  if (count > 0 && prisma.auditLog?.create) {
    try {
      await prisma.auditLog.create({
        data: {
          ...(actorId ? { userId: actorId } : {}),
          action: 'AMO_AUTH_DEAD_LETTERS_REQUEUED',
          entity: 'System',
          entityId: 'amo',
          payload: { count, source },
        },
      });
    } catch {
      // Requeue is authoritative; an audit outage must not put rows back into
      // dead-letter or make a successful health check look like an amo outage.
    }
  }
  return count;
}
