#!/usr/bin/env node
/**
 * 2026-09-07 (решение владельца, п.17): у брокера несколько контактов в amo с
 * одним телефоном (кейс «Татьяна», 47146559 / 47050643) — привязать карточку
 * кабинета к одному контакту («любой, не принципиально»): берём контакт с
 * более поздним updated_at.
 *
 * Вход: CONTACT_IDS="47146559,47050643"; DRY_RUN=1 по умолчанию.
 * Что делает: читает контакты из amo, ищет карточку брокера по телефонам
 * контактов (brokers.phone / broker_phones), показывает, и при APPLY пишет
 * Broker.amoContactId (только если пусто или отличается от обоих).
 */

const digits = (v) => String(v || "").replace(/\D/g, "");
const last10 = (v) => digits(v).slice(-10);
const mask = (v) => { const d = digits(v); return d ? `+${d.slice(0, 5)}****${d.slice(-2)}` : "—"; };

async function main() {
  const dryRun = process.env.DRY_RUN !== "0";
  const ids = String(process.env.CONTACT_IDS || "").split(/[,;\s]+/).map((s) => Number(s)).filter((n) => Number.isSafeInteger(n) && n > 0);
  if (ids.length < 1) throw new Error("CONTACT_IDS пуст");
  const { AmoCrmAdapter, setAmoTokens, setAmoTokenRefreshHook } = require("/app/packages/integrations/dist/amo-crm.adapter");
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const tokenRows = await prisma.systemSetting.findMany({ where: { key: { in: ["AMO_ACCESS_TOKEN", "AMO_REFRESH_TOKEN"] } }, select: { key: true, value: true } });
    const byKey = new Map(tokenRows.map((r) => [r.key, r.value]));
    setAmoTokens(byKey.get("AMO_ACCESS_TOKEN") || "", byKey.get("AMO_REFRESH_TOKEN") || "");
    setAmoTokenRefreshHook(async (tokens) => {
      for (const [key, value] of [["AMO_ACCESS_TOKEN", tokens.access], ["AMO_REFRESH_TOKEN", tokens.refresh]]) {
        await prisma.systemSetting.upsert({ where: { key }, update: { value, updatedBy: "link-broker-amo-contact" }, create: { key, value, updatedBy: "link-broker-amo-contact" } });
      }
    });
    const amo = new AmoCrmAdapter();
    console.log(`=== Режим: ${dryRun ? "DRY-RUN" : "APPLY"} · контактов: ${ids.length} ===`);
    const q = ids.map((id) => `filter[id][]=${id}`).join("&");
    const res = await amo["request"](`/contacts?${q}&limit=50&with=leads`);
    const contacts = res?._embedded?.contacts || [];
    const phones = new Set();
    for (const c of contacts) {
      const cp = [];
      for (const f of c.custom_fields_values || []) if (f.field_code === "PHONE") for (const v of f.values || []) { cp.push(String(v.value)); const p = last10(v.value); if (p.length === 10) phones.add(p); }
      console.log(`  • контакт ${c.id} «${c.name}» обновлён ${new Date(c.updated_at * 1000).toISOString().slice(0, 10)} тел. ${cp.map(mask).join(", ") || "—"} лидов ${c._embedded?.leads?.length ?? 0}`);
    }
    if (!contacts.length) throw new Error("контакты не найдены в amo");
    const chosen = [...contacts].sort((a, b) => Number(b.updated_at) - Number(a.updated_at))[0];
    console.log(`Выбран (свежее обновление): ${chosen.id} «${chosen.name}»`);
    const variants = [...phones].flatMap((p) => [`+7${p}`, `8${p}`, `7${p}`, p]);
    const brokers = await prisma.broker.findMany({
      where: { OR: [{ phone: { in: variants } }, { phones: { some: { phone: { in: variants } } } }, { amoContactId: { in: ids.map((n) => BigInt(n)) } }] },
      select: { id: true, fullName: true, phone: true, role: true, status: true, mergedIntoId: true, amoContactId: true },
    });
    for (const b of brokers) console.log(`  карточка: ${b.fullName} | ${b.id} | ${b.role}/${b.status} | тел. ${mask(b.phone)} | amoContactId ${b.amoContactId ?? "—"} | слита ${b.mergedIntoId ?? "—"}`);
    const targets = brokers.filter((b) => !b.mergedIntoId && b.role === "BROKER");
    if (targets.length !== 1) { console.log(`Карточек-кандидатов: ${targets.length} — нужно решение вручную, ничего не пишу.`); return; }
    const t = targets[0];
    if (String(t.amoContactId || "") === String(chosen.id)) { console.log("Уже привязана к выбранному контакту."); return; }
    console.log(`План: Broker ${t.id} amoContactId ${t.amoContactId ?? "—"} → ${chosen.id}`);
    if (dryRun) { console.log("DRY-RUN: ничего не записано."); return; }
    await prisma.broker.update({ where: { id: t.id }, data: { amoContactId: BigInt(chosen.id) } });
    console.log("RESULT: " + JSON.stringify({ brokerId: t.id, amoContactId: String(chosen.id) }));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
}
