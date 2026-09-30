#!/usr/bin/env node
/**
 * 2026-09-30, решение владельца: в разделе «Условия сотрудничества» (публичная
 * выдача GET /api/public/documents?category=cooperation) остаются ровно два
 * документа:
 *   1. «Условия сотрудничества сентябрь» — как есть;
 *   2. «Калькулятор рассрочки: Серебряный Бор, Зорге 9, машино-места» — новая
 *      HTML-страница из seed-data/documents/calculator-rassrochki-2026-09.html,
 *      она заменяет «Условия рассрочки Квартал Серебряный бор».
 *
 * «Условия рассрочки Квартал Серебряный бор», «Условия вознаграждения для
 * брокеров на август 2026 г.» и «Условия вознаграждения партнёром St Michael»
 * снимаются с публикации (isPublic=false). Файлы и строки НЕ удаляются —
 * в админке они остаются видны и их можно вернуть одной галочкой.
 *
 * Что делает скрипт:
 *   - проверяет исходный HTML (размер, doctype, блок условий, внешние скрипты
 *     только с cdnjs) и считает sha256;
 *   - в боевом режиме копирует HTML в каталог загрузок (UPLOADS_DIR/cooperation/);
 *   - в одной транзакции: снимает с публикации лишние документы, создаёт или
 *     обновляет строку калькулятора (upsert по маркеру в description, запасной
 *     ключ — fileUrl), ставит его сразу после «Условий сотрудничества» и
 *     ПРОВЕРЯЕТ внутри транзакции, что публичных документов ровно два;
 *   - в сухом прогоне те же записи выполняются внутри транзакции и откатываются
 *     (чтобы поймать ошибки записи, до которых обычный dry-run не доходит).
 *
 * Повторный запуск дублей не плодит. Если среди публичных документов раздела
 * есть что-то, чего нет в решении владельца, скрипт останавливается и ничего
 * не пишет — такое надо решать руками.
 *
 * DRY_RUN=1 по умолчанию. Боевой режим: DRY_RUN=0 CONFIRM=1.
 * SOURCE_HTML — путь к исходному HTML внутри контейнера (кладёт workflow).
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const UPLOADS = process.env.UPLOADS_DIR || "/app/uploads";
const SOURCE_HTML =
  process.env.SOURCE_HTML || "/app/scripts/seed-documents/calculator-rassrochki-2026-09.html";
const DRY_RUN = process.env.DRY_RUN !== "0";
const CONFIRMED = process.env.CONFIRM === "1" || process.env.CONFIRM === "true";
const WRITE = !DRY_RUN && CONFIRMED;

const CATEGORY = "cooperation";
const CALC_FILE = "calculator-rassrochki-2026-09.html";
const CALC = {
  name: "Калькулятор рассрочки: Серебряный Бор, Зорге 9, машино-места",
  description: "[seed:cooperation-calculator-rassrochki-2026-09]",
  type: "HTML",
  category: CATEGORY,
  fileUrl: `/files/${CATEGORY}/${CALC_FILE}`,
  isPublic: true,
};
const KEEP_RE = /условия\s+сотрудничества/i;
const HIDE_RES = [
  /условия\s+рассрочки/i,
  /вознаграждения\s+для\s+брокеров/i,
  /вознаграждения\s+партн/i,
];
const ALLOWED_SCRIPT_HOSTS = ["https://cdnjs.cloudflare.com/"];

class Rollback extends Error {
  constructor() {
    super("dry-run rollback");
    this.name = "Rollback";
  }
}

/**
 * План по списку документов категории cooperation (чистая функция — на ней
 * держится тест). Ничего не пишет.
 */
