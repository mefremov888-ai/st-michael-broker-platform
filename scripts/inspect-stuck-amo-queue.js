#!/usr/bin/env node
/**
 * 2026-09-17: разбор заявок, застрявших в очереди отправки в amoCRM.
 * Только чтение. Для каждой записи со статусом FAILED/PENDING показываем:
 * саму заявку, брокера (контакт в amo, агентство) и все остальные заявки
 * по тому же телефону клиента — чтобы видеть пары-дубли и понимать,
 * какая из них держит другую.
 */
const mask = (p) => (p ? `${String(p).slice(0, 6)}***${String(p).slice(-2)}` : "—");
const when = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace("T", " ") : "—");

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const stuck = await prisma.client.findMany({
      where: { amoSyncStatus: { in: ["FAILED", "PENDING"] } },
      select: {
        id: true, fullName: true, phone: true, project: true,
        createdAt: true, updatedAt: true,
        uniquenessStatus: true, uniquenessExpiresAt: true,
        amoLeadId: true, amoSyncStatus: true, amoSyncAttempts: true,
        amoSyncError: true, amoSyncLastAttemptAt: true,
        fixationAgencyId: true,
        broker: { select: { id: true, fullName: true, displayName: true, phone: true, amoContactId: true, status: true } },
        responsibleBroker: { select: { id: true, fullName: true, phone: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    console.log(`=== Застрявших заявок: ${stuck.length} ===\n`);

    for (const c of stuck) {
      console.log(`--- ${c.fullName} · ${mask(c.phone)} · ${c.project}`);
      console.log(`    заведена ${when(c.createdAt)}, изменена ${when(c.updatedAt)}`);
      console.log(`    уникальность: ${c.uniquenessStatus}, до ${when(c.uniquenessExpiresAt)}`);
      console.log(`    amo: лид ${c.amoLeadId || "НЕТ"}, статус ${c.amoSyncStatus}, попыток ${c.amoSyncAttempts}, последняя ${when(c.amoSyncLastAttemptAt)}`);
      console.log(`    ошибка: ${c.amoSyncError || "—"}`);
      const b = c.broker;
      console.log(`    брокер: ${b?.fullName}${b?.displayName && b.displayName !== b.fullName ? ` (имя для работы: ${b.displayName})` : ""} · ${mask(b?.phone)} · статус ${b?.status} · контакт amo ${b?.amoContactId || "НЕТ"}`);
      if (c.responsibleBroker && c.responsibleBroker.id !== b?.id) {
        console.log(`    ответственный: ${c.responsibleBroker.fullName} · ${mask(c.responsibleBroker.phone)}`);
      }

      // агентство фиксации и агентства брокера
      if (c.fixationAgencyId) {
        const a = await prisma.agency.findUnique({ where: { id: c.fixationAgencyId }, select: { name: true } });
        console.log(`    агентство заявки: ${a?.name || c.fixationAgencyId}`);
      } else {
        console.log(`    агентство заявки: НЕ УКАЗАНО`);
      }
      if (b?.id) {
        const links = await prisma.brokerAgency.findMany({
          where: { brokerId: b.id },
          select: { isPrimary: true, agency: { select: { name: true } } },
        });
        console.log(`    агентства брокера: ${links.length ? links.map((l) => `${l.agency?.name}${l.isPrimary ? " (основное)" : ""}`).join(", ") : "НЕТ НИ ОДНОГО"}`);
      }

      // все заявки по тому же телефону клиента
      const siblings = await prisma.client.findMany({
        where: { phone: c.phone, id: { not: c.id } },
        select: {
          id: true, createdAt: true, uniquenessStatus: true, amoLeadId: true,
          amoSyncStatus: true, amoSyncError: true,
          broker: { select: { fullName: true, phone: true } },
        },
        orderBy: { createdAt: "asc" },
      });
      if (siblings.length) {
        console.log(`    другие заявки по этому телефону: ${siblings.length}`);
        for (const s of siblings) {
          console.log(`      · ${when(s.createdAt)} · брокер ${s.broker?.fullName} · ${s.uniquenessStatus} · лид ${s.amoLeadId || "нет"} · синк ${s.amoSyncStatus || "—"}${s.amoSyncError ? ` (${s.amoSyncError})` : ""}`);
        }
      } else {
        console.log(`    других заявок по этому телефону нет`);
      }
      console.log("");
    }
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
