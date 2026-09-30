#!/usr/bin/env node
/**
 * 2026-09-30, решение владельца: шесть новостей с сайта stmichael.ru снять с
 * лендинга — поставить статус согласования REJECTED («Отклонена»). Строки НЕ
 * удаляются: в админке «Лендинг → Новости» они видны в фильтре «Отклонённые»,
 * вернуть любую можно кнопкой «Опубликовать». Остальные новости (на 30.09 —
 * 14 штук) остаются APPROVED, скрипт их не трогает.
 *
 * Поиск — по нормализованному заголовку: без кавычек («»"'“”„), без учёта
 * регистра и лишних пробелов, ё = е; совпадение точное. По каждому заголовку
 * печатается «найдено»/«не найдено»/«уже скрыта». Если ни одного не найдено —
 * это ошибка (не та база или заголовки изменились).
 *
 * DRY_RUN=1 по умолчанию: запись выполняется внутри транзакции и откатывается
 * после проверки (ловим ошибки записи, до которых обычный dry-run не доходит).
 * Боевой режим: DRY_RUN=0 CONFIRM=1.
 */
const DRY_RUN = process.env.DRY_RUN !== "0";
const CONFIRMED = process.env.CONFIRM === "1" || process.env.CONFIRM === "true";
const WRITE = !DRY_RUN && CONFIRMED;

const MODERATED_BY = "apply-news-hide-2026-09-30 (решение владельца 30.09)";

/** Заголовки к скрытию — как на сайте stmichael.ru/news на 30.09.2026. */
const TITLES_TO_HIDE = [
  "На Ходынке открылась Детская Академия падела",
  "Джазовый вечер под открытым небом в «Зорге 9»",
  "Время открытий: как в «Зорге 9» встретили новый учебный год",
  "С Днем строителя!",
  "TURONE — новый адрес мужского стиля в Москве",
  "Более 12 событий за месяц: в «Зорге 9» запустили программу для взрослых и детей",
];

class Rollback extends Error {
  constructor() {
    super("dry-run rollback");
    this.name = "Rollback";
  }
}

