#!/usr/bin/env node
/**
 * 2026-09-24: разовая проверка СМС Центра после подключения — баланс и
 * тестовая отправка одного из четырёх согласованных текстов на указанный
 * номер. Логика повторяет apps/api/src/sms/sms.service.ts (getSettings +
 * SmscAdapter), но напрямую, без поднятия всего Nest-приложения.
 *
 * Баланс всегда проверяется (только чтение). Отправка — только при APPLY=1.
 * Вход (env): PHONE (+7XXXXXXXXXX), SAMPLE (LOGIN_CODE|REGISTER_CODE|
 * PASSWORD_RESET_CODE|FIXATION_EXPIRY), APPLY (1 — отправить, иначе только
 * баланс и план).
 */
const APPLY = process.env.APPLY === "1";
const PHONE = String(process.env.PHONE || "").trim();
const SAMPLE = String(process.env.SAMPLE || "LOGIN_CODE").trim();

async function main() {
  if (!/^\+7\d{10}$/.test(PHONE)) throw new Error(`PHONE должен быть в формате +7XXXXXXXXXX, получено: ${PHONE || "(пусто)"}`);

  const { PrismaClient } = require("@st-michael/database");
  const { SmscAdapter } = require("@st-michael/integrations");
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.systemSetting.findMany({
      where: { key: { in: ["SMSC_LOGIN", "SMSC_API_KEY", "SMSC_SENDER"] } },
      select: { key: true, value: true },
    });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const login = (byKey.get("SMSC_LOGIN") || process.env.SMSC_LOGIN || "").trim();
    const apiKey = (byKey.get("SMSC_API_KEY") || process.env.SMSC_API_KEY || "").trim();
    const sender = (byKey.get("SMSC_SENDER") || process.env.SMSC_SENDER || "").trim();
    console.log(`Источник настроек: логин из ${byKey.get("SMSC_LOGIN") ? "БД" : "env"}, ключ из ${byKey.get("SMSC_API_KEY") ? "БД" : "env"}, отправитель ${sender || "(по умолчанию аккаунта)"}`);
    if (!login || !apiKey) throw new Error("SMSC_LOGIN/SMSC_API_KEY не заданы ни в БД, ни в env");

    const adapter = new SmscAdapter({ login, apiKey, sender });

    console.log("\n=== Баланс СМС Центра (через psw=ключ) ===");
    const balance = await adapter.getBalance();
    console.log(balance.ok ? `Баланс: ${balance.balance} ${balance.currency || ""}` : `Ошибка: ${balance.error}`);

    // 2026-09-24: диагностика — smsc.ru может ожидать API-ключ в отдельном
    // параметре apikey, а не в psw (psw — это пароль аккаунта, apikey — новый
    // способ авторизации). Пробуем оба варианта, чтобы понять, какой рабочий.
    for (const variant of [
      { label: "login+psw", params: { login, psw: apiKey } },
      { label: "login+apikey", params: { login, apikey: apiKey } },
      { label: "apikey (без login)", params: { apikey: apiKey } },
    ]) {
      try {
        const r = await fetch("https://smsc.ru/sys/balance.php", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
          body: new URLSearchParams({ ...variant.params, cur: "1", fmt: "3" }).toString(),
          signal: AbortSignal.timeout(15000),
        });
        const text = await r.text();
        console.log(`  [${variant.label}] HTTP ${r.status}: ${text}`);
      } catch (e) {
        console.log(`  [${variant.label}] сеть: ${e?.message || e}`);
      }
    }

    if (!APPLY) {
      console.log(`\n=== DRY-RUN: отправка НЕ выполнена (APPLY!=1) ===`);
      console.log(`План: вид ${SAMPLE} → номер ${PHONE.slice(0, 5)}***${PHONE.slice(-2)}`);
      return;
    }

    const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
    const TEXT_BY_SAMPLE = {
      LOGIN_CODE: `Код входа в кабинет брокера: ${code}. Никому не сообщайте.`,
      REGISTER_CODE: `Код подтверждения номера: ${code}. Действует 10 минут.`,
      PASSWORD_RESET_CODE: `Код для смены пароля: ${code}. Если это не вы — не вводите его.`,
      FIXATION_EXPIRY: `Закрепление клиента Иванов А. истекает 20.10. Продлить — в кабинете.`,
    };
    const text = TEXT_BY_SAMPLE[SAMPLE];
    if (!text) throw new Error(`Неизвестный SAMPLE: ${SAMPLE}`);

    console.log(`\n=== Отправка (${SAMPLE}) на ${PHONE.slice(0, 5)}***${PHONE.slice(-2)} ===`);
    const res = await adapter.send(PHONE, text);
    if (res.ok) {
      console.log(`OK: id у СМС Центра ${res.id}, частей ${res.parts ?? "?"}, стоимость ${res.cost ?? "?"}`);
      // Пишем в тот же журнал, что и обычные отправки — чтобы тест был виден в админке.
      await prisma.smsMessage.create({
        data: {
          phone: PHONE,
          kind: "TEST",
          text: text.replace(/\b\d{6}\b/g, "••••••"),
          status: "SENT",
          providerId: res.id,
          parts: res.parts ?? null,
          cost: res.cost ?? null,
          sentAt: new Date(),
        },
      });
    } else {
      console.log(`ОШИБКА: ${res.errorCode ? `[${res.errorCode}] ` : ""}${res.error}`);
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
