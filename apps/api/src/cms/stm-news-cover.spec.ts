import {
  checkCoverFile,
  collectStmCoverCandidates,
  imageDimensions,
  isPlaceholderImageUrl,
  pickStmCoverUrl,
  proxyForOriginal,
  resolveStmCover,
} from "./stm-news-cover";

/**
 * 2026-09-30 (владелец: «у части новостей обложки — размытые заглушки»).
 * Фикстуры — сокращённая живая разметка stmichael.ru на 30.09.2026.
 */
const S3 = "https://s3.twcstorage.ru/78e9/media/p/p/img/653db9.jpg";
const P = (w: number, extra = "") => `https://stmichael.ru/proxy/insecure/w:${w}/${extra}q:80/plain/${S3}@webp`;
const BLUR40 = `https://stmichael.ru/proxy/insecure/w:400/h:0/q:60/bl:40/plain/${S3}@webp`;
const BLUR60 = `https://stmichael.ru/proxy/insecure/w:400/q:40/bl:60/plain/${S3}@webp`;
const GIF1PX = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const LOGO = "https://stmichael.ru/images/logo.jpg";

const lazyCard = `<div class="VImage_x"><img alt="image" src="${GIF1PX}" data-src="${BLUR40}" data-lazy-sizes="100vw" data-lazy-srcset="${P(744)} 744w, ${P(1023)} 1023w, ${P(640)} 640w, ${P(960)} 960w"></div>`;
const eagerCard = `<div class="VImage_x"><img src="${P(960)}" alt="image" sizes="100vw" srcset="${P(744)} 744w, ${P(1023)} 1023w, ${P(640)} 640w"></div>`;

const newsPage = (og: string, hero: string) => `<html><head>
<meta data-n-head="ssr" property="og:image:width" content="630">
<meta data-n-head="ssr" property="og:image" data-hid="og:image" content="${og}">
</head><body><div class="MediaHeroSlider_tkB+A"><div class="swiper-wrapper">${hero}</div></div>
<section><a href="/news/other" class="NewsCard_4ZUsU card_bOWoK"><img alt="image" src="${GIF1PX}" data-src="https://stmichael.ru/proxy/insecure/w:400/h:0/q:60/bl:40/plain/https://s3.twcstorage.ru/x/other.jpg@webp" data-lazy-srcset="https://stmichael.ru/proxy/insecure/w:1023/q:80/plain/https://s3.twcstorage.ru/x/other.jpg@webp 1023w"></a></section></body></html>`;

const heroLazy = `<div class="MediaSlide_2TToV media-slide"><img alt="Планировка" src="${GIF1PX}" data-src="${BLUR60}" data-lazy-src="${S3}" data-lazy-srcset="${P(744)} 744w, ${P(1023)} 1023w, ${P(640)} 640w"></div>`;
const heroEager = `<div class="MediaSlide_2TToV media-slide"><img alt="Планировка" src="${S3}" srcset="${P(744)} 744w, ${P(1023)} 1023w"></div>`;