/** Нормализация заголовка: без кавычек, регистра, лишних пробелов; ё → е. */
function normalizeTitle(value) {
  return String(value || "")
    .replace(/[«»"'“”„‟‘’‚‹›]/g, "")
    .replace(/ё/gi, (ch) => (ch === "Ё" ? "Е" : "е"))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * План (чистая функция, без записи): для каждого заголовка — найденные строки
 * (по нормализованному совпадению) и решение: скрыть / уже скрыта / не найдено.
 */
function buildPlan(rows, titles = TITLES_TO_HIDE) {
  const byNorm = new Map();
  for (const row of rows) {
    const key = normalizeTitle(row.title);
    if (!byNorm.has(key)) byNorm.set(key, []);
    byNorm.get(key).push(row);
  }
  const entries = titles.map((title) => {
    const matches = byNorm.get(normalizeTitle(title)) || [];
    const toHide = matches.filter((r) => r.moderationStatus !== "REJECTED");
    const already = matches.filter((r) => r.moderationStatus === "REJECTED");
    return { title, matches, toHide, already };
  });
  const hideIds = [...new Set(entries.flatMap((e) => e.toHide.map((r) => r.id)))];
  const notFound = entries.filter((e) => !e.matches.length).map((e) => e.title);
  const remainApproved = rows.filter((r) => r.moderationStatus === "APPROVED" && !hideIds.includes(r.id));
  return { entries, hideIds, notFound, remainApproved };
}

const fmtRow = (r) =>
  `${r.moderationStatus || "APPROVED"}${r.isActive === false ? " · неактивна" : ""} · ${r.source || "—"} · ${
    r.publishedAt ? new Date(r.publishedAt).toISOString().slice(0, 10) : "—"
  } · «${r.title}» · id=${r.id}`;

/**
 * Основная логика на переданном prisma (в тесте — фальшивый). Возвращает
 * итог; в dry-run транзакция откатывается.
 */
async function run(prisma, { write = WRITE, titles = TITLES_TO_HIDE, log = console.log, error = console.error } = {}) {
  log(`=== Скрыть 6 новостей сайта (решение владельца 30.09.2026) ===`);
  log(`режим: ${write ? "APPLY (запись)" : "DRY-RUN (транзакция с откатом)"}`);

  const rows = await prisma.landingNews.findMany({
    orderBy: [{ publishedAt: "desc" }, { sortOrder: "asc" }],
  });
  log(`\n--- Новостей в базе: ${rows.length}`);
  const plan = buildPlan(rows, titles);

  log(`\n--- Поиск по заголовкам`);
  for (const e of plan.entries) {
    if (!e.matches.length) {
      log(`  НЕ НАЙДЕНО  «${e.title}»`);
      continue;
    }
    for (const r of e.toHide) log(`  СКРЫТЬ      ${fmtRow(r)}`);
    for (const r of e.already) log(`  УЖЕ СКРЫТА  ${fmtRow(r)}`);
    if (e.matches.length > 1) log(`  ! у «${e.title}» ${e.matches.length} строки с таким заголовком — скрываю все`);
  }
  log(`\n  к скрытию: ${plan.hideIds.length} · не найдено: ${plan.notFound.length} · останется APPROVED: ${plan.remainApproved.length}`);
  for (const r of plan.remainApproved) log(`  ОСТАЁТСЯ    ${fmtRow(r)}`);

  if (plan.notFound.length === titles.length) {
    error(`\n✗ Ни один заголовок не найден — не та база или заголовки изменились. Ничего не пишу.`);
    return { ok: false, plan, hidden: 0 };
  }
  if (!plan.hideIds.length) {
    log(`\nСкрывать нечего: всё уже скрыто${plan.notFound.length ? ` (не найдено: ${plan.notFound.length})` : ""}.`);
    return { ok: true, plan, hidden: 0 };
  }

  let hidden = 0;
  try {
    await prisma.$transaction(
      async (tx) => {
        const res = await tx.landingNews.updateMany({
          where: { id: { in: plan.hideIds }, moderationStatus: { not: "REJECTED" } },
          data: { moderationStatus: "REJECTED", moderatedAt: new Date(), moderatedBy: MODERATED_BY },
        });
        hidden = res.count;
        if (hidden !== plan.hideIds.length) {
          throw new Error(`обновлено ${hidden} строк, ожидалось ${plan.hideIds.length}`);
        }
        // Проверка внутри транзакции: скрытые — REJECTED, остальные APPROVED не тронуты.
        const after = await tx.landingNews.findMany({ where: { id: { in: plan.hideIds } } });
        const bad = after.filter((r) => r.moderationStatus !== "REJECTED");
        if (bad.length) throw new Error(`после записи не REJECTED: ${bad.map((r) => r.id).join(", ")}`);
        const approvedAfter = await tx.landingNews.count({ where: { moderationStatus: "APPROVED" } });
        if (approvedAfter !== plan.remainApproved.length) {
          throw new Error(`APPROVED после записи ${approvedAfter}, ожидалось ${plan.remainApproved.length}`);
        }
        if (!write) throw new Rollback();
      },
      { timeout: 20000 },
    );
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  log(`\n  скрыто: ${hidden}${write ? "" : " (внутри транзакции, откачено)"} · останется APPROVED: ${plan.remainApproved.length}`);
  if (write) log(`\nЗАПИСЬ ВЫПОЛНЕНА.`);
  else log(`\nПРОГОН БЕЗ ЗАПИСИ: транзакция откачена, проверки прошли (нужны DRY_RUN=0 и CONFIRM=1).`);
  return { ok: true, plan, hidden };
}

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const result = await run(prisma);
    if (!result.ok) process.exit(2);
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = { normalizeTitle, buildPlan, run, main, TITLES_TO_HIDE, MODERATED_BY };

if (require.main === module) {
  main().catch((e) => {
    console.error("FATAL:", e?.message || e);
    process.exit(1);
  });
}
