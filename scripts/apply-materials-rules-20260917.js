#!/usr/bin/env node
/**
 * 2026-09-17 (решения владельца): переносим презентации внутрь проектов и
 * выносим Reels отдельной папкой — в СОХРАНЁННОЙ раскладке материалов
 * (SystemSetting MATERIALS_FOLDER_LAYOUT). Заготовка в коде уже поправлена,
 * но сохранённая раскладка её перекрывает, поэтому правим и её.
 *
 * Трогаем только `rules`: обложки, виртуальные подпапки и группы остаются
 * как есть. Идемпотентно: правило с таким же id перезаписывается, лишние
 * старые правила («Презентации» и «Презентации проектов» верхним уровнем)
 * удаляются.
 *
 * DRY_RUN=1 по умолчанию. Боевой режим: DRY_RUN=0 CONFIRM=1.
 */
const KEY = "MATERIALS_FOLDER_LAYOUT";
const DRY_RUN = process.env.DRY_RUN !== "0";
const CONFIRMED = process.env.CONFIRM === "1" || process.env.CONFIRM === "true";
const WRITE = !DRY_RUN && CONFIRMED;

// Правила, которые должны быть в раскладке после правки.
const WANTED = [
  { id: "presentations-zorge", prefix: "Презентации/Зорге 9", groupId: "zorge", displayName: "Презентации", sortOrder: 44 },
  { id: "presentations-pure", prefix: "Презентации/Pure. Home Comfort", groupId: "zorge", displayName: "Презентации", sortOrder: 45 },
  { id: "presentations-ksb", prefix: "Презентации/Квартал Серебряный Бор", groupId: "berarina", displayName: "Презентации", sortOrder: 54 },
  { id: "project-presentations-zorge", prefix: "Презентации проектов/_Зорге 9_", groupId: "zorge", displayName: "Презентации", sortOrder: 46 },
  { id: "project-presentations-ksb", prefix: "Презентации проектов/_Квартал Серебряный бор_", groupId: "berarina", displayName: "Презентации", sortOrder: 55 },
  { id: "zorge-reels", prefix: "ЗОРГЕ 9/2. Видео/reels", groupId: "zorge", displayName: "Reels", sortOrder: 43 },
  { id: "zorge-reels-pack", prefix: "Видеоконтент/Зорге 9/Reels", groupId: "zorge", displayName: "Reels", sortOrder: 43 },
];

// Правила верхнего уровня, которых быть не должно: их содержимое разошлось
// по проектам.
const DROP_PREFIXES = ["Презентации", "Презентации проектов"];

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: KEY } });
    if (!row?.value) {
      console.log("Сохранённой раскладки нет — работает заготовка из кода, править нечего.");
      return;
    }
    const layout = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
    const rules = Array.isArray(layout.rules) ? layout.rules : [];
    console.log(`Правил в сохранённой раскладке: ${rules.length}`);

    const groupIds = new Set((layout.groups || []).map((g) => g.id));
    for (const rule of WANTED) {
      if (!groupIds.has(rule.groupId)) {
        console.log(`ОСТАНОВКА: в раскладке нет группы «${rule.groupId}» — правила ссылались бы в пустоту.`);
        return;
      }
    }

    const dropped = rules.filter((r) => DROP_PREFIXES.includes(String(r.prefix)));
    console.log(`Убираем правил верхнего уровня: ${dropped.length}${dropped.length ? " — " + dropped.map((r) => `${r.id} (${r.prefix})`).join(", ") : ""}`);

    const kept = rules.filter(
      (r) => !DROP_PREFIXES.includes(String(r.prefix)) && !WANTED.some((w) => w.id === r.id),
    );
    const next = [
      ...kept,
      ...WANTED.map((w) => ({
        id: w.id,
        prefix: w.prefix,
        groupId: w.groupId,
        kind: "as_is",
        displayName: w.displayName,
        visibleOnLanding: true,
        visibleInCabinet: true,
        sortOrder: w.sortOrder,
      })),
    ];
    console.log(`Добавляем/обновляем правил: ${WANTED.length}. Станет правил: ${next.length}`);
    for (const w of WANTED) console.log(`  ${w.prefix} → ${w.groupId} / ${w.displayName}`);

    if (!WRITE) {
      console.log("\nПРОГОН БЕЗ ЗАПИСИ: раскладка не изменена (нужны DRY_RUN=0 и CONFIRM=1).");
      return;
    }
    const nextLayout = { ...layout, rules: next };
    await prisma.systemSetting.update({
      where: { key: KEY },
      data: { value: JSON.stringify(nextLayout) },
    });
    console.log("\nЗАПИСЬ ВЫПОЛНЕНА: раскладка обновлена.");
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
