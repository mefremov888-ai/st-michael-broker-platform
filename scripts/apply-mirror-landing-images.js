#!/usr/bin/env node
/**
 * 2026-09-18 (владелец: «все картинки выведи на сервер, исключение — фото и
 * видео Материалов»): переносим картинки лендинга к себе.
 *
 * Зачем: проекты, акции и новости ссылались прямо на чужое хранилище
 * (storage.yandexcloud.net). Сайт stmichael.ru переехал на другое хранилище,
 * старые ссылки отдают 404 — на лендинге вместо картинок пустые рамки.
 * Теперь каждая картинка скачивается в /app/uploads/landing и в базе
 * остаётся наша ссылка вида /uploads/landing/<хэш>.jpg.
 *
 * Что берём: LandingProject (главное фото + галерея), LandingPromo, LandingNews.
 * Фото и видео раздела «Материалы» НЕ трогаем — они живут своей синхронизацией.
 *
 * Если исходник уже мёртв (404), пробуем взять свежую картинку с
 * stmichael.ru: для проекта — со страницы проекта, для новости — со страницы
 * новости (og:image).
 *
 * DRY_RUN=1 по умолчанию. Боевой режим: DRY_RUN=0 CONFIRM=1.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DRY_RUN = process.env.DRY_RUN !== "0";
const CONFIRMED = process.env.CONFIRM === "1" || process.env.CONFIRM === "true";
const WRITE = !DRY_RUN && CONFIRMED;

const UPLOADS_ROOT = process.env.UPLOADS_DIR || "/app/uploads";
const DIR = path.join(UPLOADS_ROOT, "landing");
const PUBLIC_PREFIX = "/uploads/landing";

const isOurs = (url) => typeof url === "string" && url.startsWith("/uploads/");
const isExternal = (url) => typeof url === "string" && /^https?:\/\//i.test(url);

const EXT_BY_TYPE = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/gif": ".gif",
};

const stat = { найдено: 0, ужеНаши: 0, скачано: 0, переснято: 0, мёртвых: 0, ошибок: 0 };
const dead = [];

async function download(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) return { error: `${res.status}` };
  const type = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!type.startsWith("image/")) return { error: `не картинка (${type || "без типа"})` };
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) return { error: "пустой файл" };
  const ext = EXT_BY_TYPE[type] || path.extname(new URL(url).pathname) || ".jpg";
  const name = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16) + ext;
  return { buf, name, localUrl: `${PUBLIC_PREFIX}/${name}` };
}

/** Свежая картинка со страницы stmichael.ru (og:image). */
async function freshFromPage(pageUrl) {
  try {
    const res = await fetch(pageUrl, { redirect: "follow" });
    if (!res.ok) return null;
    const html = await res.text();
    const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    if (og && og[1]) return og[1];
    const img = html.match(/<img[^>]+src=["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp))["']/i);
    return img ? img[1] : null;
  } catch {
    return null;
  }
}

/** Возвращает нашу ссылку либо null, если исходник недоступен. */
async function mirror(url, fallbackPage, label) {
  if (!url || isOurs(url)) { stat.ужеНаши++; return null; }
  if (!isExternal(url)) return null;
  stat.найдено++;
  let got = await download(url).catch((e) => ({ error: e?.message || String(e) }));
  if (got.error) {
    let fresh = null;
    if (fallbackPage) fresh = await freshFromPage(fallbackPage);
    if (fresh && fresh !== url) {
      const retry = await download(fresh).catch((e) => ({ error: e?.message || String(e) }));
      if (!retry.error) {
        stat.переснято++;
        got = retry;
      }
    }
  }
  if (got.error) {
    stat.мёртвых++;
    dead.push(`${label}: ${got.error} · ${url.slice(0, 110)}`);
    return null;
  }
  if (WRITE) {
    fs.mkdirSync(DIR, { recursive: true });
    const file = path.join(DIR, got.name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, got.buf);
  }
  stat.скачано++;
  return got.localUrl;
}

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    console.log(`=== Режим: ${WRITE ? "APPLY (скачиваем и переписываем ссылки)" : "DRY-RUN (только проверка)"} ===`);
    console.log(`Папка на сервере: ${DIR}\n`);

    // 1. Проекты
    const projects = await prisma.landingProject.findMany({
      select: { id: true, slug: true, name: true, imageUrl: true, gallery: true },
    });
    console.log(`Проектов: ${projects.length}`);
    for (const p of projects) {
      const page = p.slug ? `https://stmichael.ru/projects/${p.slug}/` : null;
      const patch = {};
      const main = await mirror(p.imageUrl, page, `проект «${p.name}»`);
      if (main) patch.imageUrl = main;
      if (Array.isArray(p.gallery)) {
        const next = [];
        let changed = false;
        for (const item of p.gallery) {
          const local = await mirror(item, page, `галерея «${p.name}»`);
          next.push(local || item);
          if (local) changed = true;
        }
        if (changed) patch.gallery = next;
      }
      if (WRITE && Object.keys(patch).length) {
        await prisma.landingProject.update({ where: { id: p.id }, data: patch });
      }
      console.log(`  ${p.name}: ${Object.keys(patch).length ? "перенесено" : "без изменений"}`);
    }

    // 2. Акции
    const promos = await prisma.landingPromo.findMany({
      select: { id: true, title: true, imageUrl: true },
    });
    console.log(`\nАкций: ${promos.length}`);
    for (const promo of promos) {
      const local = await mirror(promo.imageUrl, null, `акция «${promo.title}»`);
      if (WRITE && local) {
        await prisma.landingPromo.update({ where: { id: promo.id }, data: { imageUrl: local } });
      }
    }

    // 3. Новости
    const news = await prisma.landingNews.findMany({
      select: { id: true, title: true, imageUrl: true, url: true },
    });
    console.log(`Новостей: ${news.length}`);
    for (const item of news) {
      const local = await mirror(item.imageUrl, item.url, `новость «${String(item.title).slice(0, 40)}»`);
      if (WRITE && local) {
        await prisma.landingNews.update({ where: { id: item.id }, data: { imageUrl: local } });
      }
    }

    console.log("\n=== Итог ===");
    for (const [k, v] of Object.entries(stat)) console.log(`  ${k.padEnd(12)} ${v}`);
    if (dead.length) {
      console.log(`\nНе удалось забрать (${dead.length}):`);
      for (const line of dead.slice(0, 25)) console.log(`  ${line}`);
      if (dead.length > 25) console.log(`  … и ещё ${dead.length - 25}`);
    }
    if (!WRITE) console.log("\nПРОГОН БЕЗ ЗАПИСИ: ничего не скачано и не переписано.");
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
