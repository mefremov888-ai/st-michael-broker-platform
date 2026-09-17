#!/usr/bin/env node
/**
 * 2026-09-17: раскладка папок раздела «Материалы» — какие пути реально лежат
 * в базе и сколько в каждом файлов. Нужно, чтобы аккуратно перенести
 * презентации по проектам и поднять папку Reels на уровень выше.
 * Только чтение.
 */
async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const groups = await prisma.document.groupBy({
      by: ["category", "subcategory"],
      _count: { _all: true },
    });
    const rows = groups
      .map((g) => ({
        category: g.category || "—",
        subcategory: g.subcategory || "(без папки)",
        count: g._count._all,
      }))
      .sort((a, b) =>
        a.category === b.category
          ? a.subcategory.localeCompare(b.subcategory, "ru")
          : String(a.category).localeCompare(String(b.category), "ru"),
      );
    console.log(`Папок (category + subcategory): ${rows.length}\n`);
    let current = null;
    for (const r of rows) {
      if (r.category !== current) {
        current = r.category;
        console.log(`\n### ${current}`);
      }
      console.log(`  ${r.subcategory} — ${r.count}`);
    }

    // отдельно: что похоже на презентации и на reels
    const pres = rows.filter((r) => /презент/i.test(r.subcategory) || /презент/i.test(String(r.category)));
    const reels = rows.filter((r) => /reels|рилс/i.test(r.subcategory));
    console.log(`\n=== Похоже на презентации: ${pres.length} папок ===`);
    for (const r of pres) console.log(`  ${r.category} / ${r.subcategory} — ${r.count}`);
    console.log(`\n=== Похоже на Reels: ${reels.length} папок ===`);
    for (const r of reels) console.log(`  ${r.category} / ${r.subcategory} — ${r.count}`);

    // документы в папке «Фото» Квартала Серебряный Бор (владелец просил удалить один документ)
    const photoDocs = await prisma.document.findMany({
      where: {
        subcategory: { contains: "Фото" },
        NOT: { type: { in: ["JPG", "JPEG", "PNG", "HEIC", "WEBP"] } },
      },
      select: { id: true, name: true, type: true, category: true, subcategory: true },
      take: 20,
    });
    console.log(`\n=== Не-фотографии внутри папок «Фото»: ${photoDocs.length} ===`);
    for (const d of photoDocs) console.log(`  ${d.category} / ${d.subcategory} · ${d.name} (${d.type})`);
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
