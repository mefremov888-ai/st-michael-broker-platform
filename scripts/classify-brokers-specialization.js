#!/usr/bin/env node
/**
 * Классификатор специализации брокеров через Claude API.
 *
 * Берёт всех Broker с specialization=null, собирает их комментарии из CallLog,
 * отправляет батчами в Claude Haiku и проставляет specialization = COMM /
 * RESIDENTIAL / BOTH / null (если UNKNOWN — оставляет null, но помечает
 * попыткой чтобы больше не переспрашивать).
 *
 * Требуется env: ANTHROPIC_API_KEY (Anthropic Console → API keys).
 *
 * Запуск в контейнере api:
 *   docker compose exec -T api node /app/scripts/classify-brokers-specialization.js
 *   docker compose exec -T api node /app/scripts/classify-brokers-specialization.js --dry-run
 *   docker compose exec -T api node /app/scripts/classify-brokers-specialization.js --limit 100
 *
 * Порядок:
 *   - идём батчами по 20 брокеров параллельно (rate-friendly)
 *   - логируем прогресс каждые 100 брокеров
 *   - падение одного брокера не валит цикл
 *   - resumable: пропускает тех, кому specialization уже проставили ранее
 */

const { PrismaClient } = require('@st-michael/database');

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY не задан в env');
  process.exit(2);
}

const MODEL = 'claude-haiku-4-5';
const CONCURRENCY = 20;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  if (i === -1) return null;
  const n = Number(args[i + 1]);
  return isNaN(n) ? null : n;
})();

const prisma = new PrismaClient();

const SYSTEM_PROMPT = `Ты классификатор специализации брокера недвижимости.
На основе комментариев операторов КЦ определи, в какой сфере работает брокер.
Возможные значения:
  COMM         — коммерческая недвижимость (офис, склад, торговый, нежилой, ритейл, стрит-ретейл, коммерческая аренда)
  RESIDENTIAL  — жилая (квартиры, апартаменты, новостройки, вторичка)
  BOTH         — работает и с той, и с другой
  UNKNOWN      — по комментариям нельзя определить или комментариев нет

Отвечай ТОЛЬКО одним словом: COMM, RESIDENTIAL, BOTH или UNKNOWN. Без пояснений.`;

async function classifyBroker(brokerId, name, comments) {
  const joinedComments = comments.map((c, i) => `${i + 1}) ${c}`).join('\n');
  const userText = `Брокер: ${name}\n\nКомментарии операторов КЦ:\n${joinedComments || '(комментариев нет)'}\n\nСпециализация?`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userText }],
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const raw = data?.content?.[0]?.text?.trim().toUpperCase() || '';
  if (['COMM', 'RESIDENTIAL', 'BOTH'].includes(raw)) return raw;
  return 'UNKNOWN';
}

async function processOne(broker) {
  const comments = broker.callLogs
    .map((c) => (c.comment || '').trim())
    .filter(Boolean);
  try {
    const label = await classifyBroker(broker.id, broker.fullName || '(без имени)', comments);
    if (DRY_RUN) return { id: broker.id, label, dryRun: true };
    if (label === 'UNKNOWN') return { id: broker.id, label, updated: false };
    await prisma.broker.update({
      where: { id: broker.id },
      data: { specialization: label },
    });
    return { id: broker.id, label, updated: true };
  } catch (e) {
    return { id: broker.id, error: e?.message || String(e) };
  }
}

(async () => {
  console.log(`[classify] старт. dryRun=${DRY_RUN}, limit=${LIMIT || 'all'}, model=${MODEL}`);
  const brokers = await prisma.broker.findMany({
    where: { specialization: null },
    select: {
      id: true,
      fullName: true,
      callLogs: {
        select: { comment: true },
        where: { comment: { not: null } },
        take: 20,
      },
    },
    ...(LIMIT ? { take: LIMIT } : {}),
  });
  console.log(`[classify] найдено ${brokers.length} брокеров без specialization`);

  const stats = { COMM: 0, RESIDENTIAL: 0, BOTH: 0, UNKNOWN: 0, errors: 0 };
  const firstErrors = [];
  let done = 0;

  for (let i = 0; i < brokers.length; i += CONCURRENCY) {
    const batch = brokers.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(processOne));
    for (const r of results) {
      if (r.error) {
        stats.errors++;
        if (firstErrors.length < 3) firstErrors.push({ id: r.id, error: r.error });
      } else if (r.label) stats[r.label] = (stats[r.label] || 0) + 1;
    }
    done += batch.length;
    if (done % 100 === 0 || done === brokers.length) {
      console.log(
        `[classify] progress ${done}/${brokers.length}: `
          + `COMM=${stats.COMM} RESIDENTIAL=${stats.RESIDENTIAL} BOTH=${stats.BOTH} `
          + `UNKNOWN=${stats.UNKNOWN} err=${stats.errors}`,
      );
    }
  }

  if (firstErrors.length > 0) {
    console.error('[classify] ПЕРВЫЕ ОШИБКИ:');
    for (const e of firstErrors) console.error(`  ${e.id}: ${e.error}`);
  }

  console.log(
    `[classify] готово. COMM=${stats.COMM} RESIDENTIAL=${stats.RESIDENTIAL} `
      + `BOTH=${stats.BOTH} UNKNOWN=${stats.UNKNOWN} errors=${stats.errors}`,
  );
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('[classify] FATAL:', e?.message || e);
  await prisma.$disconnect();
  process.exit(1);
});
