#!/usr/bin/env node
/**
 * 2026-09-30 (владелец: «у части новостей обложки — размытые заглушки»):
 * пересобираем обложки новостей сайта stmichael.ru в landing_news.
 *
 * Причина: до 14.09 парсер брал у ленивых карточек `data-src` — намеренно
 * размытую заглушку сайта (w:400 … bl:40, ~1 КБ). 18.09 «зеркалирование»
 * скачало эти заглушки к нам как /files/landing/<hash>.webp (400×267), а где
 * исходник умер — взяло og:image со страницы новости, а это у сайта всегда
 * логотип (537×240, 4 КБ). Новости, ушедшие с первой страницы /news,
 * ежедневный синк больше не трогает — заглушки остались.
 *
 * Что делает скрипт:
 *   1. берёт все новости с источником stmichael.ru;
 *   2. проверяет НАСТОЯЩИЙ файл обложки в /app/uploads/landing: нет файла,
 *      < 8 КБ или ширина < 600 → обложку надо переснять; внешняя ссылка
 *      (файла у нас нет) — тоже переснимаем и кладём к себе;
 *   3. открывает страницу новости (url), собирает кандидатов по той же
 *      логике, что и синк (og:image → самый широкий srcset → src; заглушки
 *      bl:NN/placeholder/логотип — отбрасываются), качает по очереди и
 *      проверяет (≥ 8 КБ, ширина ≥ 600, ≤ 6 МБ);
 *   4. печатает таблицу «заголовок → было → стало» и пишет ссылки
 *      /files/landing/<hash>.<ext> в транзакции.
 *
 * DRY_RUN=1 по умолчанию: всё выполняется, включая скачивание (во временную
 * папку), запись идёт в транзакции и откатывается. Боевой режим:
 * DRY_RUN=0 CONFIRM=1 — файлы кладутся в /app/uploads/landing, ссылки в БД.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const crypto = require("node:crypto");

const DRY_RUN = process.env.DRY_RUN !== "0";
const CONFIRMED = process.env.CONFIRM === "1" || process.env.CONFIRM === "true";
const WRITE = !DRY_RUN && CONFIRMED;

const UPLOADS_ROOT = process.env.UPLOADS_DIR || "/app/uploads";
const LANDING_DIR = "landing";
const PUBLIC_PREFIX = "/files/landing";

const MIN_COVER_BYTES = 8 * 1024;
const MIN_COVER_WIDTH = 600;
const SMALL_WIDTH = 400;
const MAX_COVER_BYTES = 6 * 1024 * 1024;
const MAX_TRIES = 6;

const STM_PROXY = "https://stmichael.ru/proxy/";
const ALLOWED_HOSTS = ["stmichael.ru", "s3.twcstorage.ru", "storage.yandexcloud.net"];
// Обход просроченного ECDSA-сертификата stmichael.ru: просим RSA-цепочку (как в cms.service).
const STM_RSA_SIGALGS =
  "rsa_pss_rsae_sha256:rsa_pkcs1_sha256:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512";

class Rollback extends Error {
  constructor() {
    super("dry-run rollback");
    this.name = "Rollback";
  }
}

// ─── выбор кандидатов (копия apps/api/src/cms/stm-news-cover.ts) ───

function isPlaceholderImageUrl(url) {
  if (!url) return true;
  if (/^data:/i.test(url)) return true;
  if (/\/bl:\d+\//.test(url)) return true;
  if (/placeholder|lqip|blur|thumb/i.test(url)) return true;
  if (/logo\.(?:jpe?g|png|webp|svg)(?:[?#]|$)/i.test(url)) return true;
  return false;
}
function widthFromUrl(url) {
  const m = String(url).match(/\/w:(\d+)\//);
  return m ? Number(m[1]) : null;
}
function allowedHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}
function isRawOriginal(url) {
  return /^https:\/\/(?:s3\.twcstorage\.ru|storage\.yandexcloud\.net)\//i.test(url) && !url.startsWith(STM_PROXY);
}
function proxyForOriginal(original, width = 960) {
  return `${STM_PROXY}insecure/w:${width}/q:80/plain/${original}@webp`;
}
function decodeAttr(v) {
  return String(v).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}
function parseSrcset(value) {
  return value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [url, descriptor] = p.split(/\s+/);
      const w = descriptor && /^\d+w$/.test(descriptor) ? Number(descriptor.slice(0, -1)) : null;
      return { url: decodeAttr(url || ""), width: w ?? widthFromUrl(url || "") };
    })
    .filter((c) => c.url);
}
function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1].toLowerCase()] = decodeAttr(m[2] ?? m[3] ?? "");
  }
  return out;
}

/** Кандидаты обложки из HTML страницы/карточки: хорошие → узкие (≤ 400) → заглушки. */
function collectCandidates(html) {
  const scope = String(html).split(/class="NewsCard_/)[0] || "";
  const seen = new Set();
  const good = [];
  const small = [];
  const placeholders = [];
  const push = (url, width, origin) => {
    if (!url || seen.has(url)) return;
    if (/^data:/i.test(url)) return;
    const placeholder = isPlaceholderImageUrl(url);
    if (!placeholder && !allowedHost(url)) return;
    seen.add(url);
    const c = { url, width: width ?? widthFromUrl(url), origin, placeholder };
    if (placeholder) placeholders.push(c);
    else if (c.width !== null && c.width <= SMALL_WIDTH) small.push(c);
    else good.push(c);
  };
  for (const m of String(html).matchAll(/<meta\s[^>]*property=["']og:image["'][^>]*>/gi)) {
    const a = attrs(m[0]);
    if (a.content) push(a.content, null, "og");
  }
  for (const m of scope.matchAll(/<(?:img|source)\s[^>]*>/gi)) {
    const a = attrs(m[0]);
    const entries = [];
    const sets = [a["data-lazy-srcset"], a["srcset"], a["data-srcset"]].filter(Boolean);
    for (const c of sets.flatMap(parseSrcset)) entries.push({ ...c, origin: "srcset" });
    for (const [url, origin] of [
      [a["data-lazy-src"], "lazy-src"],
      [a["src"], "src"],
      [a["data-src"], "data-src"],
    ]) {
      if (!url) continue;
      if (isRawOriginal(url)) entries.push({ url: proxyForOriginal(url), width: 960, origin: "proxy-of-original" });
      entries.push({ url, width: widthFromUrl(url), origin });
    }
    const known = entries.filter((e) => e.width !== null).sort((x, y) => y.width - x.width);
    const unknown = entries.filter((e) => e.width === null);
    for (const e of [...known, ...unknown]) push(e.url, e.width, e.origin);
  }
  return [...good, ...small, ...placeholders];
}

// ─── проверка файла ───

function imageDimensions(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.slice(1, 4).toString("latin1") === "PNG" && buf.length >= 24) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: "png" };
  }
  if (buf.slice(0, 3).toString("latin1") === "GIF" && buf.length >= 10) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: "gif" };
  }
  if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") {
    const chunk = buf.slice(12, 16).toString("latin1");
    if (chunk === "VP8X" && buf.length >= 30) return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), format: "webp" };
    if (chunk === "VP8L" && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff), format: "webp" };
    }
    if (chunk === "VP8 " && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, format: "webp" };
    return null;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), format: "jpg" };
      }
      if (marker === 0xd9 || marker === 0xda) break;
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
    return null;
  }
  return null;
}

