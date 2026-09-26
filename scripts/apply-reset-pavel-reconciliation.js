#!/usr/bin/env node
/**
 * 2026-09-26: разовый сброс ОДНОЙ зависшей заявки (Павел, Серебряный Бор,
 * client.id=f0e2c386-4c52-4a61-99ea-360382d3a08a), застрявшей с
 * AMO_CREATE_RECONCILIATION_REQUIRED:AMO_NETWORK_ERROR. Инспектор
 * (inspect-pavel-reconciliation.js) подтвердил: контакта клиента в amo нет —
 * лид не создался, сеть оборвалась до записи. Безопасно повторить.
 *
 * Перед записью ЕЩЁ РАЗ проверяем в amo, что контакта по-прежнему нет
 * (на случай, если что-то изменилось между инспекцией и запуском) — иначе
 * отказываемся сбрасывать и просим ручной разбор.
 *
 * Сброс: amoSyncStatus=PENDING, amoSyncError=null, amoSyncAttempts=0 —
 * попадает обратно в обычную очередь автоповтора (крон каждые 5 минут),
 * лид создаётся штатным путём, не этим скриптом.
 *
 * DRY_RUN=1 (по умолчанию) — только план. APPLY=1 — запись.
 */
const CLIENT_ID = "f0e2c386-4c52-4a61-99ea-360382d3a08a";
const EXPECTED_ERROR = "AMO_CREATE_RECONCILIATION_REQUIRED:AMO_NETWORK_ERROR";
const APPLY = process.env.APPLY === "1";

async function main() {
  const { AmoCrmAdapter, setAmoTokens, setAmoTokenRefreshHook } = require("/app/packages/integrations/dist/amo-crm.adapter");
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const client = await prisma.client.findUnique({
      where: { id: CLIENT_ID },
      select: { id: true, fullName: true, phone: true, amoLeadId: true, amoSyncStatus: true, amoSyncError: true, amoSyncAttempts: true },
    });
    if (!client) throw new Error("Клиент не найден");
    if (client.amoLeadId) throw new Error("У клиента уже есть amoLeadId — это не тот случай, останавливаюсь");
    if (client.amoSyncError !== EXPECTED_ERROR) {
      throw new Error(`Ошибка изменилась с момента инспекции (сейчас: ${client.amoSyncError}) — останавливаюсь, нужен новый разбор`);
    }
    console.log(`Клиент: ${client.fullName} | статус ${client.amoSyncStatus} | ошибка ${client.amoSyncError} | попыток ${client.amoSyncAttempts}`);

    const rows = await prisma.systemSetting.findMany({ where: { key: { in: ["AMO_ACCESS_TOKEN", "AMO_REFRESH_TOKEN"] } }, select: { key: true, value: true } });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    setAmoTokens(byKey.get("AMO_ACCESS_TOKEN") || "", byKey.get("AMO_REFRESH_TOKEN") || "");
    setAmoTokenRefreshHook(async (tokens) => {
      for (const [key, value] of [["AMO_ACCESS_TOKEN", tokens.access], ["AMO_REFRESH_TOKEN", tokens.refresh]]) {
        await prisma.systemSetting.upsert({ where: { key }, update: { value, updatedBy: "apply" }, create: { key, value, updatedBy: "apply" } });
      }
    });
    const amo = new AmoCrmAdapter();
    const contact = await amo.findContactByPhone(client.phone, { strict: false });
    if (contact) {
      throw new Error(`СТОП: контакт #${contact.id} «${contact.name}» уже появился в amo — не сбрасываю, нужна привязка вручную, не пересоздание`);
    }
    console.log("Повторная проверка: контакта в amo по-прежнему нет — безопасно сбрасывать.");

    if (!APPLY) {
      console.log("\n=== DRY-RUN: ничего не записано ===");
      console.log("План: amoSyncStatus PENDING, amoSyncError null, amoSyncAttempts 0");
      return;
    }
    const updated = await prisma.client.updateMany({
      where: { id: CLIENT_ID, amoLeadId: null, amoSyncError: EXPECTED_ERROR },
      data: { amoSyncStatus: "PENDING", amoSyncError: null, amoSyncAttempts: 0 },
    });
    console.log(`\n=== APPLY: обновлено строк ${updated.count} ===`);
    if (updated.count !== 1) throw new Error("Обновилось не ровно 1 строка — проверить вручную");
    console.log("Готово. Ближайший автоповтор (каждые 5 минут) создаст лид штатным путём.");
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
