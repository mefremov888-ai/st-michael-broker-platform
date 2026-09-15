export type UniquenessHistoryEvent = {
  action?: string;
  payload?: Record<string, unknown> | null;
};

const actionLabels: Record<string, string> = {
  CLIENT_FIXATION: '🆕 Создана фиксация',
  CLIENT_FIXATION_CONFLICT: '⚠ Конфликт фиксации',
  UNIQUENESS_EXTENDED: '⏰ Продление уникальности',
  UNIQUENESS_RESOLVED: '✅ Конфликт разрешён',
  CLIENT_FIXED: '📌 Закреплён',
  AMO_SYNC_FAILED: '❌ Не передан в amoCRM',
};

const rejectedTriggers = new Set([
  'KC_LEAD_CLOSED_143',
  'KC_DID_NOT_ATTACH',
  'AMO_BROKER_DETACHED',
  'SALES_REACHED_DEAL_STAGE',
]);

const approvedTriggers = new Set([
  'RULE_2_KC_LIFTED_AT_MEETING_HELD',
  // 2026-09-15: причина появилась 11.09 вместе с правилом владельца
  // «пока брокер прикреплён к незакрытой карточке — он уникален».
  // Без неё брокер видел обезличенное «Конфликт разрешён».
  'RULE_2_KC_LIFTED_WHILE_ATTACHED',
  'EXCEPTION_LIFTED_BY_KC_STATUS',
  'AMO_KC_APPROVED',
  'AMO_BROKER_REATTACHED',
  'EXCEPTION_LIFTED_BY_BROKER_A_FAILED',
]);

export function uniquenessHistoryLabel(event: UniquenessHistoryEvent): string {
  if (event.action !== 'UNIQUENESS_RESOLVED') {
    return actionLabels[event.action || ''] || event.action || 'Событие';
  }
  const trigger = typeof event.payload?.trigger === 'string' ? event.payload.trigger : '';
  const status = typeof event.payload?.status === 'string' ? event.payload.status : '';
  if (trigger === 'SALES_REACHED_EXCEPTION_STAGE' || status === 'UNDER_REVIEW') return '🔎 Передано на проверку';
  if (rejectedTriggers.has(trigger) || status === 'REJECTED') return '⛔ Фиксация отклонена';
  if (approvedTriggers.has(trigger) || status === 'CONDITIONALLY_UNIQUE') return '✅ Уникальность подтверждена';
  return actionLabels.UNIQUENESS_RESOLVED;
}

export function uniquenessHistoryResult(event: UniquenessHistoryEvent): string | null {
  if (event.action !== 'UNIQUENESS_RESOLVED') return null;
  const trigger = typeof event.payload?.trigger === 'string' ? event.payload.trigger : '';
  const status = typeof event.payload?.status === 'string' ? event.payload.status : '';
  if (trigger === 'SALES_REACHED_EXCEPTION_STAGE' || status === 'UNDER_REVIEW') return 'На проверке';
  if (rejectedTriggers.has(trigger) || status === 'REJECTED') return 'Не уникален';
  if (approvedTriggers.has(trigger) || status === 'CONDITIONALLY_UNIQUE') return 'Уникален';
  return null;
}
