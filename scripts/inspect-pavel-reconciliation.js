#!/usr/bin/env node
/**
 * 2026-09-26: разбор конкретной зависшей заявки (Павел, Серебряный Бор,
 * ответственная Илле Светлана) — AMO_CREATE_RECONCILIATION_REQUIRED:
 * AMO_NETWORK_ERROR. Смотрим, создался ли лид в amoCRM на самом деле
 * (сеть могла оборваться уже после того, как amo принял запрос), или нет.
 * Только чтение.
 */
const mask = (v) => { const d = String(v || "").replace(/\D/g, ""); return d ? `+${d.slice(0, 5)}****${d.slice(-2)}` : "—"; };
const iso = (d) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) : "—");

async function main() {
  const { AmoCrmAdapter, setAmoTokens, setAmoTokenRefreshHook } = require("/app/packages/integrations/dist/amo-crm.adapter");
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const client = await prisma.client.findFirst({
      where: { fullName: "Павел", project: "SILVER_BOR", amoSyncError: { contains: "AMO_NETWORK_ERROR" } },
      select: { id: true, fullName: true, phone: true, project: true, brokerId: true, responsibleBrokerId: true, uniquenessStatus: true, fixationStatus: true, amoLeadId: true, amoSyncStatus: true, amoSyncError: true, amoSyncAttempts: true, amoSyncLastAttemptAt: true, createdAt: true, fixationAgencyId: true },
    });
    if (!client) { console.log("Клиент не найден по этим условиям"); return; }
    console.log(`=== Клиент ===`);
    console.log(`${client.fullName} | тел. ${mask(client.phone)} | id ${client.id} | проект ${client.project} | создан ${iso(client.createdAt)}`);
    console.log(`уникальность ${client.uniquenessStatus} | фиксация ${client.fixationStatus} | лид в карточке ${client.amoLeadId ?? "—"} | синк ${client.amoSyncStatus}`);
    console.log(`ошибка: ${client.amoSyncError} | попыток ${client.amoSyncAttempts} | последняя попытка ${iso(client.amoSyncLastAttemptAt)}`);

    const respId = client.responsibleBrokerId || client.brokerId;
    const broker = await prisma.broker.findUnique({ where: { id: respId }, select: { fullName: true, phone: true, amoContactId: true, status: true } });
    console.log(`ответственный: ${broker ? `${broker.fullName} (${mask(broker.phone)}, amo контакт ${broker.amoContactId ?? "—"}, ${broker.status})` : respId}`);

    const rows = await prisma.systemSetting.findMany({ where: { key: { in: ["AMO_ACCESS_TOKEN", "AMO_REFRESH_TOKEN"] } }, select: { key: true, value: true } });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    setAmoTokens(byKey.get("AMO_ACCESS_TOKEN") || "", byKey.get("AMO_REFRESH_TOKEN") || "");
    setAmoTokenRefreshHook(async (tokens) => {
      for (const [key, value] of [["AMO_ACCESS_TOKEN", tokens.access], ["AMO_REFRESH_TOKEN", tokens.refresh]]) {
        await prisma.systemSetting.upsert({ where: { key }, update: { value, updatedBy: "inspect" }, create: { key, value, updatedBy: "inspect" } });
      }
    });
    const amo = new AmoCrmAdapter();

    // Контакт клиента по телефону.
    const contact = await amo.findContactByPhone(client.phone, { strict: false });
    console.log(`\n=== amoCRM: контакт клиента ${contact ? `#${contact.id} «${contact.name}»` : "НЕ НАЙДЕН"} ===`);
    if (contact) {
      const leads = await amo.getLeadsByContact(Number(contact.id));
      console.log(`Лидов у контакта: ${leads.length}`);
      for (const l of leads) {
        const cf = (id) => (l.custom_fields_values || []).find((f) => Number(f.field_id) === id)?.values?.[0]?.value;
        console.log(`  • лид ${l.id} | воронка ${l.pipeline_id} | статус ${l.status_id} | создан ${iso(l.created_at * 1000)} | ответственный ${l.responsible_user_id} | агент: ${cf(835417) ?? "—"}`);
      }
      const cabinetLeadIds = new Set([client.amoLeadId ? String(client.amoLeadId) : null].filter(Boolean));
      const alreadyLinked = leads.some((l) => cabinetLeadIds.has(String(l.id)));
      if (!leads.length) console.log("→ Лидов нет: сеть оборвалась ДО создания лида. Безопасно повторить создание.");
      else if (alreadyLinked) console.log("→ Лид уже привязан в карточке — просто обновить статус синка.");
      else console.log("→ Лид(ы) есть, но не привязаны в кабинете — вероятно, лид создался, а подтверждение до нас не дошло. Нужно привязать САМЫЙ подходящий по времени/проекту, не создавать новый.");
    } else {
      console.log("→ Контакта клиента нет вообще: сеть оборвалась ДО создания. Безопасно повторить создание с нуля.");
    }
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
