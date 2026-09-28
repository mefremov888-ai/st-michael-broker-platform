// 2026-09-28: unit-тесты методов ЧТЕНИЯ адаптера amoCRM для ночного синка
// «касаний» (примечания-звонки, задачи, лиды пачками, users) и чистых
// функций pickLatest*. Сеть мокается через global.fetch.
import {
  AmoCrmAdapter,
  getAmoTokens,
  setAmoTokens,
} from "../../../../packages/integrations/src/amo-crm.adapter";
import {
  AMO_CALL_STATUS_TEXT,
  AMO_NOTE_TYPES,
  AMO_PIPELINES,
  AMO_TASK_TYPES,
} from "../../../../packages/integrations/src/amo-crm.fields";
import {
  AmoCallNote,
  AmoNote,
  AmoTask,
  isCallNote,
  pickLatestCallNote,
  pickLatestCompletedTask,
  pickLatestKcLead,
} from "../../../../packages/integrations/src/amo-crm.touches";

const ok = (body: any) =>
  ({ status: 200, ok: true, headers: new Headers(), json: async () => body }) as any;
const noContent = () =>
  ({ status: 204, ok: true, headers: new Headers(), json: async () => null }) as any;

const calledUrls = (mock: jest.Mock): URL[] =>
  mock.mock.calls.map((call) => new URL(String(call[0])));

