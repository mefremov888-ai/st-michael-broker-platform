#!/usr/bin/env node
/**
 * 2026-09-08: записать/обновить одну запись SystemSetting (KEY/VALUE из env).
 * Значение в лог не печатается (только длина). Используется для
 * OPS_INBOX_TOKEN (доступ рабочей сессии ассистента к входящим ops-бота).
 */
async function main() {
  const key = String(process.env.SETTING_KEY || "").trim();
  const value = String(process.env.SETTING_VALUE || "");
  if (!key) throw new Error("SETTING_KEY пуст");
  if (!value) throw new Error("SETTING_VALUE пуст");
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const before = await prisma.systemSetting.findUnique({ where: { key } });
    await prisma.systemSetting.upsert({ where: { key }, update: { value, updatedBy: "ops-set-system-setting" }, create: { key, value, updatedBy: "ops-set-system-setting" } });
    console.log(`${key}: ${before ? "обновлено" : "создано"}; длина значения ${value.length}`);
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
