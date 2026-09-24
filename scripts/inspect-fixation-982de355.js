#!/usr/bin/env node
/**
 * 2026-09-24: разовый разбор конкретной зависшей фиксации (алерт «нет
 * контакта amoCRM у ответственного»). Client id и Broker id — из текста
 * алерта в Телеграме. Только чтение, телефоны маскируются.
 */
const mask = (v) => { const d = String(v || "").replace(/\D/g, ""); return d ? `+${d.slice(0, 5)}****${d.slice(-2)}` : "—"; };
const iso = (d) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) : "—");

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const client = await prisma.client.findUnique({
      where: { id: "982de355-993b-4303-b0d8-61f005028c89" },
      select: { id: true, fullName: true, phone: true, project: true, brokerId: true, responsibleBrokerId: true, uniquenessStatus: true, fixationStatus: true, amoLeadId: true, amoSyncStatus: true, amoSyncError: true, amoSyncAttempts: true, createdAt: true, fixationAgencyId: true },
    });
    console.log("=== Клиент ===");
    console.log(client ? `${client.fullName} | тел. ${mask(client.phone)} | проект ${client.project} | уникальность ${client.uniquenessStatus} | фиксация ${client.fixationStatus} | создан ${iso(client.createdAt)} | синк ${client.amoSyncStatus} (попыток ${client.amoSyncAttempts})${client.amoSyncError ? ` — ${String(client.amoSyncError).slice(0,200)}` : ""}` : "НЕ НАЙДЕН");
    if (!client) return;

    const brokerIds = [...new Set([client.brokerId, client.responsibleBrokerId, "6e414141-f2ca-4c71-8402-2032c9186568"].filter(Boolean))];
    console.log("\n=== Брокеры (подавший / ответственный / из алерта) ===");
    for (const id of brokerIds) {
      const b = await prisma.broker.findUnique({ where: { id }, select: { id: true, fullName: true, phone: true, role: true, status: true, amoContactId: true, isCoordinator: true, mergedIntoId: true } });
      if (!b) { console.log(`  ${id}: НЕ НАЙДЕН`); continue; }
      const roles = [];
      if (id === client.brokerId) roles.push("подавший");
      if (id === client.responsibleBrokerId) roles.push("ответственный");
      if (id === "6e414141-f2ca-4c71-8402-2032c9186568") roles.push("из алерта");
      console.log(`  ${b.fullName} | тел. ${mask(b.phone)} | ${b.role}/${b.status}${b.isCoordinator ? " · координатор" : ""} | amo контакт ${b.amoContactId ?? "—"} | слит в ${b.mergedIntoId ?? "—"} | роли: ${roles.join(", ")}`);
    }

    if (client.fixationAgencyId) {
      const agency = await prisma.agency.findUnique({ where: { id: client.fixationAgencyId }, select: { name: true, inn: true } });
      console.log(`\nАгентство фиксации: ${agency ? `${agency.name} (ИНН ${agency.inn})` : client.fixationAgencyId}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
