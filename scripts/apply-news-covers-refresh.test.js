const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { run, collectCandidates, checkCoverFile, assessCurrent, localCoverPath, isPlaceholderImageUrl } = require("./apply-news-covers-refresh");

// ── фикстуры: сокращённая живая разметка stmichael.ru (30.09.2026) ──
const S3 = "https://s3.twcstorage.ru/78e9/media/p/p/img/653db9.jpg";
const P = (w) => `https://stmichael.ru/proxy/insecure/w:${w}/q:80/plain/${S3}@webp`;
const BLUR = `https://stmichael.ru/proxy/insecure/w:400/q:40/bl:60/plain/${S3}@webp`;
const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const LOGO = "https://stmichael.ru/images/logo.jpg";
const PAGE = `<html><head><meta property="og:image" content="${LOGO}"></head><body>
<div class="MediaHeroSlider_x"><div class="MediaSlide_y"><img alt="Планировка" src="${GIF}" data-src="${BLUR}" data-lazy-src="${S3}" data-lazy-srcset="${P(744)} 744w, ${P(1728)} 1728w, ${P(1023)} 1023w"></div></div>
<a href="/news/other" class="NewsCard_z"><img src="${GIF}" data-lazy-srcset="https://stmichael.ru/proxy/insecure/w:1023/q:80/plain/https://s3.twcstorage.ru/x/other.jpg@webp 1023w"></a></body></html>`;

function webp(width, bytes) {
  const buf = Buffer.alloc(bytes, 0x33);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write("WEBP", 8, "latin1");
  buf.write("VP8X", 12, "latin1");
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(639, 27, 3);
  return buf;
}
const TINY = webp(400, 1500); // заглушка сайта 400×640, 1.5 КБ
const GOOD = webp(1728, 120_000);

test("кандидаты: логотип og:image и заглушка bl:60 — в конце, карточки «другие новости» не считаются, data: не берётся", () => {
  const c = collectCandidates(PAGE);
  const urls = c.map((x) => x.url);
  assert.equal(urls[0], P(1728));
  assert.equal(urls[1], P(1023));
  assert.ok(!urls.some((u) => u.includes("other.jpg")));
  assert.ok(!urls.includes(GIF));
  assert.ok(c.find((x) => x.url === LOGO).placeholder);
  assert.ok(c.find((x) => x.url === BLUR).placeholder);
  assert.ok(urls.indexOf(LOGO) > urls.indexOf(S3));
  assert.equal(isPlaceholderImageUrl(P(960)), false);
});

test("проверка файла: заглушка 1.5 КБ и логотип 537 px — не проходят, 1728 px на 120 КБ — проходит", () => {
  assert.equal(checkCoverFile(TINY).ok, false);
  assert.match(checkCoverFile(TINY).reason, /КБ/);
  assert.equal(checkCoverFile(webp(537, 20_000)).ok, false);
  assert.match(checkCoverFile(webp(537, 20_000)).reason, /ширина 537/);
  assert.equal(checkCoverFile(GOOD).ok, true);
  assert.equal(checkCoverFile(Buffer.from("<html/>")).ok, false);
});

test("оценка текущей обложки: наш файл читается с диска; старый префикс /uploads/landing тоже понимается", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "covers-"));
  fs.mkdirSync(path.join(root, "landing"));
  fs.writeFileSync(path.join(root, "landing", "tiny.webp"), TINY);
  fs.writeFileSync(path.join(root, "landing", "good.webp"), GOOD);
  assert.equal(localCoverPath("/uploads/landing/x.webp", root), path.join(root, "landing", "x.webp"));
  assert.equal(localCoverPath("https://stmichael.ru/a.jpg", root), null);
  assert.equal(assessCurrent({ imageUrl: "/files/landing/tiny.webp" }, root).ok, false);
  assert.equal(assessCurrent({ imageUrl: "/files/landing/good.webp" }, root).ok, true);
  assert.equal(assessCurrent({ imageUrl: "/files/landing/missing.webp" }, root).label, "файла нет на диске");
  assert.equal(assessCurrent({ imageUrl: null }, root).kind, "none");
  assert.equal(assessCurrent({ imageUrl: "https://stmichael.ru/proxy/insecure/w:400/bl:40/a@webp" }, root).label, "внешняя ссылка-заглушка");
  fs.rmSync(root, { recursive: true, force: true });
});

/** Фальшивый prisma: findMany/update в памяти, $transaction с откатом по исключению. */
function fakePrisma(initial) {
  let rows = initial.map((r) => ({ ...r }));
  const model = (get, set) => ({
    findMany: async ({ where } = {}) => {
      const ids = where && where.id && where.id.in;
      return get().filter((r) => !ids || ids.includes(r.id));
    },
    update: async ({ where, data }) => {
      set(get().map((r) => (r.id === where.id ? { ...r, ...data } : r)));
      return get().find((r) => r.id === where.id);
    },
  });
  const prisma = {
    landingNews: model(() => rows, (n) => (rows = n)),
    $transaction: async (fn) => {
      let staged = rows.map((r) => ({ ...r }));
      await fn({ landingNews: model(() => staged, (n) => (staged = n)) });
      rows = staged;
    },
    rows: () => rows,
  };
  return prisma;
}

