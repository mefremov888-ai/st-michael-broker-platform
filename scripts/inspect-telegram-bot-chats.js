#!/usr/bin/env node
/**
 * 2026-09-29: инспектор бота кабинета для новостей из Telegram-канала.
 * Нужен, чтобы узнать chat.id закрытого канала (у него нет @username, а
 * ссылка-приглашение id не содержит) и убедиться, что бот вообще видит посты.
 *
 * Печатает (только чтение, токен не выводится):
 *   1. getMe — какой бот стоит за токеном (username, id);
 *   2. getWebhookInfo — на боте не должно быть webhook (иначе getUpdates → 409);
 *   3. getUpdates без offset — что ещё не подтверждено поллером api
 *      (обычно пусто: OpsInboxService забирает апдейты раз в 20 с);
 *   4. из БД: последний канал, который видел приём новостей
 *      (SystemSetting TELEGRAM_NEWS_LAST_CHAT), настроенный TELEGRAM_NEWS_CHAT_ID,
 *      каналы в landing_news и чаты в ops_inbox_messages.
 *
 * Использование (внутри контейнера api):
 *   docker compose exec -T api node /app/scripts/inspect-telegram-bot-chats.js
 *
 * Нужны env: OPS_TELEGRAM_BOT_TOKEN или TELEGRAM_BOT_TOKEN (тот же выбор, что
 * у OpsInboxService), DATABASE_URL, TELEGRAM_API_BASE (необязательно).
 *
 * ВАЖНО: allowed_updates в getUpdates здесь НЕ передаём — этот параметр
 * запоминается сервером Telegram и сбил бы настройку поллера api.
 */

