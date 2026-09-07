import { AsyncLocalStorage } from "node:async_hooks";

// 2026-09-05: «светофор» трафика amoCRM. Требование владельца: «живым
// запросам приоритет, заявки от брокеров — максимальный приоритет».
// Пики фонового часового синка дважды роняли фиксацию живого брокера
// (16:01 04.09, 16:14 05.09 — amo под нагрузкой отвечает мусором).
//
// Как и loyalty-full-scan-coordinator: Node держит один экземпляр модуля
// на процесс, поэтому все инстансы AmoCrmAdapter делят одно состояние.
//
// Правила:
//  - интерактивные операции (фиксация брокера, проверка уникальности)
//    идут к amo сразу, без ожиданий;
//  - фоновые (часовой синк, крон-пачки, отчёты) перед КАЖДЫМ запросом:
//    (а) ждут, пока есть активные интерактивные операции ИЛИ с момента
//        последней интерактивной активности прошло меньше
//        AMO_BG_HOLD_AFTER_INTERACTIVE_MS (poll 200мс, максимум
//        AMO_BG_MAX_WAIT_MS — потом пропускаем, чтобы фон не завис);
//    (б) выдерживают базовую паузу AMO_BG_MIN_GAP_MS между фоновыми
//        запросами (~3 rps при дефолте 300мс; amo позволяет 7).

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const envNumber = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
};

// Под jest дефолты нулевые (как AMO_FIXATION_RECOVER_RETRY_DELAY_MS в
// адаптере) — сотни мокнутых fetch-ов в спеках не должны ловить паузы;
// тесты самого светофора задают env явно.
const underJest = (): boolean => Boolean(process.env.JEST_WORKER_ID);

// Читаем env лениво — тесты и ops могут менять значения без пересборки.
export const amoTrafficLightConfig = {
  /** Базовая пауза фона между запросами к amo. */
  get bgMinGapMs(): number {
    return envNumber("AMO_BG_MIN_GAP_MS", underJest() ? 0 : 300);
  },
  /**
   * Сколько фон уступает дорогу ПОСЛЕ завершения интерактивной активности.
   * 2026-09-05: владелец поднял с 3с до 10с — фиксаций мало, синку
   * задержки не страшны.
   */
  get bgHoldAfterInteractiveMs(): number {
    return envNumber(
      "AMO_BG_HOLD_AFTER_INTERACTIVE_MS",
      underJest() ? 0 : 10_000,
    );
  },
  /** Максимум ожидания фона, чтобы он не завис навечно. */
  get bgMaxWaitMs(): number {
    return envNumber("AMO_BG_MAX_WAIT_MS", 60_000);
  },
};

const BG_POLL_MS = 200;
const BG_HELD_LOG_THRESHOLD_MS = 5_000;

let activeInteractiveOps = 0;
let lastInteractiveActivityAt = 0;
// Момент, когда следующему фоновому запросу разрешено уйти в amo.
// «Бронирование слота» сериализует и параллельные фоновые вызовы.
let nextBackgroundSlotAt = 0;

const interactiveContext = new AsyncLocalStorage<true>();

/** true внутри runInteractive (AsyncLocalStorage — сигнатуры не трогаем). */
export function isInteractiveAmoContext(): boolean {
  return interactiveContext.getStore() === true;
}

/** Каждый интерактивный запрос к amo продлевает «зелёный» интерактиву. */
export function noteInteractiveAmoActivity(): void {
  lastInteractiveActivityAt = Date.now();
}

/**
 * Обёртка живой операции брокера: инкремент счётчика → fn → декремент
 * (finally). Всё внутри fn помечено интерактивным контекстом — фоновые
 * запросы к amo в это время стоят.
 */
export async function runInteractive<T>(fn: () => Promise<T>): Promise<T> {
  activeInteractiveOps += 1;
  lastInteractiveActivityAt = Date.now();
  try {
    return await interactiveContext.run(true, fn);
  } finally {
    activeInteractiveOps -= 1;
    lastInteractiveActivityAt = Date.now();
  }
}

/**
 * Вызывается фоном перед каждым запросом к amo. Не бросает — в худшем
 * случае просто отпускает фон после bgMaxWaitMs.
 */
export async function backgroundThrottle(): Promise<void> {
  const startedAt = Date.now();
  const maxWaitMs = amoTrafficLightConfig.bgMaxWaitMs;

  // (а) уступаем дорогу интерактиву
  for (;;) {
    const holdMs = amoTrafficLightConfig.bgHoldAfterInteractiveMs;
    const interactiveBusy =
      activeInteractiveOps > 0 ||
      Date.now() - lastInteractiveActivityAt < holdMs;
    if (!interactiveBusy) break;
    const waitedMs = Date.now() - startedAt;
    if (waitedMs >= maxWaitMs) break; // не зависаем навечно
    await sleep(Math.min(BG_POLL_MS, maxWaitMs - waitedMs));
  }
  const heldMs = Date.now() - startedAt;
  if (heldMs > BG_HELD_LOG_THRESHOLD_MS) {
    // Один лог на ожидание, не на каждый poll.
    console.log(
      `[amo-traffic] background held ${heldMs}ms (interactive in flight)`,
    );
  }

  // (б) базовая пауза фона между запросами (rate limit фона ~3 rps)
  const gapMs = amoTrafficLightConfig.bgMinGapMs;
  const now = Date.now();
  const slotAt = Math.max(now, nextBackgroundSlotAt);
  nextBackgroundSlotAt = slotAt + gapMs;
  if (slotAt > now) await sleep(slotAt - now);
}

/** Только для тестов: сброс процесс-глобального состояния. */
export function __resetAmoTrafficLightForTests(): void {
  activeInteractiveOps = 0;
  lastInteractiveActivityAt = 0;
  nextBackgroundSlotAt = 0;
}