function scenario() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "covers-run-"));
  fs.mkdirSync(path.join(root, "landing"));
  fs.writeFileSync(path.join(root, "landing", "tiny.webp"), TINY);
  fs.writeFileSync(path.join(root, "landing", "good.webp"), GOOD);
  const rows = [
    { id: "n1", title: "Динамика строительства в июне", url: "https://stmichael.ru/news/june", source: "stmichael.ru", imageUrl: "/files/landing/tiny.webp", publishedAt: new Date("2026-06-30") },
    { id: "n2", title: "Свежая новость", url: "https://stmichael.ru/news/fresh", source: "stmichael.ru", imageUrl: "/files/landing/good.webp", publishedAt: new Date("2026-09-28") },
    { id: "n3", title: "Семейная ипотека", url: "https://stmichael.ru/news/mortgage", source: "stmichael.ru", imageUrl: "https://stmichael.ru/proxy/insecure/w:400/h:0/q:60/bl:40/plain/x@webp", publishedAt: new Date("2026-07-01") },
    { id: "n4", title: "Страница умерла", url: "https://stmichael.ru/news/dead", source: "stmichael.ru", imageUrl: null, publishedAt: new Date("2026-05-01") },
  ];
  const downloads = [];
  const download = async (url) => {
    downloads.push(url);
    if (url === P(1728)) return TINY; // самый широкий вдруг оказался заглушкой → следующий
    if (url === P(1023)) return GOOD;
    throw new Error("HTTP 404");
  };
  const fetchPage = async (url) => {
    if (url.endsWith("/dead")) throw new Error("HTTP 404");
    return Buffer.from(PAGE);
  };
  const logs = [];
  return { root, prisma: fakePrisma(rows), download, fetchPage, downloads, logs, log: (l) => logs.push(String(l)) };
}

test("dry-run: заглушки находятся, файлы качаются во временную папку, транзакция откатывается, таблица печатается", async () => {
  const s = scenario();
  const res = await run(s.prisma, { write: false, uploadsRoot: s.root, download: s.download, fetchPage: s.fetchPage, log: s.log });
  assert.equal(res.total, 4);
  assert.equal(res.skipped, 1); // good.webp не трогаем
  assert.equal(res.planned, 2); // n1 и n3
  assert.equal(res.failed, 1); // n4: страница не открылась
  assert.equal(res.updated, 2); // внутри транзакции — и откачено
  assert.equal(s.prisma.rows().find((r) => r.id === "n1").imageUrl, "/files/landing/tiny.webp");
  assert.equal(s.prisma.rows().find((r) => r.id === "n3").imageUrl.startsWith("https://"), true);
  assert.deepEqual(fs.readdirSync(path.join(s.root, "landing")).sort(), ["good.webp", "tiny.webp"]);
  // заглушку по адресу не качали, самый широкий отвергли как маленький
  assert.ok(!s.downloads.includes(BLUR) && !s.downloads.includes(LOGO));
  assert.deepEqual(s.downloads.slice(0, 2), [P(1728), P(1023)]);
  const out = s.logs.join("\n");
  assert.match(out, /ЗАМЕНА\s+«Динамика строительства в июне»/);
  assert.match(out, /было:\s+1 КБ · 400×640/);
  assert.match(out, /стало: 117 КБ · 1728×640 · srcset\s+\/files\/landing\/[0-9a-f]{16}\.webp/);
  assert.match(out, /НЕ УДАЛОСЬ «Страница умерла»: страница: HTTP 404/);
  assert.match(out, /ПРОГОН БЕЗ ЗАПИСИ/);
  fs.rmSync(s.root, { recursive: true, force: true });
});

test("apply: файлы ложатся в uploads/landing под хэш-именем, ссылки в базе обновлены, хорошая строка не тронута", async () => {
  const s = scenario();
  const res = await run(s.prisma, { write: true, uploadsRoot: s.root, download: s.download, fetchPage: s.fetchPage, log: s.log });
  assert.equal(res.updated, 2);
  const n1 = s.prisma.rows().find((r) => r.id === "n1");
  const n3 = s.prisma.rows().find((r) => r.id === "n3");
  assert.match(n1.imageUrl, /^\/files\/landing\/[0-9a-f]{16}\.webp$/);
  assert.equal(n1.imageUrl, n3.imageUrl); // одинаковая картинка → один файл
  assert.ok(fs.existsSync(path.join(s.root, "landing", path.basename(n1.imageUrl))));
  assert.equal(checkCoverFile(fs.readFileSync(path.join(s.root, "landing", path.basename(n1.imageUrl)))).ok, true);
  assert.equal(s.prisma.rows().find((r) => r.id === "n2").imageUrl, "/files/landing/good.webp");
  assert.equal(s.prisma.rows().find((r) => r.id === "n4").imageUrl, null);
  assert.match(s.logs.join("\n"), /ЗАПИСЬ ВЫПОЛНЕНА: обновлено 2/);
  fs.rmSync(s.root, { recursive: true, force: true });
});