function checkCoverFile(buf) {
  const bytes = buf ? buf.length : 0;
  if (!bytes) return { ok: false, reason: "пустой файл", bytes: 0, width: null, height: null, format: null };
  const info = imageDimensions(buf);
  if (!info) return { ok: false, reason: "не картинка", bytes, width: null, height: null, format: null };
  const base = { bytes, width: info.width, height: info.height, format: info.format };
  if (bytes < MIN_COVER_BYTES) return { ok: false, reason: `файл ${Math.round(bytes / 1024)} КБ < ${MIN_COVER_BYTES / 1024} КБ`, ...base };
  if (info.width < MIN_COVER_WIDTH) return { ok: false, reason: `ширина ${info.width} < ${MIN_COVER_WIDTH}`, ...base };
  if (bytes > MAX_COVER_BYTES) return { ok: false, reason: `файл ${Math.round(bytes / 1024 / 1024)} МБ — слишком большой`, ...base };
  return { ok: true, reason: null, ...base };
}
const extensionFor = (format) => (format === "png" ? ".png" : format === "webp" ? ".webp" : format === "gif" ? ".gif" : ".jpg");
const fileNameFor = (buf, ext) => crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16) + ext;

/** Локальный путь файла по ссылке /files/landing/… (или старой /uploads/landing/…). */
function localCoverPath(imageUrl, uploadsRoot = UPLOADS_ROOT) {
  const m = String(imageUrl || "").match(/^\/(?:files|uploads)\/landing\/([^/?#]+)$/);
  return m ? path.join(uploadsRoot, LANDING_DIR, m[1]) : null;
}

// ─── сеть ───

function requestOnce(url, extra = {}, hops = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; STMBrokerBot/1.0)" }, timeout: 20000, ...extra },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 2) {
          res.resume();
          resolve(requestOnce(new URL(res.headers.location, url).toString(), extra, hops + 1));
          return;
        }
        if (res.statusCode >= 400) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
  });
}
async function fetchStm(url) {
  try {
    return await requestOnce(url);
  } catch (e) {
    if (e && e.code === "CERT_HAS_EXPIRED") return requestOnce(url, { sigalgs: STM_RSA_SIGALGS });
    throw e;
  }
}

