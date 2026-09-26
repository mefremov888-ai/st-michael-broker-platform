#!/usr/bin/env node
// 2026-09-26: контакты Денгизовой Александры Аликовны в amoCRM (0/1/дубль).
const mask = (v) => { const d = String(v || "").replace(/\D/g, ""); return d ? `+${d.slice(0, 5)}****${d.slice(-2)}` : "—"; };
async function main() {
  const { AmoCrmAdapter, setAmoTokens, setAmoTokenRefreshHook } = require("/app/packages/integrations/dist/amo-crm.adapter");
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const broker = await prisma.broker.findFirst({ where: { fullName: { contains: "Денгизова", mode: "insensitive" } }, select: { id: true, fullName: true, phone: true, status: true, amoContactId: true } });
    if (!broker) { console.log("Брокер не найден"); return; }
    console.log(`Брокер: ${broker.fullName} | id ${broker.id} | тел. ${mask(broker.phone)} | ${broker.status} | amoContactId в карточке: ${broker.amoContactId ?? "—"}`);

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
    const res = await amo["request"](`/contacts?query=${digits}&limit=50`);
    const contacts = res?._embedded?.contacts || [];
    console.log(`\nКонтактов в amo по последним 10 цифрам номера: ${contacts.length}`);
    for (const c of contacts) {
      const phones = (c.custom_fields_values || []).filter((f) => f.field_code === "PHONE").flatMap((f) => f.values.map((v) => v.value));
      console.log(`  #${c.id} «${c.name}» | тел.: ${phones.map(mask).join(", ") || "—"} | обновлён ${new Date(c.updated_at * 1000).toISOString().slice(0, 16)}`);
    }
    if (!contacts.length) console.log("→ Контакта нет вообще.");
    else if (contacts.length === 1) console.log(`→ Контакт один (#${contacts[0].id}) — просто не привязан.`);
    else console.log("→ Дубль — нужна ручная привязка.");
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
