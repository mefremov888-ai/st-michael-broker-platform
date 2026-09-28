#!/usr/bin/env node
// 2026-09-28: какие формы телефонов у брокеров (для вкладок «с номерами» /
// «без номеров» в Нашей базе). Только чтение, номера не печатаются.
async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.broker.findMany({ where: { role: "BROKER" }, select: { phone: true, mergedIntoId: true } });
    const shape = (p) => {
      const s = String(p || "");
      if (!s) return "(пусто)";
      if (s.startsWith("tg:")) return "tg:<ник>";
      if (/^\+7\d{10}$/.test(s)) return "+7 и 10 цифр";
      if (/^\+\d{10,15}$/.test(s)) return "+ и 10-15 цифр (не RU)";
      if (/^\d+$/.test(s)) return `только цифры (${s.length})`;
      return "другое: " + s.replace(/\d/g, "9").slice(0, 16);
    };
    const c = new Map();
    for (const r of rows) { const k = (r.mergedIntoId ? "[слит] " : "") + shape(r.phone); c.set(k, (c.get(k) || 0) + 1); }
    console.log(`Брокеров role=BROKER: ${rows.length}`);
    for (const [k, v] of [...c.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(6)}  ${k}`);
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