describe("обложка новости stmichael.ru: кандидаты", () => {
  it("ленивая карточка: самый широкий кадр из data-lazy-srcset, заглушка bl:40 — последней", () => {
    const urls = collectStmCoverCandidates(lazyCard).map((c) => c.url);
    expect(urls[0]).toBe(P(1023));
    expect(urls.slice(0, 4)).toEqual([P(1023), P(960), P(744), P(640)]);
    expect(urls[urls.length - 1]).toBe(BLUR40);
    expect(urls).not.toContain(GIF1PX);
    expect(pickStmCoverUrl(lazyCard)).toBe(P(1023));
  });

  it("обычная карточка: сначала самый широкий из srcset, потом src", () => {
    const urls = collectStmCoverCandidates(eagerCard).map((c) => c.url);
    expect(urls).toEqual([P(1023), P(960), P(744), P(640)]);
  });

  it("страница новости: og:image-логотип отбрасывается, берётся слайдер, карточки «другие новости» не считаются", () => {
    const cands = collectStmCoverCandidates(newsPage(LOGO, heroLazy));
    const urls = cands.map((c) => c.url);
    expect(urls[0]).toBe(P(1023));
    expect(urls.some((u) => u.includes("other.jpg"))).toBe(false);
    // логотип — заглушка, в самом конце и помечен
    const logo = cands.find((c) => c.url === LOGO);
    expect(logo?.placeholder).toBe(true);
    expect(urls.indexOf(LOGO)).toBeGreaterThan(urls.indexOf(P(640)));
    // оригинал на s3 — сначала его прокси-копия w:960, сам оригинал позже
    expect(urls.indexOf(proxyForOriginal(S3))).toBeLessThan(urls.indexOf(S3));
    expect(urls.indexOf(S3)).toBeGreaterThan(-1);
  });

  it("страница новости с настоящим og:image — он первый", () => {
    const og = "https://stmichael.ru/proxy/insecure/w:1200/q:80/plain/https://s3.twcstorage.ru/x/cover.jpg@webp";
    const urls = collectStmCoverCandidates(newsPage(og, heroEager)).map((c) => c.url);
    expect(urls[0]).toBe(og);
    expect(urls[1]).toBe(P(1023));
  });

  it("<picture><source srcset> тоже учитывается", () => {
    const html = `<picture><source type="image/webp" srcset="${P(1200)} 1200w, ${P(600)} 600w"><img src="${P(960)}"></picture>`;
    expect(collectStmCoverCandidates(html).map((c) => c.url)).toEqual([P(1200), P(600), P(960)]);
  });

  it("узкие кандидаты (≤ 400) уходят после широких, но перед заглушками", () => {
    const html = `<img src="${P(320)}" srcset="${P(320)} 320w, ${P(400)} 400w" data-src="${BLUR40}">`;
    const cands = collectStmCoverCandidates(html);
    expect(cands.map((c) => c.url)).toEqual([P(400), P(320), BLUR40]);
    expect(cands.map((c) => c.placeholder)).toEqual([false, false, true]);
  });

  it("чужие хосты не берутся, пустая разметка — пусто", () => {
    expect(collectStmCoverCandidates(`<img src="https://example.com/a.jpg">`)).toEqual([]);
    expect(collectStmCoverCandidates("<div/>")).toEqual([]);
    expect(pickStmCoverUrl("<div/>")).toBeNull();
  });

  it("признаки заглушки по адресу", () => {
    expect(isPlaceholderImageUrl(GIF1PX)).toBe(true);
    expect(isPlaceholderImageUrl(BLUR40)).toBe(true);
    expect(isPlaceholderImageUrl(LOGO)).toBe(true);
    expect(isPlaceholderImageUrl("https://stmichael.ru/img/placeholder.png")).toBe(true);
    expect(isPlaceholderImageUrl("https://stmichael.ru/img/a-lqip.webp")).toBe(true);
    expect(isPlaceholderImageUrl("https://stmichael.ru/img/a_blur.jpg")).toBe(true);
    expect(isPlaceholderImageUrl("https://stmichael.ru/img/thumbs/a.jpg")).toBe(true);
    expect(isPlaceholderImageUrl(P(960))).toBe(false);
    expect(isPlaceholderImageUrl(S3)).toBe(false);
  });
});

// ── искусственные картинки с нужными размерами ──
export function fakePng(width: number, height: number, bytes: number): Buffer {
  const buf = Buffer.alloc(Math.max(bytes, 33), 0x11);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}