function buildPlan(docs) {
  const isCalc = (d) => d.description === CALC.description || d.fileUrl === CALC.fileUrl;
  const calcCandidates = docs.filter(isCalc);
  const calcExisting = calcCandidates.find((d) => d.description === CALC.description) || calcCandidates[0] || null;
  const rest = docs.filter((d) => d !== calcExisting);

  const keepCandidates = rest.filter((d) => KEEP_RE.test(d.name || ""));
  const keep = keepCandidates.find((d) => d.isPublic) || keepCandidates[0] || null;

  const hide = [];
  const unexpected = [];
  for (const d of rest) {
    if (d === keep) continue;
    if (!d.isPublic) continue; // уже скрыт — не трогаем
    if (HIDE_RES.some((re) => re.test(d.name || ""))) hide.push(d);
    else unexpected.push(d);
  }
  // Второй публичный документ с «Условия сотрудничества» в названии (старый
  // выпуск) не подходит под HIDE_RES и тоже попадает в unexpected — владелец
  // оставляет один.

  const calcSortOrder = keep ? (Number(keep.sortOrder) || 0) + 1 : 10;
  return { keep, hide, unexpected, calcExisting, calcSortOrder, calcDuplicates: calcCandidates.filter((d) => d !== calcExisting) };
}

function inspectHtml(file) {
  if (!fs.existsSync(file)) throw new Error(`исходный HTML не найден: ${file}`);
  const buf = fs.readFileSync(file);
  const text = buf.toString("utf8");
  const problems = [];
  if (buf.length < 100 * 1024) problems.push(`слишком маленький файл: ${buf.length} байт`);
  if (!/^\s*<!doctype html>/i.test(text)) problems.push("нет <!doctype html> в начале");
  if (!/<script[^>]+id="conditions"/.test(text)) problems.push('нет блока <script id="conditions">');
  if (!/Сохранить PDF/.test(text)) problems.push("нет кнопки «Сохранить PDF» — это не калькулятор?");
  const srcs = [...new Set([...text.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/gi)].map((m) => m[1]))];
  for (const src of srcs) {
    if (!ALLOWED_SCRIPT_HOSTS.some((h) => src.startsWith(h))) problems.push(`внешний скрипт вне списка разрешённых: ${src}`);
  }
  if (/(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN (RSA|OPENSSH) PRIVATE KEY)/.test(text)) problems.push("похоже на секрет в тексте");
  return { size: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex"), scripts: srcs, problems, buf };
}

const fmtDoc = (d) =>
  `${d.isPublic ? "ПУБЛ" : "скрыт"} · sort=${d.sortOrder} · «${d.name}» · ${d.type} · ${d.fileUrl} · id=${d.id}`;