// ─── логика ───

/** Что сейчас лежит в обложке строки: наш файл (и хорош ли), внешняя ссылка или ничего. */
function assessCurrent(row, uploadsRoot) {
  const url = row.imageUrl || null;
  if (!url) return { kind: "none", ok: false, label: "нет обложки" };
  const file = localCoverPath(url, uploadsRoot);
  if (file) {
    let buf = null;
    try { buf = fs.readFileSync(file); } catch { /* нет файла */ }
    if (!buf) return { kind: "local", ok: false, file, label: "файла нет на диске" };
    const check = checkCoverFile(buf);
    const label = `${Math.round(check.bytes / 1024)} КБ · ${check.width ?? "?"}×${check.height ?? "?"}${check.ok ? "" : " · " + check.reason}`;
    return { kind: "local", ok: check.ok, file, check, label };
  }
  if (/^https?:\/\//i.test(url)) {
    return { kind: "remote", ok: false, label: isPlaceholderImageUrl(url) ? "внешняя ссылка-заглушка" : "внешняя ссылка (файла у нас нет)" };
  }
  return { kind: "other", ok: false, label: `непонятная ссылка ${url.slice(0, 40)}` };
}

/** Качаем кандидатов по очереди, первый прошедший проверку — ответ. */
async function resolveCover(candidates, download) {
  const tried = [];
  let attempts = 0;
  for (const c of candidates) {
    if (c.placeholder) { tried.push({ url: c.url, reason: "заглушка по адресу" }); continue; }
    if (attempts >= MAX_TRIES) break;
    attempts++;
    let buf;
    try {
      buf = await download(c.url);
    } catch (e) {
      tried.push({ url: c.url, reason: `не скачалось: ${e && e.message ? e.message : e}` });
      continue;
    }
    const check = checkCoverFile(buf);
    if (!check.ok) { tried.push({ url: c.url, reason: check.reason }); continue; }
    return { url: c.url, buf, ext: extensionFor(check.format), check, origin: c.origin, tried };
  }
  return { failed: true, tried };
}

const cut = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

/**
 * Основная логика на переданном prisma. В dry-run файлы качаются в temp-папку,
 * запись идёт в транзакции и откатывается.
 */
