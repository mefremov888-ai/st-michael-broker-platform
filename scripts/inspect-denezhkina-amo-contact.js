#!/usr/bin/env node
/**
 * 2026-09-24: у брокера Денежкиной Ирины (ответственная по зависшей заявке
 * Таисии) нет amoContactId. Смотрим, сколько контактов в amoCRM у её
 * телефона: 0 (контакт не создан — подхватит крон), 1 (просто не привязан),
 * 2+ (дубли — нужна ручная привязка). Только чтение, телефон маскируется.
 */
const mask = (v) => { const d = String(v || "").replace(/\D/g, ""); return d ? `+${d.slice(0, 5)}****${d.slice(-2)}` : "—"; };

async function main() {
  const { AmoCrmAdapter, setAmoTokens, setAmoTokenRefreshHook } = require("/app/packages/integrations/dist/amo-crm.adapter");
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const broker = await prisma.broker.findUnique({ where: { id: "6e414141-f2ca-4c71-8402-2032c9186568" }, select: { id: true, fullName: true, phone: true, status: true, amoContactId: true } });
    if (!broker) { console.log("Брокер не найден"); return; }
    console.log(`Брокер: ${broker.fullName} | тел. ${mask(broker.phone)} | ${broker.status} | amoContactId в карточке: ${broker.amoContactId ?? "—"}`);

    const rows = await prisma.systemSetting.findMany({ where: { key: { in: ["AMO_ACCESS_TOKEN", "AMO_REFRESH_TOKEN"] } }, select: { key: true, value: true } });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    setAmoTokens(byKey.get("AMO_ACCESS_TOKEN") || "", byKey.get("AMO_REFRESH_TOKEN") || "");
    setAmoTokenRefreshHook(async (tokens) => {
      for (const [key, value] of [["AMO_ACCESS_TOKEN", tokens.access], ["AMO_REFRESH_TOKEN", tokens.refresh]]) {
        await prisma.systemSetting.upsert({ where: { key }, update: { value, updatedBy: "inspect" }, create: { key, value, updatedBy: "inspect" } });
      }
    });
    const amo = new AmoCrmAdapter();
    const digits = String(broker.phone || "").replace(/\D/g, "").slice(-10);
    // Прямой поиск по amo API (без strict) — покажет все совпадения, не только первое.
    const res = await amo["request"](`/contacts?query=${digits}&limit=50`);
    const contacts = res?._embedded?.contacts || [];
    console.log(`\nКонтактов в amo по последним 10 цифрам номера: ${contacts.length}`);
    for (const c of contacts) {
      const phones = (c.custom_fields_values || []).filter((f) => f.field_code === "PHONE").flatMap((f) => f.values.map((v) => v.value));
      console.log(`  #${c.id} «${c.name}» | тел.: ${phones.map(mask).join(", ") || "—"} | обновлён ${new Date(c.updated_at * 1000).toISOString().slice(0, 10)}`);
    }
    if (!contacts.length) console.log("→ Контакта нет вообще. Авторетрай (каждые 5 мин) должен сам создать его в amoCRM.");
    else if (contacts.length === 1) console.log("→ Контакт один, просто не привязан к карточке — можно привязать через apply-link-broker-amo-contact.yml.");
    else console.log("→ Несколько контактов (дубль) — нужно выбрать нужный и привязать вручную.");
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