function fakeJpeg(width: number, height: number, bytes: number): Buffer {
  const buf = Buffer.alloc(Math.max(bytes, 40), 0x22);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  // APP0 сегмент 16 байт, потом SOF0
  buf[2] = 0xff;
  buf[3] = 0xe0;
  buf.writeUInt16BE(16, 4);
  const sof = 2 + 2 + 16;
  buf[sof] = 0xff;
  buf[sof + 1] = 0xc0;
  buf.writeUInt16BE(17, sof + 2);
  buf[sof + 4] = 8;
  buf.writeUInt16BE(height, sof + 5);
  buf.writeUInt16BE(width, sof + 7);
  return buf;
}
function fakeWebp(width: number, height: number, bytes: number): Buffer {
  const buf = Buffer.alloc(Math.max(bytes, 40), 0x33);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write("WEBP", 8, "latin1");
  buf.write("VP8X", 12, "latin1");
  buf.writeUInt32LE(10, 16);
  buf.writeUInt32LE(0, 20);
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
}
function fakeGif(width: number, height: number): Buffer {
  const buf = Buffer.alloc(20);
  buf.write("GIF89a", 0, "latin1");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

describe("обложка новости: проверка скачанного файла", () => {
  it("размеры читаются из заголовка png/jpeg/webp/gif", () => {
    expect(imageDimensions(fakePng(1200, 800, 100))).toEqual({ width: 1200, height: 800, format: "png" });
    expect(imageDimensions(fakeJpeg(960, 640, 100))).toEqual({ width: 960, height: 640, format: "jpg" });
    expect(imageDimensions(fakeWebp(400, 267, 100))).toEqual({ width: 400, height: 267, format: "webp" });
    expect(imageDimensions(fakeGif(1, 1))).toEqual({ width: 1, height: 1, format: "gif" });
    expect(imageDimensions(Buffer.from("<html>not an image</html>"))).toBeNull();
  });

  it("заглушка 400×267 на 1.5 КБ — отбрасывается (маленький файл)", () => {
    const res = checkCoverFile(fakeWebp(400, 267, 1510));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/КБ/);
    expect(res.width).toBe(400);
  });

  it("логотип 537×240 на 4 КБ — отбрасывается; широкий, но лёгкий файл (< 8 КБ) — тоже", () => {
    expect(checkCoverFile(fakePng(537, 240, 4320)).ok).toBe(false);
    expect(checkCoverFile(fakePng(1200, 800, 7000)).ok).toBe(false);
  });

  it("тяжёлый, но узкий (< 600) — отбрасывается с причиной «ширина»", () => {
    const res = checkCoverFile(fakeJpeg(500, 900, 50_000));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/ширина 500/);
  });

  it("настоящая обложка 960×640 на 100 КБ — проходит; не-картинка и пустой файл — нет", () => {
    expect(checkCoverFile(fakeWebp(960, 640, 100_440))).toMatchObject({ ok: true, width: 960, height: 640, format: "webp" });
    expect(checkCoverFile(Buffer.from("<html/>"))).toMatchObject({ ok: false, reason: "не картинка" });
    expect(checkCoverFile(Buffer.alloc(0))).toMatchObject({ ok: false, reason: "пустой файл" });
  });

  it("оригинал на 16 МБ — слишком большой", () => {
    expect(checkCoverFile(fakeJpeg(6943, 4629, 7 * 1024 * 1024)).ok).toBe(false);
  });
});

describe("обложка новости: перебор кандидатов со скачиванием", () => {
  const good = fakeWebp(960, 640, 100_000);
  const tiny = fakeWebp(400, 267, 1500);

  it("маленький файл → пробуем следующего; заглушки по адресу не качаем", async () => {
    const cands = collectStmCoverCandidates(lazyCard);
    const files: Record<string, Buffer> = { [P(1023)]: tiny, [P(960)]: good };
    const downloaded: string[] = [];
    const download = async (url: string) => {
      downloaded.push(url);
      if (!files[url]) throw new Error("HTTP 404");
      return files[url];
    };
    const res = await resolveStmCover(cands, download);
    expect(res?.url).toBe(P(960));
    expect(res?.ext).toBe(".webp");
    expect(res?.check.width).toBe(960);
    expect(res?.tried).toEqual([{ url: P(1023), reason: expect.stringMatching(/КБ/) }]);
    expect(downloaded).toEqual([P(1023), P(960)]);
    expect(downloaded).not.toContain(BLUR40);
  });

  it("ошибка скачивания → следующий; ничего не подошло → null со списком причин", async () => {
    const cands = collectStmCoverCandidates(eagerCard);
    const res = await resolveStmCover(cands, async () => {
      throw new Error("timeout");
    });
    expect(res).toBeNull();
    const res2 = await resolveStmCover(cands, async (url) => (url === P(744) ? good : tiny));
    expect(res2?.url).toBe(P(744));
    expect(res2?.tried.map((t) => t.url)).toEqual([P(1023), P(960)]);
  });

  it("только заглушки → ничего не качаем, null", async () => {
    const download = jest.fn(async () => good);
    const res = await resolveStmCover(collectStmCoverCandidates(`<img data-src="${BLUR40}">`), download);
    expect(res).toBeNull();
    expect(download).not.toHaveBeenCalled();
  });
});