describe("AmoCrmAdapter — чтение касаний", () => {
  const originalFetch = global.fetch;
  let originalTokens: ReturnType<typeof getAmoTokens>;

  beforeEach(() => {
    originalTokens = getAmoTokens();
    setAmoTokens("test-token", "");
  });

  afterEach(() => {
    global.fetch = originalFetch;
    setAmoTokens(originalTokens.access, originalTokens.refresh);
    jest.restoreAllMocks();
  });

  describe("getNotesForContacts", () => {
    it("режет id пачками ≤ 50, шлёт filter[note_type][] и группирует по entity_id", async () => {
      const ids = Array.from({ length: 120 }, (_, i) => 1000 + i);
      const fetchMock = jest.fn().mockImplementation(async (url: string) => {
        const u = new URL(url);
        const entityIds = u.searchParams.getAll("filter[entity_id][]").map(Number);
        const notes = entityIds.slice(0, 2).map((entityId, i) => ({
          id: entityId * 10 + i,
          entity_id: entityId,
          note_type: "call_out",
          created_at: 1_700_000_000 + i,
          updated_at: 1_700_000_000 + i,
          params: { duration: 30, call_status: 4 },
        }));
        return ok({ _embedded: { notes } });
      });
      global.fetch = fetchMock;

      const adapter = new AmoCrmAdapter();
      const result = await adapter.getNotesForContacts(ids, {
        noteTypes: ["call_in", "call_out"],
      });

      expect(fetchMock).toHaveBeenCalledTimes(3); // 50 + 50 + 20
      const urls = calledUrls(fetchMock);
      expect(urls[0].pathname).toBe("/api/v4/contacts/notes");
      expect(urls[0].searchParams.getAll("filter[entity_id][]")).toHaveLength(50);
      expect(urls[2].searchParams.getAll("filter[entity_id][]")).toHaveLength(20);
      expect(urls[0].searchParams.getAll("filter[note_type][]")).toEqual([
        "call_in",
        "call_out",
      ]);
      expect(urls[0].searchParams.get("order[updated_at]")).toBe("desc");
      expect(urls[0].searchParams.get("limit")).toBe("250");
      for (const u of urls) expect(fetchMock.mock.calls[0][1].method).toBeUndefined();

      // Два контакта на пачку × 3 пачки = 6 ключей
      expect(result.size).toBe(6);
      expect(result.get(1000)?.[0].entity_id).toBe(1000);
      expect(result.get(1050)?.[0].id).toBe(10500);
      expect(result.has(1002)).toBe(false);
    });

    it("пагинирует по _links.next и останавливается на короткой странице", async () => {
      const page = (n: number, count: number, next: boolean) =>
        ok({
          _embedded: {
            notes: Array.from({ length: count }, (_, i) => ({
              id: n * 1000 + i,
              entity_id: 7,
              note_type: "common",
              created_at: 1,
              updated_at: 1,
              params: { text: "t" },
            })),
          },
          ...(next ? { _links: { next: { href: "x" } } } : {}),
        });
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(page(1, 2, true))
        .mockResolvedValueOnce(page(2, 2, true))
        .mockResolvedValueOnce(page(3, 1, false));
      global.fetch = fetchMock;

      const adapter = new AmoCrmAdapter();
      const notes = await adapter.getContactNotes(7, { limit: 2 });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      const urls = calledUrls(fetchMock);
      expect(urls.map((u) => u.searchParams.get("page"))).toEqual(["1", "2", "3"]);
      expect(notes).toHaveLength(5);
      expect(notes.map((n) => n.id)).toEqual([1000, 1001, 2000, 2001, 3000]);
    });

    it("204 без примечаний → пустой результат, ошибка HTTP → throw", async () => {
      global.fetch = jest.fn().mockResolvedValueOnce(noContent());
      const adapter = new AmoCrmAdapter();
      expect(await adapter.getLeadNotes(5)).toEqual([]);

      global.fetch = jest.fn().mockResolvedValue({
        status: 403,
        ok: false,
        headers: new Headers(),
        json: async () => ({}),
      } as any);
      await expect(adapter.getNotesForLeads([5])).rejects.toThrow("amoCRM 403");
    });

    it("opts.page читает ровно одну страницу; невалидные id → throw", async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        ok({
          _embedded: {
            notes: Array.from({ length: 250 }, (_, i) => ({
              id: i + 1,
              entity_id: 9,
              note_type: "common",
              created_at: 1,
              updated_at: 1,
              params: {},
            })),
          },
          _links: { next: { href: "x" } },
        }),
      );
      global.fetch = fetchMock;
      const adapter = new AmoCrmAdapter();
      const notes = await adapter.getContactNotes(9, { page: 3 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(calledUrls(fetchMock)[0].searchParams.get("page")).toBe("3");
      expect(notes).toHaveLength(250);

      await expect(adapter.getNotesForContacts([0])).rejects.toThrow(
        "AMO_TOUCHES_ENTITY_IDS_INVALID",
      );
      await expect(adapter.getContactNotes(1, { limit: 251 })).rejects.toThrow(
        "AMO_TOUCHES_LIMIT_INVALID",
      );
    });
  });

  describe("getTasksForEntities / getTasksByEntity", () => {
    it("пачки ≤ 50, filter[is_completed]=1, order[complete_till], пагинация", async () => {
      const fetchMock = jest.fn().mockImplementation(async (url: string) => {
        const u = new URL(url);
        const page = Number(u.searchParams.get("page"));
        const ids = u.searchParams.getAll("filter[entity_id][]").map(Number);
        if (page === 1) {
          return ok({
            _embedded: {
              tasks: ids.map((entityId) => ({
                id: entityId + 1,
                entity_id: entityId,
                entity_type: "leads",
                task_type_id: 1,
                is_completed: true,
                complete_till: 100,
                responsible_user_id: 5,
                result: { text: "дозвон" },
                created_at: 50,
                updated_at: 120,
              })),
            },
            _links: { next: { href: "x" } },
          });
        }
        return ok({ _embedded: { tasks: [] } });
      });
      global.fetch = fetchMock;

      const adapter = new AmoCrmAdapter();
      const ids = Array.from({ length: 60 }, (_, i) => 200 + i);
      const result = await adapter.getTasksForEntities("leads", ids, {
        isCompleted: true,
        order: "desc",
      });

      // 2 пачки × 2 страницы
      expect(fetchMock).toHaveBeenCalledTimes(4);
      const first = calledUrls(fetchMock)[0];
      expect(first.pathname).toBe("/api/v4/tasks");
      expect(first.searchParams.get("filter[entity_type]")).toBe("leads");
      expect(first.searchParams.getAll("filter[entity_id][]")).toHaveLength(50);
      expect(first.searchParams.get("filter[is_completed]")).toBe("1");
      expect(first.searchParams.get("order[complete_till]")).toBe("desc");
      expect(result.size).toBe(60);
      expect(result.get(200)?.[0]).toMatchObject({
        id: 201,
        entity_id: 200,
        entity_type: "leads",
        task_type_id: AMO_TASK_TYPES.CALL,
        is_completed: true,
        responsible_user_id: 5,
        result: { text: "дозвон" },
        updated_at: 120,
      });
    });

    it("getTasksByEntity без opts — прежний одностраничный запрос limit=50", async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        ok({
          _embedded: {
            tasks: [
              {
                id: 1,
                entity_id: 3,
                entity_type: "contacts",
                task_type_id: 2,
                text: "Встреча",
                is_completed: false,
                complete_till: 10,
                responsible_user_id: 4,
                created_at: 1,
                updated_at: 1,
              },
            ],
          },
        }),
      );
      global.fetch = fetchMock;
      const adapter = new AmoCrmAdapter();
      const tasks = await adapter.getTasksByEntity("contacts", 3);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const u = calledUrls(fetchMock)[0];
      expect(u.searchParams.get("filter[entity_id]")).toBe("3");
      expect(u.searchParams.get("limit")).toBe("50");
      expect(tasks[0]).toMatchObject({ id: 1, text: "Встреча", task_type_id: 2 });
    });

    it("getTasksByEntity глотает ошибки (совместимость), getTasksForEntities — нет", async () => {
      // 403 — без ретраев (5xx/429 ретраятся с backoff и не влезают в таймаут теста)
      global.fetch = jest.fn().mockResolvedValue({
        status: 403,
        ok: false,
        headers: new Headers(),
        json: async () => ({}),
      } as any);
      const adapter = new AmoCrmAdapter();
      jest.spyOn(console, "error").mockImplementation(() => undefined);
      expect(await adapter.getTasksByEntity("leads", 1, { isCompleted: true })).toEqual([]);
      await expect(adapter.getTasksForEntities("leads", [1])).rejects.toThrow("amoCRM 403");
    });
  });

  describe("getLeadsByIds", () => {
    it("пачки ≤ 250 через filter[id][], with=contacts, Map по id", async () => {
      const fetchMock = jest.fn().mockImplementation(async (url: string) => {
        const u = new URL(url);
        const ids = u.searchParams.getAll("filter[id][]").map(Number);
        return ok({
          _embedded: {
            leads: ids.map((id) => ({
              id,
              pipeline_id: AMO_PIPELINES.KC,
              status_id: 1,
              responsible_user_id: 9,
              updated_at: id,
              created_at: 1,
              _embedded: { contacts: [{ id: 77 }] },
            })),
          },
        });
      });
      global.fetch = fetchMock;
      const adapter = new AmoCrmAdapter();
      const ids = Array.from({ length: 300 }, (_, i) => 1 + i);
      const result = await adapter.getLeadsByIds(ids, { strict: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const first = calledUrls(fetchMock)[0];
      expect(first.pathname).toBe("/api/v4/leads");
      expect(first.searchParams.getAll("filter[id][]")).toHaveLength(250);
      expect(first.searchParams.get("with")).toBe("contacts");
      expect(first.searchParams.get("limit")).toBe("250");
      expect(result.size).toBe(300);
      expect(result.get(300)?._embedded?.contacts?.[0]?.id).toBe(77);
    });

    it("strict: неполный ответ → throw; non-strict: пропускает и дедуплицирует id", async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(ok({ _embedded: { leads: [{ id: 1, pipeline_id: 1 }] } }));
      const adapter = new AmoCrmAdapter();
      await expect(adapter.getLeadsByIds([1, 2], { strict: true })).rejects.toThrow(
        "AMO_TOUCHES_LEADS_INCOMPLETE",
      );
      const loose = await adapter.getLeadsByIds([1, 1, 2, 0]);
      expect(Array.from(loose.keys())).toEqual([1]);
    });
  });

  describe("getUsers", () => {
    it("пагинирует и типизирует rights.is_active → is_active", async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(
          ok({
            _embedded: {
              users: [
                { id: 1, name: "Юлия", email: "y@x", rights: { is_active: true } },
                { id: 2, name: "Админ", email: "a@x", rights: { is_active: false } },
              ],
            },
            _links: { next: { href: "x" } },
          }),
        )
        .mockResolvedValueOnce(
          ok({ _embedded: { users: [{ id: 3, name: "КЦ", is_active: true }] } }),
        );
      global.fetch = fetchMock;
      const adapter = new AmoCrmAdapter();
      const users = await adapter.getUsers();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(calledUrls(fetchMock)[0].searchParams.get("limit")).toBe("250");
      expect(users.map((u) => [u.id, u.name, u.is_active])).toEqual([
        [1, "Юлия", true],
        [2, "Админ", false],
        [3, "КЦ", true],
      ]);
      expect(users[0].email).toBe("y@x");
      expect(users[0].rights?.is_active).toBe(true);
    });
  });

  describe("scanReadonly: updatedFrom для contacts", () => {
    it("больше не бросает AMO_READONLY_FILTER_INVALID и передаёт filter[updated_at][from]", async () => {
      const fetchMock = jest.fn().mockResolvedValue(ok({ _embedded: { contacts: [] } }));
      global.fetch = fetchMock;
      const adapter = new AmoCrmAdapter();
      const result = await adapter.scanReadonly("contacts", { updatedFrom: 1_700_000_000 });
      expect(result.items).toEqual([]);
      expect(calledUrls(fetchMock)[0].searchParams.get("filter[updated_at][from]")).toBe(
        "1700000000",
      );
      await expect(
        adapter.scanReadonly("contacts", { pipelineIds: [AMO_PIPELINES.KC] }),
      ).rejects.toThrow("AMO_READONLY_FILTER_INVALID");
    });
  });

  // 2026-09-28: точечные правки адаптера под ночной синк касаний.
  describe("findContactsByPhoneExact (фаза 3 синка)", () => {
    const withPhone = (id: number, phone: string) => ({
      id,
      name: `c${id}`,
      custom_fields_values: [{ field_id: 557903, values: [{ value: phone }] }],
    });

    it("возвращает всех точных кандидатов вместо AMBIGUOUS_EXACT_CONTACT, пагинирует strict", async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(
          ok({
            _embedded: {
              contacts: [withPhone(1, "+79250000001"), withPhone(2, "+7 (925) 000-00-19")],
            },
            _links: { next: { href: "x" } },
          }),
        )
        .mockResolvedValueOnce(
          ok({ _embedded: { contacts: [withPhone(3, "89250000001")] } }),
        );
      global.fetch = fetchMock;
      const adapter = new AmoCrmAdapter();
      const found = await adapter.findContactsByPhoneExact("+7 925 000-00-01");
      expect(found.map((c) => c.id)).toEqual([1, 3]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(calledUrls(fetchMock)[0].searchParams.get("query")).toBe("9250000001");
      expect(calledUrls(fetchMock)[1].searchParams.get("page")).toBe("2");
      expect(await adapter.findContactsByPhoneExact("123")).toEqual([]);
    });

    it("findContactByPhone strict по-прежнему бросает AMBIGUOUS_EXACT_CONTACT на 2 совпадениях", async () => {
      global.fetch = jest.fn().mockResolvedValue(
        ok({ _embedded: { contacts: [withPhone(1, "+79250000001"), withPhone(2, "+79250000001")] } }),
      );
      const adapter = new AmoCrmAdapter();
      await expect(
        adapter.findContactByPhone("+79250000001", { strict: true }),
      ).rejects.toThrow("AMBIGUOUS_EXACT_CONTACT");
    });
  });

  describe("getContactsByIds propagateErrors", () => {
    it("пробрасывает 403 вместо пустой Map, без strict-проверок полноты", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 403,
        ok: false,
        headers: new Headers(),
        json: async () => ({}),
      });
      const adapter = new AmoCrmAdapter();
      await expect(
        adapter.getContactsByIds([1, 2], { propagateErrors: true }),
      ).rejects.toThrow(/amoCRM 403/);
      // без флага — прежнее поведение: ошибка глотается, Map пустая
      const silent = await adapter.getContactsByIds([1, 2]);
      expect(silent.size).toBe(0);
    });

    it("неполный ответ (контакт удалён в amo) не считается ошибкой", async () => {
      global.fetch = jest.fn().mockResolvedValue(
        ok({ _embedded: { contacts: [{ id: 1, name: "a" }] } }),
      );
      const adapter = new AmoCrmAdapter();
      const found = await adapter.getContactsByIds([1, 2], { propagateErrors: true });
      expect([...found.keys()]).toEqual([1]);
    });
  });
});

