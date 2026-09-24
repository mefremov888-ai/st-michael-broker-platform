import {
  SmscAdapter,
  isSmscDelivered,
  isSmscFinalStatus,
  normalizeSmscPhone,
  parseSmscSendResponse,
  parseSmscStatusResponse,
} from "@st-michael/integrations";

describe("SmscAdapter (smsc.ru)", () => {
  it("нормализует российские мобильные, остальное отвергает", () => {
    expect(normalizeSmscPhone("+7 (926) 070-11-01")).toBe("79260701101");
    expect(normalizeSmscPhone("89260701101")).toBe("79260701101");
    expect(normalizeSmscPhone("9260701101")).toBe("79260701101");
    expect(normalizeSmscPhone("+74950000000")).toBeNull();
    expect(normalizeSmscPhone("12345")).toBeNull();
  });

  it("разбирает успешный ответ send.php", () => {
    expect(parseSmscSendResponse({ id: 12345, cnt: 1, cost: "3.5", balance: "1200.75" })).toEqual({
      ok: true, id: "12345", parts: 1, cost: 3.5, balance: 1200.75,
    });
  });

  it("разбирает ошибку send.php с русским пояснением", () => {
    const r = parseSmscSendResponse({ error: "authorise error", error_code: 2 });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(2);
    expect(parseSmscSendResponse({ error_code: 3 }).error).toContain("недостаточно средств");
    expect(parseSmscSendResponse({}).ok).toBe(false);
  });

  it("разбирает status.php и различает финальные статусы", () => {
    const r = parseSmscStatusResponse({ status: 1, last_date: "24.09.2026 14:05:31" });
    expect(r.ok).toBe(true);
    expect(r.statusText).toBe("доставлено");
    expect(r.changedAt?.toISOString()).toBe("2026-09-24T11:05:31.000Z");
    expect(isSmscDelivered(1)).toBe(true);
    expect(isSmscDelivered(0)).toBe(false);
    expect(isSmscFinalStatus(0)).toBe(false);
    expect(isSmscFinalStatus(-1)).toBe(false);
    expect(isSmscFinalStatus(20)).toBe(true);
    expect(isSmscFinalStatus(3)).toBe(true);
  });

  it("send: POST form с логином, ключом, номером, текстом, отправителем и fmt=3", async () => {
    const calls: any[] = [];
    const fetchImpl = jest.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({}), text: async () => JSON.stringify({ id: 7, cnt: 1, cost: "3.1" }) };
    });
    const adapter = new SmscAdapter({ login: "stmichael", apiKey: "secret$key", sender: "St. Michael" }, fetchImpl as any);
    const res = await adapter.send("+79260701101", "Код входа в кабинет брокера: 482913. Никому не сообщайте.");
    expect(res).toEqual({ ok: true, id: "7", parts: 1, cost: 3.1, balance: undefined });
    expect(calls[0].url).toBe("https://smsc.ru/sys/send.php");
    const params = new URLSearchParams(calls[0].init.body);
    expect(params.get("login")).toBe("stmichael");
    expect(params.get("psw")).toBe("secret$key");
    expect(params.get("phones")).toBe("79260701101");
    expect(params.get("mes")).toContain("482913");
    expect(params.get("sender")).toBe("St. Michael");
    expect(params.get("fmt")).toBe("3");
    expect(params.get("charset")).toBe("utf-8");
  });

  it("send: без логина/ключа не ходит в сеть", async () => {
    const fetchImpl = jest.fn();
    const adapter = new SmscAdapter({ login: "", apiKey: "" }, fetchImpl as any);
    const res = await adapter.send("+79260701101", "x");
    expect(res.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("send: не-JSON ответ и сетевая ошибка превращаются в понятную ошибку", async () => {
    const html = jest.fn(async () => ({ ok: false, status: 502, json: async () => ({}), text: async () => "<html>bad gateway</html>" }));
    const a1 = new SmscAdapter({ login: "l", apiKey: "k" }, html as any);
    const r1 = await a1.send("+79260701101", "x");
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain("HTTP 502");

    const boom = jest.fn(async () => { throw new Error("ECONNRESET"); });
    const a2 = new SmscAdapter({ login: "l", apiKey: "k" }, boom as any);
    const r2 = await a2.send("+79260701101", "x");
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain("ECONNRESET");
  });
});
