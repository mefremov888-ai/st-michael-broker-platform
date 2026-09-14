#!/usr/bin/env node
/**
 * 2026-09-14: на сайте не грузились картинки материалов. Разбор: папку на
 * Яндекс.Диске переименовали («1. Архитектура и благоустройство» →
 * «01. Архитектура и благоустройство внешнее»), синхронизация скачала файлы
 * по новым путям, а записи документов в базе остались со старыми — они
 * отдают 404. Считаем, сколько таких записей и есть ли им замена.
 * Только чтение.
 */
const fs = require("fs");
const path = require("path");
const UPLOADS = process.env.UPLOADS_DIR || "/app/uploads";

const localPath = (fileUrl) => {
  if (!fileUrl || !fileUrl.startsWith("/files/")) return null;
  return path.join(UPLOADS, decodeURIComponent(fileUrl.slice("/files/".length)));
};

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const docs = await prisma.document.findMany({
      select: { id: true, name: true, category: true, subcategory: true, fileUrl: true, isPublic: true },
    });
    const dead = [];
    let external = 0, ok = 0;
    for (const d of docs) {
      if (!d.fileUrl) continue;
      if (!d.fileUrl.startsWith("/files/")) { external++; continue; }
      const p = localPath(d.fileUrl);
      if (p && fs.existsSync(p)) ok++;
      else dead.push(d);
    }
    console.log("=== Документы ===");
    console.log(`  всего:                 ${docs.length}`);
    console.log(`  файл на месте:         ${ok}`);
    console.log(`  внешние ссылки:        ${external}`);
    console.log(`  ФАЙЛА НЕТ (404):       ${dead.length}`);

    const byFolder = {};
    for (const d of dead) {
      const key = (d.subcategory || "—").split("/")[0];
      byFolder[key] = (byFolder[key] || 0) + 1;
    }
    console.log("  по папкам:", JSON.stringify(byFolder, null, 0).slice(0, 400));

    // есть ли замена: файл с тем же именем где-то в uploads
    const base = (u) => decodeURIComponent(String(u).split("/").pop() || "");
    const index = new Map();
    const walk = (dir, depth = 0) => {
      if (depth > 8) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (!index.has(e.name)) index.set(e.name, full);
      }
    };
    walk(UPLOADS);
    let replaceable = 0;
    const samples = [];
    for (const d of dead) {
      const name = base(d.fileUrl);
      if (index.has(name)) {
        replaceable++;
        if (samples.length < 8) samples.push(`${d.name} → ${index.get(name).replace(UPLOADS, "")}`);
      }
    }
    console.log(`\n  из них можно подменить (файл с тем же именем нашёлся): ${replaceable}`);
    console.log(`  без замены (файла нет нигде):                         ${dead.length - replaceable}`);
    console.log("  примеры замен:");
    for (const s of samples) console.log(`    ${s}`);
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