describe("чистые функции касаний", () => {
  const callNote = (over: Partial<AmoCallNote> & { params?: AmoCallNote["params"] }): AmoNote =>
    ({
      id: 1,
      entity_id: 10,
      note_type: AMO_NOTE_TYPES.CALL_OUT,
      created_by: 5,
      created_at: 1_700_000_000,
      updated_at: 1_700_000_000,
      params: { duration: 42, call_status: 4, call_result: "договорились" },
      ...over,
    }) as AmoNote;

  it("pickLatestCallNote: берёт самый свежий звонок, игнорирует не-звонки", () => {
    const notes: AmoNote[] = [
      callNote({ id: 1, created_at: 100 }),
      {
        id: 2,
        entity_id: 10,
        note_type: AMO_NOTE_TYPES.COMMON,
        created_at: 999,
        updated_at: 999,
        params: { text: "заметка" },
      },
      callNote({
        id: 3,
        note_type: AMO_NOTE_TYPES.CALL_IN,
        created_at: 500,
        params: { duration: 0, call_status: 6, call_responsible: "12" },
      }),
      callNote({ id: 4, created_at: 500, params: { duration: 7 } }), // тот же момент, id больше
    ];
    const touch = pickLatestCallNote(notes);
    expect(touch).not.toBeNull();
    expect(touch).toMatchObject({
      noteId: 4,
      ref: "note:4",
      direction: "OUT",
      durationSec: 7,
      status: null,
      statusText: null,
      resultText: null,
      userId: 5, // created_by, т.к. call_responsible нет
      entityId: 10,
    });
    expect(touch!.at.getTime()).toBe(500 * 1000);

    const inbound = pickLatestCallNote([notes[2]]);
    expect(inbound).toMatchObject({
      direction: "IN",
      status: 6,
      statusText: AMO_CALL_STATUS_TEXT[6],
      userId: 12,
      durationSec: 0,
    });
    expect(pickLatestCallNote([notes[1]])).toBeNull();
    expect(pickLatestCallNote(null)).toBeNull();
    expect(isCallNote(notes[1])).toBe(false);
  });

  it("типы params: common.text / service_message.service+text / call.* сохраняются", () => {
    const service: AmoNote = {
      id: 9,
      entity_id: 1,
      note_type: AMO_NOTE_TYPES.SERVICE_MESSAGE,
      created_at: 1,
      updated_at: 1,
      params: { service: "Морикит", text: "распределён" },
    };
    expect(service.note_type === "service_message" && service.params.service).toBe("Морикит");
    const call = callNote({ params: { uniq: "u1", link: "https://rec", phone: "+7", source: "mango" } });
    expect(isCallNote(call) && call.params.link).toBe("https://rec");
    expect(AMO_CALL_STATUS_TEXT[4]).toBe("разговор состоялся");
    expect(Object.keys(AMO_CALL_STATUS_TEXT)).toHaveLength(7);
  });

  it("pickLatestCompletedTask: только выполненные, по updated_at, fallback complete_till", () => {
    const task = (over: Partial<AmoTask>): AmoTask => ({
      id: 1,
      entity_id: 3,
      entity_type: "leads",
      task_type_id: AMO_TASK_TYPES.CALL,
      is_completed: true,
      complete_till: 100,
      responsible_user_id: 8,
      result: { text: "ок" },
      created_at: 1,
      updated_at: 200,
      ...over,
    });
    const tasks = [
      task({ id: 1, is_completed: false, updated_at: 9_999 }),
      task({ id: 2, updated_at: 300, task_type_id: AMO_TASK_TYPES.MEETING, text: "Встреча" }),
      task({ id: 3, updated_at: 0, complete_till: 250, result: null }),
    ];
    const touch = pickLatestCompletedTask(tasks);
    expect(touch).toMatchObject({
      taskId: 2,
      ref: "task:2",
      taskTypeId: 2,
      userId: 8,
      resultText: "ок",
      text: "Встреча",
      entityId: 3,
    });
    expect(touch!.at.getTime()).toBe(300 * 1000);
    const fallback = pickLatestCompletedTask([tasks[2]]);
    expect(fallback!.at.getTime()).toBe(250 * 1000);
    expect(fallback!.resultText).toBeNull();
    expect(pickLatestCompletedTask([tasks[0]])).toBeNull();
    expect(pickLatestCompletedTask(undefined)).toBeNull();
  });

  it("pickLatestKcLead: только воронка КЦ, максимальный updated_at", () => {
    const leads = [
      { id: 1, pipeline_id: AMO_PIPELINES.KC, updated_at: 100 },
      { id: 2, pipeline_id: AMO_PIPELINES.ZORGE9, updated_at: 900 },
      { id: 3, pipeline_id: AMO_PIPELINES.KC, updated_at: 500 },
      { id: 4, pipeline_id: AMO_PIPELINES.KC, updated_at: 500 },
      { id: 5, pipeline_id: AMO_PIPELINES.KC },
    ];
    expect(pickLatestKcLead(leads)?.id).toBe(4);
    expect(pickLatestKcLead(leads, AMO_PIPELINES.ZORGE9)?.id).toBe(2);
    expect(pickLatestKcLead([leads[1]])).toBeNull();
    expect(pickLatestKcLead([])).toBeNull();
  });
});
