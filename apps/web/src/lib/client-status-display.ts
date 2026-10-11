export type ClientStatusEvidence = {
  uniquenessStatus?: string | null;
  fixationStatus?: string | null;
  amoSyncStatus?: string | null;
};

const uniquenessLabels: Record<string, { label: string; cls: string }> = {
  CONDITIONALLY_UNIQUE: { label: 'Уникален', cls: 'bg-success/20 text-success' },
  REJECTED: { label: 'Не уникален', cls: 'bg-error/20 text-error' },
  UNDER_REVIEW: { label: 'На проверке', cls: 'bg-warning/20 text-warning' },
  EXPIRED: { label: 'Истёк', cls: 'bg-text-muted/20 text-text-muted' },
};

/** Presentation only: never modifies the uniqueness verdict or fixation state. */
export function clientTransferUnconfirmed(client: ClientStatusEvidence): boolean {
  return client.fixationStatus === 'NOT_FIXED'
    && (client.amoSyncStatus === 'FAILED' || client.amoSyncStatus === 'PENDING');
}

export function clientTransferAwaitingFixation(client: ClientStatusEvidence): boolean {
  return client.amoSyncStatus === 'SYNCED'
    && client.fixationStatus === 'NOT_FIXED'
    && client.uniquenessStatus === 'CONDITIONALLY_UNIQUE';
}

export function clientStatusDisplay(client: ClientStatusEvidence) {
  if (clientTransferAwaitingFixation(client)) {
    return {
      label: 'Передан в amoCRM — не зафиксирован',
      cls: 'bg-info/20 text-info',
      explanation: 'Заявка передана в amoCRM. Результат проверки — условно уникален; фиксация пока не оформлена. Повторно подавать заявку не нужно.',
      showUniquenessExpiry: true,
    };
  }
  const blocked = clientTransferUnconfirmed(client);
  if (blocked && client.uniquenessStatus === 'CONDITIONALLY_UNIQUE') {
    return {
      label: client.amoSyncStatus === 'FAILED' ? 'Передача не подтверждена' : 'Передача проверяется',
      cls: 'bg-warning/20 text-warning',
      explanation: 'Заявка сохранена в кабинете, но передача в amoCRM не подтверждена. Клиент пока не зафиксирован. Повторно отправлять заявку не нужно — менеджер проверит её.',
      showUniquenessExpiry: false,
    };
  }
  return {
    ...(uniquenessLabels[client.uniquenessStatus || ''] || { label: client.uniquenessStatus || 'Статус не указан', cls: 'bg-text-muted/20 text-text-muted' }),
    explanation: blocked ? 'Клиент не зафиксирован. Передача заявки в amoCRM ещё не подтверждена.' : '',
    showUniquenessExpiry: !blocked,
  };
}