async function run(prisma, { write = WRITE, uploadsRoot = UPLOADS_ROOT, download = fetchStm, fetchPage = fetchStm, log = console.log } = {}) {
  log(`=== Обложки новостей сайта: пересъёмка заглушек (30.09.2026) ===`);
  log(`режим: ${write ? "APPLY (файлы в uploads, запись в БД)" : "DRY-RUN (скачивание во временную папку, транзакция с откатом)"}`);
  log(`папка обложек: ${path.join(uploadsRoot, LANDING_DIR)}`);

  const rows = await prisma.landingNews.findMany({
    where: { OR: [{ source: "stmichael.ru" }, { url: { startsWith: "https://stmichael.ru/" } }] },
    orderBy: [{ publishedAt: "desc" }],
  });
  log(`\n--- Новостей сайта в базе: ${rows.length}`);

  const targetDir = write ? path.join(uploadsRoot, LANDING_DIR) : fs.mkdtempSync(path.join(os.tmpdir(), "news-covers-"));
  fs.mkdirSync(targetDir, { recursive: true });

  const plan = []; // { row, before, after, imageUrl }
  const skipped = [];
  const failed = [];
  for (const row of rows) {
    const before = assessCurrent(row, uploadsRoot);
    if (before.ok) { skipped.push({ row, before }); continue; }
    let candidates = [];
    let pageError = null;
    try {
      const html = (await fetchPage(row.url)).toString("utf-8");
      candidates = collectCandidates(html);
    } catch (e) {
      pageError = e && e.message ? e.message : String(e);
    }
    // страница не открылась / пустая — пробуем хотя бы текущую внешнюю ссылку
    if (!candidates.length && before.kind === "remote") {
      candidates = [{ url: row.imageUrl, width: widthFromUrl(row.imageUrl), origin: "db", placeholder: isPlaceholderImageUrl(row.imageUrl) }];
    }
    const resolved = candidates.length ? await resolveCover(candidates, download) : { failed: true, tried: [] };
    if (resolved.failed) {
      failed.push({ row, before, reason: pageError ? `страница: ${pageError}` : candidates.length ? `ни один из ${candidates.length} кандидатов не подошёл` : "кандидатов нет", tried: resolved.tried });
      continue;
    }
    const name = fileNameFor(resolved.buf, resolved.ext);
    const file = path.join(targetDir, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, resolved.buf);
    plan.push({
      row,
      before,
      after: `${Math.round(resolved.check.bytes / 1024)} КБ · ${resolved.check.width}×${resolved.check.height} · ${resolved.origin}`,
      imageUrl: `${PUBLIC_PREFIX}/${name}`,
      sourceUrl: resolved.url,
      rejected: resolved.tried.length,
    });
  }

  log(`\n--- Таблица: заголовок → было → стало`);
  for (const p of plan) {
    const same = p.imageUrl === p.row.imageUrl;
    log(`  ${same ? "ТОТ ЖЕ " : "ЗАМЕНА "} «${cut(p.row.title, 60)}»`);
    log(`           было:  ${p.before.label}${p.row.imageUrl ? "  " + cut(p.row.imageUrl, 90) : ""}`);
    log(`           стало: ${p.after}  ${p.imageUrl}${p.rejected ? `  (отвергнуто кандидатов: ${p.rejected})` : ""}`);
  }
  for (const f of failed) {
    log(`  НЕ УДАЛОСЬ «${cut(f.row.title, 60)}»: ${f.reason}`);
    log(`           было:  ${f.before.label}`);
    for (const t of f.tried.slice(0, 4)) log(`           - ${t.reason}: ${cut(t.url, 100)}`);
  }
  log(`\n  хороших (не трогаем): ${skipped.length} · к замене: ${plan.length} · не удалось: ${failed.length}`);

  const updates = plan.filter((p) => p.imageUrl !== p.row.imageUrl);
  let written = 0;
  if (updates.length) {
    try {
      await prisma.$transaction(
        async (tx) => {
          for (const p of updates) {
            await tx.landingNews.update({ where: { id: p.row.id }, data: { imageUrl: p.imageUrl } });
            written++;
          }
          const after = await tx.landingNews.findMany({ where: { id: { in: updates.map((p) => p.row.id) } } });
          for (const p of updates) {
            const r = after.find((x) => x.id === p.row.id);
            if (!r || r.imageUrl !== p.imageUrl) throw new Error(`после записи у ${p.row.id} не та ссылка`);
          }
          if (!write) throw new Rollback();
        },
        { timeout: 60000 },
      );
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
  }

  if (write) {
    log(`\nЗАПИСЬ ВЫПОЛНЕНА: обновлено ${written} строк, файлы в ${targetDir}.`);
  } else {
    log(`\nПРОГОН БЕЗ ЗАПИСИ: ${written} обновлений внутри транзакции откачены; файлы лежали во временной папке ${targetDir} и удалены.`);
    try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch { /* не критично */ }
    log(`Для записи: DRY_RUN=0 CONFIRM=1.`);
  }
  return { ok: true, total: rows.length, skipped: skipped.length, planned: plan.length, updated: written, failed: failed.length, plan, failedRows: failed };
}

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    await run(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = {
  run,
  collectCandidates,
  isPlaceholderImageUrl,
  imageDimensions,
  checkCoverFile,
  localCoverPath,
  assessCurrent,
  resolveCover,
  fetchStm,
  MIN_COVER_BYTES,
  MIN_COVER_WIDTH,
};

if (require.main === module) {
  main().catch((e) => {
    console.error("FATAL:", e && e.message ? e.message : e);
    process.exit(1);
  });
}
