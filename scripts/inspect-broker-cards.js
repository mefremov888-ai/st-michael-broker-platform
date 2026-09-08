#!/usr/bin/env node
/**
 * 2026-09-08: карточки брокеров по списку id (для редактируемых выгрузок
 * владельцу): ФИО, телефон (маскирован в логе до последних 4 цифр), статус,
 * агентства, amo-контакт. Только чтение. Вход: BROKER_IDS="id1,id2,…".
 * Выход: SECTION_B64:brokers:<json>.
 */
async function main() {
  const ids = String(process.env.BROKER_IDS || "").split(/[,;\s]+/).filter(Boolean);
  if (!ids.length) throw new Error("BROKER_IDS пуст");
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.broker.findMany({
      where: { id: { in: ids } },
      select: { id: true, fullName: true, phone: true, status: true, role: true, amoContactId: true, mergedIntoId: true, brokerAgencies: { select: { isPrimary: true, agency: { select: { name: true, inn: true } } } } },
    });
    const out = rows.map((b) => ({
      id: b.id, fullName: b.fullName, phoneMasked: String(b.phone || "").replace(/(\+7\d{3})\d{4}(\d{2})/, "$1****$2"), phoneTail: String(b.phone || "").slice(-4),
      status: b.status, role: b.role, amoContactId: b.amoContactId ? String(b.amoContactId) : null, mergedIntoId: b.mergedIntoId,
      agencies: b.brokerAgencies.map((x) => `${x.agency.name}${x.isPrimary ? " (осн.)" : ""}`).join("; "),
    }));
    console.log(`Карточек: ${out.length} из ${ids.length}`);
    for (const o of out) console.log(`  • ${o.fullName} | ${o.phoneMasked} | ${o.status} | ${o.agencies || "—"} | amo ${o.amoContactId || "—"}`);
    const b64 = Buffer.from(JSON.stringify(out), "utf8").toString("base64");
    const C = 60000; const n = Math.ceil(b64.length / C) || 1;
    for (let i = 0; i < n; i++) console.log(`SECTION_B64:brokers:${i + 1}/${n}:${b64.slice(i * C, (i + 1) * C)}`);
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
