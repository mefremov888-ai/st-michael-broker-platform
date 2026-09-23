#!/usr/bin/env node
/**
 * 2026-09-23: насколько свежие цены в выборщике квартир. Сравниваем базу
 * кабинета (Lot) с фидами Profitbase, из которых цены синхронизируются
 * по крону раз в два часа. Только чтение.
 */
const { XMLParser } = require("fast-xml-parser");
const fs = require("node:fs");
const path = require("node:path");

// Адреса фидов в этот файл не кладём: берём их из уже развёрнутого кода
// каталога (там они и живут), либо из переменных окружения контейнера.
function findFeeds() {
  const env = [
    process.env.PROFITBASE_FEED_ZORGE && { project: "ZORGE9", url: process.env.PROFITBASE_FEED_ZORGE },
    process.env.PROFITBASE_FEED_SILVER && { project: "SILVER_BOR", url: process.env.PROFITBASE_FEED_SILVER },
  ].filter(Boolean);
  if (env.length === 2) return env;
  const roots = ["/app/apps/api/dist", "/app/dist", path.join(__dirname, "..", "apps", "api", "dist")];
  for (const root of roots) {
    let file = null;
    const walk = (dir) => {
      if (file || !fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (name === "catalog.service.js") { file = p; return; }
      }
    };
    walk(root);
    if (!file) continue;
    const src = fs.readFileSync(file, "utf8");
    const urls = [...new Set(src.match(/https:\/\/[a-z0-9.]+profitbase\.ru\/export\/profitbase_xml\/[a-f0-9]+\?scheme=https/g) || [])];
    if (urls.length >= 2) return [{ project: "ZORGE9", url: urls[0] }, { project: "SILVER_BOR", url: urls[1] }];
  }
  return [];
}
const FEEDS = findFeeds();
const fmt = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace("T", " ") : "—");

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const lots = await prisma.lot.findMany({ select: { externalId: true, price: true, updatedAt: true, project: true, status: true } });
    const byExt = new Map(lots.map((l) => [String(l.externalId), l]));
    const maxUpd = lots.reduce((m, l) => (l.updatedAt > m ? l.updatedAt : m), new Date(0));
    console.log(`Лотов в базе: ${lots.length}; последнее обновление любой карточки: ${fmt(maxUpd)} UTC (сейчас ${fmt(new Date())} UTC)`);
    const byProj = {};
    for (const l of lots) byProj[l.project] = (byProj[l.project] || 0) + 1;
    console.log("По проектам:", JSON.stringify(byProj));
    for (const proj of Object.keys(byProj)) {
      const mine = lots.filter((l) => l.project === proj);
      const mx = mine.reduce((m, l) => (l.updatedAt > m ? l.updatedAt : m), new Date(0));
      const st = {}; for (const l of mine) st[l.status] = (st[l.status] || 0) + 1;
      console.log(`  ${proj}: последнее обновление ${fmt(mx)} UTC; статусы ${JSON.stringify(st)}`);
    }
    if (!FEEDS.length) { console.log("Адреса фидов не найдены ни в окружении, ни в собранном коде каталога"); return; }

    for (const feed of FEEDS) {
      let xml;
      try {
        const r = await fetch(feed.url, { signal: AbortSignal.timeout(40000) });
        console.log(`\n=== Фид ${feed.project}: HTTP ${r.status} ===`);
        if (!r.ok) continue;
        xml = await r.text();
      } catch (e) { console.log(`\n=== Фид ${feed.project}: ошибка сети ${e?.message || e} ===`); continue; }
      const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" }).parse(xml);
      const gen = parsed?.["realty-feed"]?.["generation-date"];
      const offers = [].concat(parsed?.["realty-feed"]?.offer || []);
      console.log(`  дата формирования фида: ${gen || "—"}; предложений: ${offers.length}`);
      let same = 0, diff = 0, missing = 0;
      const examples = [];
      for (const o of offers) {
        const id = String(o["internal-id"] ?? o.id ?? "");
        const feedPrice = Number(o?.price?.value || 0);
        const lot = byExt.get(id);
        if (!lot) { missing++; continue; }
        if (Math.round(Number(lot.price)) === Math.round(feedPrice)) same++;
        else { diff++; if (examples.length < 5) examples.push(`лот ${id}: у нас ${Number(lot.price).toLocaleString("ru-RU")} ₽, в фиде ${feedPrice.toLocaleString("ru-RU")} ₽ (карточка обновлена ${fmt(lot.updatedAt)})`); }
      }
      console.log(`  цена совпадает: ${same}; отличается: ${diff}; в фиде есть, у нас нет: ${missing}`);
      for (const e of examples) console.log("   ", e);
    }
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