async function main() {
  console.log(`=== Условия сотрудничества: два документа (решение владельца 30.09.2026) ===`);
  console.log(`режим: ${WRITE ? "APPLY (запись)" : "DRY-RUN (транзакция с откатом)"}`);

  // 1. Исходный HTML
  const html = inspectHtml(SOURCE_HTML);
  console.log(`\n--- Исходный HTML: ${SOURCE_HTML}`);
  console.log(`  размер ${html.size} байт · sha256 ${html.sha256}`);
  console.log(`  внешние скрипты: ${html.scripts.join(", ") || "нет"}`);
  if (html.problems.length) {
    for (const p of html.problems) console.error(`  ✗ ${p}`);
    process.exit(2);
  }
  console.log("  ✓ проверки HTML пройдены");

  const targetPath = path.join(UPLOADS, CATEGORY, CALC_FILE);
  const targetExists = fs.existsSync(targetPath);
  const targetSame =
    targetExists && crypto.createHash("sha256").update(fs.readFileSync(targetPath)).digest("hex") === html.sha256;
  console.log(`  целевой файл: ${targetPath} — ${targetExists ? (targetSame ? "уже такой же" : "есть, будет перезаписан") : "нет, будет создан"}`);

  // 2. Документы раздела
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const docs = await prisma.document.findMany({
      where: { category: CATEGORY },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    });
    console.log(`\n--- Документы категории ${CATEGORY} сейчас: ${docs.length}`);
    for (const d of docs) console.log(`  ${fmtDoc(d)}`);

    const plan = buildPlan(docs);
    console.log(`\n--- План`);
    if (plan.keep) console.log(`  ОСТАВИТЬ  ${fmtDoc(plan.keep)}`);
    else console.log(`  ! «Условия сотрудничества» не найдены — калькулятор получит sort=${plan.calcSortOrder}`);
    for (const d of plan.hide) console.log(`  СКРЫТЬ    ${fmtDoc(d)}`);
    console.log(
      `  ${plan.calcExisting ? "ОБНОВИТЬ" : "СОЗДАТЬ "}  ПУБЛ · sort=${plan.calcSortOrder} · «${CALC.name}» · ${CALC.type} · ${CALC.fileUrl}${plan.calcExisting ? ` · id=${plan.calcExisting.id}` : ""}`,
    );
    for (const d of plan.calcDuplicates) console.log(`  ! дубль калькулятора, не трогаю: ${fmtDoc(d)}`);
    if (plan.unexpected.length) {
      console.error(`\n✗ В разделе есть публичные документы вне решения владельца — стоп, ничего не пишу:`);
      for (const d of plan.unexpected) console.error(`  ${fmtDoc(d)}`);
      process.exit(2);
    }
    if (plan.keep && !plan.keep.isPublic) {
      console.error(`\n✗ «${plan.keep.name}» снят с публикации — верните его в админке, потом запускайте снова.`);
      process.exit(2);
    }

    // 3. Файл (только в боевом режиме)
    if (WRITE && !targetSame) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, html.buf);
      const check = crypto.createHash("sha256").update(fs.readFileSync(targetPath)).digest("hex");
      if (check !== html.sha256) throw new Error(`файл записан с ошибкой: sha256 ${check} ≠ ${html.sha256}`);
      console.log(`\n✓ файл записан: ${targetPath}`);
    }

    // 4. База — одна транзакция, в dry-run откатывается после проверки
    const summary = { hidden: 0, calcId: null, created: false, publicAfter: [] };
    try {
      await prisma.$transaction(
        async (tx) => {
          if (plan.hide.length) {
            const r = await tx.document.updateMany({
              where: { id: { in: plan.hide.map((d) => d.id) } },
              data: { isPublic: false },
            });
            summary.hidden = r.count;
          }
          const data = {
            name: CALC.name,
            description: CALC.description,
            type: CALC.type,
            category: CALC.category,
            fileUrl: CALC.fileUrl,
            fileSize: html.size,
            isPublic: true,
            sortOrder: plan.calcSortOrder,
          };
          if (plan.calcExisting) {
            const row = await tx.document.update({ where: { id: plan.calcExisting.id }, data });
            summary.calcId = row.id;
          } else {
            const row = await tx.document.create({ data });
            summary.calcId = row.id;
            summary.created = true;
          }

          // Проверка результата внутри транзакции
          const pub = await tx.document.findMany({
            where: { category: CATEGORY, isPublic: true },
            orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
          });
          summary.publicAfter = pub.map(fmtDoc);
          const names = pub.map((d) => d.name);
          const ok =
            pub.length === 2 &&
            names.some((n) => KEEP_RE.test(n)) &&
            names.includes(CALC.name) &&
            pub[0].sortOrder <= pub[1].sortOrder &&
            KEEP_RE.test(pub[0].name);
          if (!ok) {
            throw new Error(`после записи публичных документов ${pub.length}, ожидалось 2 в порядке «Условия сотрудничества» → калькулятор: ${names.join(" | ")}`);
          }
          if (!WRITE) throw new Rollback();
        },
        { timeout: 20000 },
      );
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }

    console.log(`\n--- Публичная выдача после записи${WRITE ? "" : " (внутри транзакции, откачено)"}: ${summary.publicAfter.length}`);
    for (const line of summary.publicAfter) console.log(`  ${line}`);
    console.log(`\n  скрыто: ${summary.hidden} · калькулятор ${summary.created ? "создан" : "обновлён"} id=${summary.calcId}`);
    if (WRITE) console.log(`\nЗАПИСЬ ВЫПОЛНЕНА.`);
    else console.log(`\nПРОГОН БЕЗ ЗАПИСИ: транзакция откачена, проверки прошли (нужны DRY_RUN=0 и CONFIRM=1).`);
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = { buildPlan, inspectHtml, main, CALC, KEEP_RE, HIDE_RES };

if (require.main === module) {
  main().catch((e) => {
    console.error("FATAL:", e?.message || e);
    process.exit(1);
  });
}