const TOKEN = (process.env.OPS_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "").trim();
const API_BASE = (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");

function mask(text) {
  return String(text).replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot***");
}

async function tg(method, query = "") {
  const url = `${API_BASE}/bot${TOKEN}/${method}${query}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const payload = await response.json().catch(() => null);
    return { status: response.status, payload };
  } catch (error) {
    return { status: 0, payload: { error: mask(error && error.message ? error.message : String(error)) } };
  } finally {
    clearTimeout(timer);
  }
}

function describeChat(chat) {
  if (!chat) return "(нет chat)";
  const title = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || "";
  return `chat.id=${chat.id} type=${chat.type} title=${JSON.stringify(title)}`;
}

async function inspectTelegram() {
  if (!TOKEN) {
    console.log("Токен бота не задан (OPS_TELEGRAM_BOT_TOKEN / TELEGRAM_BOT_TOKEN) — часть с Telegram пропущена.");
    return;
  }
  console.log(`Telegram API: ${API_BASE}`);

  const me = await tg("getMe");
  if (me.payload && me.payload.ok) {
    const r = me.payload.result;
    console.log(`\n=== 1. Бот ===\n  @${r.username} (id=${r.id}, name=${JSON.stringify(r.first_name || "")})`);
  } else {
    console.log(`\n=== 1. Бот ===\n  getMe не удался: HTTP ${me.status} ${JSON.stringify(me.payload).slice(0, 200)}`);
  }

  const hook = await tg("getWebhookInfo");
  if (hook.payload && hook.payload.ok) {
    const r = hook.payload.result;
    console.log(`\n=== 2. Webhook ===\n  url=${JSON.stringify(r.url || "")} pending=${r.pending_update_count || 0} allowed=${JSON.stringify(r.allowed_updates || [])}`);
    if (r.url) console.log("  ВНИМАНИЕ: webhook установлен — поллер api будет получать 409. Снимите его (deleteWebhook).");
  } else {
    console.log(`\n=== 2. Webhook ===\n  getWebhookInfo не удался: HTTP ${hook.status}`);
  }

  const updates = await tg("getUpdates", "?timeout=0&limit=100");
  console.log("\n=== 3. Неподтверждённые апдейты (getUpdates без offset) ===");
  if (!(updates.payload && updates.payload.ok)) {
    console.log(`  getUpdates не удался: HTTP ${updates.status} ${JSON.stringify(updates.payload).slice(0, 200)}`);
    if (updates.status === 409) console.log("  409 = у бота webhook или одновременный getUpdates; поллер api при timeout=0 обычно не мешает — повторите через минуту.");
  } else {
    const list = Array.isArray(updates.payload.result) ? updates.payload.result : [];
    if (!list.length) console.log("  (пусто — поллер api уже всё забрал; смотрите раздел 4)");
    const seen = new Map();
    for (const u of list) {
      const kind = ["channel_post", "edited_channel_post", "message", "edited_message", "my_chat_member"].find((k) => u[k]);
      const msg = kind ? u[kind] : null;
      const chat = msg && msg.chat;
      const key = chat ? String(chat.id) : "?";
      const prev = seen.get(key) || { chat, kinds: new Set(), count: 0, last: null };
      prev.kinds.add(kind || Object.keys(u).filter((k) => k !== "update_id").join("|"));
      prev.count += 1;
      prev.last = msg ? new Date((msg.date || 0) * 1000).toISOString() : null;
      seen.set(key, prev);
    }
    for (const [, info] of seen) {
      console.log(`  ${describeChat(info.chat)} · апдейтов=${info.count} · виды=${[...info.kinds].join(",")} · последний=${info.last}`);
    }
  }
}

async function inspectDatabase() {
  console.log("\n=== 4. Что видел приём новостей (БД) ===");
  let prisma;
  try {
    const { PrismaClient } = require("@st-michael/database");
    prisma = new PrismaClient();
    const settings = await prisma.systemSetting.findMany({
      where: { key: { in: ["TELEGRAM_NEWS_CHAT_ID", "TELEGRAM_NEWS_LAST_CHAT", "OPS_INBOX_UPDATE_OFFSET"] } },
    });
    const byKey = Object.fromEntries(settings.map((s) => [s.key, s]));
    const configured = (byKey.TELEGRAM_NEWS_CHAT_ID && byKey.TELEGRAM_NEWS_CHAT_ID.value) || process.env.TELEGRAM_NEWS_CHAT_ID || "";
    console.log(`  TELEGRAM_NEWS_CHAT_ID: ${configured ? configured : "(не задан — принимаются посты из любого канала, куда добавлен бот)"}`);
    if (byKey.TELEGRAM_NEWS_LAST_CHAT) {
      console.log(`  последний канал, увиденный приёмом: ${byKey.TELEGRAM_NEWS_LAST_CHAT.value} (обновлено ${byKey.TELEGRAM_NEWS_LAST_CHAT.updatedAt.toISOString()})`);
    } else {
      console.log("  приём новостей ещё не видел ни одного поста канала (бот не добавлен в канал или постов после добавления не было)");
    }
    if (byKey.OPS_INBOX_UPDATE_OFFSET) {
      console.log(`  поллер api: offset=${byKey.OPS_INBOX_UPDATE_OFFSET.value}, обновлён ${byKey.OPS_INBOX_UPDATE_OFFSET.updatedAt.toISOString()}`);
    }

    const news = await prisma.$queryRawUnsafe(`
      SELECT telegram_chat_id AS chat_id, COUNT(*)::int AS novostey,
             MIN(published_at)::date AS pervaya, MAX(published_at)::date AS poslednyaya,
             COUNT(*) FILTER (WHERE image_url IS NOT NULL)::int AS s_oblozhkoy
      FROM landing_news WHERE telegram_chat_id IS NOT NULL
      GROUP BY telegram_chat_id ORDER BY MAX(published_at) DESC`);
    console.log("  каналы в landing_news:");
    if (!news.length) console.log("    (пусто)");
    for (const r of news) console.log(`    ${Object.entries(r).map(([k, v]) => `${k}=${v instanceof Date ? v.toISOString().slice(0, 10) : v}`).join(" · ")}`);

    const inbox = await prisma.$queryRawUnsafe(`
      SELECT chat_id, MAX(chat_title) AS title, COUNT(*)::int AS soobshcheniy, MAX(sent_at) AS poslednee
      FROM ops_inbox_messages GROUP BY chat_id ORDER BY MAX(sent_at) DESC LIMIT 20`);
    console.log("  чаты, писавшие боту (ops_inbox_messages):");
    if (!inbox.length) console.log("    (пусто)");
    for (const r of inbox) console.log(`    chat.id=${r.chat_id} title=${JSON.stringify(r.title || "")} · сообщений=${r.soobshcheniy} · последнее=${r.poslednee instanceof Date ? r.poslednee.toISOString() : r.poslednee}`);
  } catch (error) {
    console.log(`  БД недоступна: ${mask(error && error.message ? error.message : String(error))}`);
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
  }
}

async function main() {
  await inspectTelegram();
  await inspectDatabase();
  console.log("\nГотово. Если канал не виден: проверьте, что бот добавлен в канал администратором и после этого в канале был хотя бы один новый пост.");
}

main().catch((error) => {
  console.error(mask(error && error.stack ? error.stack : String(error)));
  process.exit(1);
});
