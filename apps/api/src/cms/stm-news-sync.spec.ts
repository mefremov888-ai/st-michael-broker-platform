import { CmsService } from "./cms.service";

/**
 * 2026-09-30 (решение владельца): новости с сайта stmichael.ru тоже
 * согласуются. Парсер создаёт новую карточку PENDING и зовёт
 * TelegramNewsService.requestModeration (то же «На согласование» с кнопками,
 * что у Telegram-постов); повторный парсинг статус существующих не сбрасывает.
 */

// Кусок stmichael.ru/news в том виде, в каком его снимает парсер (30.09.2026).
const card = (slug: string, date: string, title: string, img = "") =>
  `<a href="/news/${slug}" class="NewsCard_abc12"><div class="VImage_x">${
    img ? `<img src="${img}">` : ""
  }</div><div><div class="date_WVZRc">\n ${date}\n</div><div class="title_ElGSk">${title}</div></div></a>`;

const HTML =
  "<ul>" +
  card("novaya-shkola", "28 сентября 2026", "Новая школа на 1 000 мест появится рядом с «Зорге 9»", "https://stmichael.ru/proxy/w:960/q:80/a.jpg") +
  card("kluby-rezidentov", "27 сентября 2026", "Клубы резидентов в «Зорге 9»: расписание на октябрь") +
  "</ul>";

function createService(initial: any[] = []) {
  const rows = new Map<string, any>(initial.map((r) => [r.id, r]));
  const landingNews = {
    findFirst: jest.fn(async ({ where }: any) => [...rows.values()].find((r) => r.url === where.url) || null),
    create: jest.fn(async ({ data }: any) => {
      const row = { id: `id-${rows.size + 1}`, moderationStatus: "APPROVED", ...data };
      rows.set(row.id, row);
      return row;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = { ...rows.get(where.id), ...data };
      rows.set(where.id, row);
      return row;
    }),
  };
  const telegramNews = {
    requestModeration: jest.fn(async (_news: any, _photo?: string | null): Promise<void> => undefined),
    refreshModeration: jest.fn(async (_news: any): Promise<void> => undefined),
  };
  const service = new CmsService({ landingNews } as any, telegramNews as any);
  jest.spyOn(service as any, "fetchStmNewsHtml").mockResolvedValue(HTML);
  return { service, rows, landingNews, telegramNews };
}

describe("синк новостей с stmichael.ru: согласование", () => {
  it("новая карточка → PENDING и «На согласование» модераторам (с обложкой по ссылке сайта)", async () => {
    const { service, rows, telegramNews } = createService();
    await expect(service.syncNewsFromStm()).resolves.toEqual({ created: 2, updated: 0, total: 2 });
    const all = [...rows.values()];
    expect(all.map((r) => r.moderationStatus)).toEqual(["PENDING", "PENDING"]);
    expect(all[0]).toMatchObject({
      title: "Новая школа на 1 000 мест появится рядом с «Зорге 9»",
      source: "stmichael.ru",
      url: "https://stmichael.ru/news/novaya-shkola",
      imageUrl: "https://stmichael.ru/proxy/w:960/q:80/a.jpg",
      isActive: true,
    });
    expect(telegramNews.requestModeration).toHaveBeenCalledTimes(2);
    expect(telegramNews.requestModeration.mock.calls[0][0]).toMatchObject({ id: "id-1", moderationStatus: "PENDING" });
    expect(telegramNews.requestModeration.mock.calls[0][1]).toBe("https://stmichael.ru/proxy/w:960/q:80/a.jpg");
    expect(telegramNews.requestModeration.mock.calls[1][1]).toBeNull();
  });

  it("повторный парсинг: статус существующих не сбрасывается (APPROVED и REJECTED остаются), новых уведомлений нет", async () => {
    const { service, rows, landingNews, telegramNews } = createService([
      { id: "old-1", url: "https://stmichael.ru/news/novaya-shkola", title: "Новая школа на 1 000 мест появится рядом с «Зорге 9»", imageUrl: "https://stmichael.ru/proxy/w:960/q:80/a.jpg", moderationStatus: "APPROVED" },
      { id: "old-2", url: "https://stmichael.ru/news/kluby-rezidentov", title: "Старый заголовок", imageUrl: null, moderationStatus: "REJECTED" },
    ]);
    await expect(service.syncNewsFromStm()).resolves.toEqual({ created: 0, updated: 1, total: 2 });
    expect(landingNews.create).not.toHaveBeenCalled();
    expect(rows.get("old-1").moderationStatus).toBe("APPROVED");
    expect(rows.get("old-2")).toMatchObject({ moderationStatus: "REJECTED", title: "Клубы резидентов в «Зорге 9»: расписание на октябрь" });
    expect(landingNews.update.mock.calls[0][0].data).not.toHaveProperty("moderationStatus");
    expect(telegramNews.requestModeration).not.toHaveBeenCalled();
    expect(telegramNews.refreshModeration).not.toHaveBeenCalled();
  });

  it("карточка на согласовании изменилась на сайте → текст у модераторов обновляется, статус PENDING остаётся", async () => {
    const { service, rows, telegramNews } = createService([
      { id: "p-1", url: "https://stmichael.ru/news/novaya-shkola", title: "Черновик", imageUrl: null, moderationStatus: "PENDING" },
    ]);
    await service.syncNewsFromStm();
    expect(rows.get("p-1")).toMatchObject({ moderationStatus: "PENDING", title: "Новая школа на 1 000 мест появится рядом с «Зорге 9»" });
    expect(telegramNews.refreshModeration).toHaveBeenCalledWith(expect.objectContaining({ id: "p-1", moderationStatus: "PENDING" }));
  });

  it("ошибка Telegram или отсутствие TelegramNewsService синк не роняет — карточка всё равно PENDING", async () => {
    const { service, rows, telegramNews } = createService();
    telegramNews.requestModeration.mockRejectedValue(new Error("telegram down"));
    await expect(service.syncNewsFromStm()).resolves.toMatchObject({ created: 2 });
    expect([...rows.values()].every((r) => r.moderationStatus === "PENDING")).toBe(true);

    const bare = new CmsService({ landingNews: createService().landingNews } as any);
    jest.spyOn(bare as any, "fetchStmNewsHtml").mockResolvedValue(HTML);
    await expect(bare.syncNewsFromStm()).resolves.toMatchObject({ created: 2 });
  });
});
