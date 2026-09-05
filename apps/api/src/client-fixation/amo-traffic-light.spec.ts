import {
  backgroundThrottle,
  isInteractiveAmoContext,
  runInteractive,
  __resetAmoTrafficLightForTests,
} from "../../../../packages/integrations/src/amo-traffic-light";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const ENV_KEYS = [
  "AMO_BG_MIN_GAP_MS",
  "AMO_BG_HOLD_AFTER_INTERACTIVE_MS",
  "AMO_BG_MAX_WAIT_MS",
] as const;

describe("amo-traffic-light", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    __resetAmoTrafficLightForTests();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    __resetAmoTrafficLightForTests();
  });

  it("интерактив не ждёт: runInteractive выполняется сразу и ставит контекст", async () => {
    process.env.AMO_BG_MIN_GAP_MS = "300";
    process.env.AMO_BG_HOLD_AFTER_INTERACTIVE_MS = "10000";

    expect(isInteractiveAmoContext()).toBe(false);
    const startedAt = Date.now();
    const seen = await runInteractive(async () => {
      return isInteractiveAmoContext();
    });
    expect(seen).toBe(true);
    expect(isInteractiveAmoContext()).toBe(false);
    // Никаких poll/gap-пауз на интерактивном пути.
    expect(Date.now() - startedAt).toBeLessThan(100);
  });

  it("фон ждёт, пока интерактивная операция активна, и отпускается после неё", async () => {
    process.env.AMO_BG_MIN_GAP_MS = "0";
    process.env.AMO_BG_HOLD_AFTER_INTERACTIVE_MS = "0";
    process.env.AMO_BG_MAX_WAIT_MS = "60000";

    const gate = deferred();
    const interactive = runInteractive(() => gate.promise);

    let bgReleased = false;
    const bg = backgroundThrottle().then(() => {
      bgReleased = true;
    });

    await sleep(450);
    expect(bgReleased).toBe(false); // интерактив в полёте — фон стоит

    gate.resolve();
    await interactive;
    await bg; // после завершения интерактива фон отпускает (poll 200мс)
    expect(bgReleased).toBe(true);
  });

  it("фон продолжает уступать дорогу AMO_BG_HOLD_AFTER_INTERACTIVE_MS после интерактива", async () => {
    process.env.AMO_BG_MIN_GAP_MS = "0";
    process.env.AMO_BG_HOLD_AFTER_INTERACTIVE_MS = "500";
    process.env.AMO_BG_MAX_WAIT_MS = "60000";

    await runInteractive(async () => {});
    const startedAt = Date.now();
    await backgroundThrottle();
    // Ждали как минимум почти весь hold-интервал (минус поллинг-погрешность).
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(400);
  });

  it("фон отпускается после AMO_BG_MAX_WAIT_MS, даже если интерактив завис", async () => {
    process.env.AMO_BG_MIN_GAP_MS = "0";
    process.env.AMO_BG_HOLD_AFTER_INTERACTIVE_MS = "0";
    process.env.AMO_BG_MAX_WAIT_MS = "500";

    const gate = deferred();
    const interactive = runInteractive(() => gate.promise);

    const startedAt = Date.now();
    await backgroundThrottle(); // не должен зависнуть навечно
    const waitedMs = Date.now() - startedAt;
    expect(waitedMs).toBeGreaterThanOrEqual(400);
    expect(waitedMs).toBeLessThan(2000);

    gate.resolve();
    await interactive;
  });

  it("держит базовую паузу AMO_BG_MIN_GAP_MS между фоновыми запросами", async () => {
    process.env.AMO_BG_MIN_GAP_MS = "250";
    process.env.AMO_BG_HOLD_AFTER_INTERACTIVE_MS = "0";
    process.env.AMO_BG_MAX_WAIT_MS = "60000";

    const t0 = Date.now();
    await backgroundThrottle(); // первый идёт сразу
    const afterFirstMs = Date.now() - t0;
    expect(afterFirstMs).toBeLessThan(150);

    await backgroundThrottle(); // второй ждёт паузу
    const afterSecondMs = Date.now() - t0;
    expect(afterSecondMs).toBeGreaterThanOrEqual(200);
  });
});
