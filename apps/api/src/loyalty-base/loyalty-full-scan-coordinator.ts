import { ServiceUnavailableException } from "@nestjs/common";

// 2026-09-04: 2 → 3. После фикса «пустой период по умолчанию» первая
// загрузка страницы легитимно шлёт три full-scan запроса параллельно
// (брокеры + агентства + overview); при бюджете 2 третий стабильно
// получал 503 LOYALTY_FULL_SCAN_BUSY.
export const MAX_CONCURRENT_LOYALTY_FULL_SCANS = 3;
export const LOYALTY_FULL_SCAN_RETRY_AFTER_SECONDS = 2;

export class LoyaltyFullScanBusyException extends ServiceUnavailableException {
  readonly retryAfterSeconds = LOYALTY_FULL_SCAN_RETRY_AFTER_SECONDS;

  constructor() {
    super({
      statusCode: 503,
      code: "LOYALTY_FULL_SCAN_BUSY",
      message:
        "The loyalty base is processing its safe number of full scans; retry shortly",
      retryAfterSeconds: LOYALTY_FULL_SCAN_RETRY_AFTER_SECONDS,
    });
  }
}

// Node keeps one instance of this module per process. Every loyalty full-graph
// reader therefore shares the same admission budget, even when Nest creates
// separate service instances for the base and reconciliation modules.
let activeLoyaltyFullScans = 0;

export async function withLoyaltyFullScanSlot<T>(
  action: () => Promise<T>,
): Promise<T> {
  if (activeLoyaltyFullScans >= MAX_CONCURRENT_LOYALTY_FULL_SCANS) {
    throw new LoyaltyFullScanBusyException();
  }
  activeLoyaltyFullScans += 1;
  try {
    return await action();
  } finally {
    activeLoyaltyFullScans -= 1;
  }
}
