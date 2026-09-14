#!/usr/bin/env node
/**
 * 2026-09-14 (жалоба владельца «не грузятся картинки»): обложки папок
 * материалов на лендинге отдавали 404. Причина — папку на Яндекс.Диске
 * переименовали («1. Архитектура и благоустройство» → «01. Архитектура и
 * благоустройство внешнее»), файлы переехали, а пути обложек в настройке
 * MATERIALS_FOLDER_LAYOUT остались старыми.
 *
 * Скрипт проверяет каждую обложку по диску и для пропавших подбирает замену:
 * сначала файл с тем же именем в другом месте, иначе — первое превью из той
 * же папки материалов. Остальную раскладку не трогает.
 *
 * DRY_RUN=1 по умолчанию. Боевой режим: DRY_RUN=0 CONFIRM=1.
 */
const fs = require("node:fs");
const path = require("node:path");

const KEY = "MATERIALS_FOLDER_LAYOUT";
const UPLOADS = process.env.UPLOADS_DIR || "/app/uploads";
const DRY_RUN = process.env.DRY_RUN !== "0";
const CONFIRMED = process.env.CONFIRM === "1" || process.env.CONFIRM === "true";
const WRITE = !DRY_RUN && CONFIRMED;

const toLocal = (url) =>
  url && url.startsWith("/files/") ? path.join(UPLOADS, decodeURIComponent(url.slice("/files/".length))) : null;
const exists = (url) => {
  const p = toLocal(url);
  return p ? fs.existsSync(p) : false;
};

function indexFiles(root) {
  const byName = new Map();
  const byDir = new Map();
  const walk = (dir, depth = 0) => {
    if (depth > 9) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else {
        if (!byName.has(e.name)) byName.set(e.name, full);
        const d = path.dirname(full);
        if (!byDir.has(d)) byDir.set(d, []);
        byDir.get(d).push(full);
      }
    }
  };
  walk(root);
  return { byName, byDir };
}

const toUrl = (abs) =>
  "/files/" + abs.slice(UPLOADS.length + 1).split(path.sep).map(encodeURIComponent).join("/");

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const setting = await prisma.systemSetting.findUnique({ where: { key: KEY } });
    if (!setting?.value) { console.error(`FATAL: настройка ${KEY} не найдена`); process.exit(2); }
    const layout = JSON.parse(setting.value);
    const covers = layout.covers && typeof layout.covers === "object" ? layout.covers : {};
    const names = Object.keys(covers);
    console.log(`=== Обложки папок материалов: ${names.length} ===`);

    const { byName, byDir } = indexFiles(UPLOADS);
    const fixes = {};
    let ok = 0, broken = 0, hopeless = 0;
    for (const folder of names) {
      const url = covers[folder];
      if (typeof url !== "string" || !url.startsWith("/files/")) { ok++; continue; }
      if (exists(url)) { ok++; continue; }
      broken++;
      const base = decodeURIComponent(url.split("/").pop() || "");
      let replacement = byName.has(base) ? toUrl(byName.get(base)) : null;
      if (!replacement) {
        // первое превью из той же папки на диске (без последнего сегмента пути)
        const parent = path.dirname(toLocal(url) || "");
        const siblings = byDir.get(parent) || [];
        const pic = siblings.find((f) => /\.(jpe?g|png|webp)$/i.test(f));
        if (pic) replacement = toUrl(pic);
      }
      if (replacement) {
        fixes[folder] = replacement;
        console.log(`  ЧИНИМ  ${folder}`);
        console.log(`     было:  ${decodeURIComponent(url).slice(0, 90)}`);
        console.log(`     стало: ${decodeURIComponent(replacement).slice(0, 90)}`);
      } else {
        hopeless++;
        console.log(`  БЕЗ ЗАМЕНЫ  ${folder} → ${decodeURIComponent(url).slice(0, 80)}`);
      }
    }
    console.log(`\n  на месте: ${ok} · сломано: ${broken} · чиним: ${Object.keys(fixes).length} · без замены: ${hopeless}`);

    if (!Object.keys(fixes).length) { console.log("\nНечего менять."); return; }
    if (!WRITE) { console.log("\nПРОГОН БЕЗ ЗАПИСИ (нужны DRY_RUN=0 и CONFIRM=1)."); return; }

    const next = { ...layout, covers: { ...covers, ...fixes } };
    await prisma.systemSetting.update({
      where: { key: KEY },
      data: { value: JSON.stringify(next), updatedBy: "fix-material-covers" },
    });
    console.log(`\nЗАПИСЬ ВЫПОЛНЕНА: обновлено обложек ${Object.keys(fixes).length}`);
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
