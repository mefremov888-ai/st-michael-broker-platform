#!/usr/bin/env node
/**
 * 2026-09-17: карточки брокеров, которых нет ни у нас, ни в справочнике
 * brokers.xlsx, но которые подавали заявки в старом кабинете.
 *
 * Зачем: после создания 547 карточек из справочника (apply-old-cabinet-brokers)
 * импорт заявок всё равно пропускает 465 строк — брокера не к кому привязать.
 * Эти брокеры есть только в самих заявках (orders.xlsx): там в каждой строке
 * указаны телефон и ФИО подавшего.
 *
 * Правила (те же, что для справочника):
 *   - ищем по телефону (brokers.phone и broker_phones.phone), сравниваем по
 *     последним 10 цифрам; нашли — пропускаем, ничего не перезаписываем;
 *   - создаём карточку PENDING без пароля: человек у нас не регистрировался,
 *     это справочная запись. baseSource = old_cabinet;
 *   - ФИО берём из самой свежей заявки этого телефона (человек мог сменить
 *     фамилию); дата создания карточки — дата самой ранней его заявки;
 *   - агентства НЕ создаём и не сводим (решение владельца 14.09);
 *   - совпадения по ФИО с уже существующими карточками НЕ склеиваем, а
 *     показываем списком: это кандидаты в дубли, решение за человеком.
 *
 * DRY_RUN=1 по умолчанию. Боевой режим: DRY_RUN=0 CONFIRM=1.
 */
const DRY_RUN = process.env.DRY_RUN !== "0";
const CONFIRMED = process.env.CONFIRM === "1" || process.env.CONFIRM === "true";
const WRITE = !DRY_RUN && CONFIRMED;

const tenDigits = (raw) => {
  const d = String(raw || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
};

/**
 * 2026-09-17: в выгрузке старого кабинета часть телефонов побита. Исходную
 * строку обрезали до 10 знаков и приписали спереди «+7»:
 *   +7 999 822 31 95  →  79998223195  →  обрезано до 7999822319  →  +77999822319
 *   8 911 958 74 78   →  89119587478  →  обрезано до 8911958747  →  +78911958747
 * Признак: 11 цифр, первая «7», вторая «7» или «8» (у настоящих российских
 * мобильных вторая цифра всегда «9»). Последняя цифра номера потеряна
 * безвозвратно, но первые девять известны — по ним ищем человека в базе.
 * Таких номеров 235 из 8 232, и почти все принадлежат людям, которые у нас
 * уже есть под правильным номером. Заводить по ним карточки нельзя.
 */
const brokenPrefix9 = (raw) => {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length !== 11) return null;
  if (d[0] !== "7") return null;
  if (d[1] !== "7" && d[1] !== "8") return null;
  return d.slice(2); // девять известных цифр настоящего номера
};

const nameKey = (raw) =>
  String(raw || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^а-яa-z]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .sort()
    .join(" ");

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("укажи путь к old-cabinet-fixations.json");
    process.exit(2);
  }
  const rows = JSON.parse(require("fs").readFileSync(file, "utf8"));
  const list = Array.isArray(rows) ? rows : rows.rows || [];

  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const brokers = await prisma.broker.findMany({
      where: { mergedIntoId: null },
      select: { id: true, phone: true, fullName: true, displayName: true },
    });
    const extra = await prisma.brokerPhone.findMany({ select: { phone: true } });

    const known = new Set();
    for (const b of brokers) { const t = tenDigits(b.phone); if (t) known.add(t); }
    for (const p of extra) { const t = tenDigits(p.phone); if (t) known.add(t); }

    const byName = new Map();
    for (const b of brokers) {
      for (const n of [b.fullName, b.displayName]) {
        const k = nameKey(n);
        if (!k) continue;
        if (!byName.has(k)) byName.set(k, []);
        byName.get(k).push(b);
      }
    }

    // собираем брокеров из заявок: телефон → ФИО (по самой свежей заявке),
    // дата первой заявки, сколько заявок всего
    const people = new Map();
    let noPhone = 0;
    for (const r of list) {
      const ten = tenDigits(r.brokerPhone);
      if (!ten) { noPhone++; continue; }
      const created = r.createdAt || null;
      const cur = people.get(ten);
      if (!cur) {
        people.set(ten, { phone: r.brokerPhone, ten, name: r.brokerName || null, first: created, last: created, rows: 1 });
      } else {
        cur.rows++;
        if (created && (!cur.first || created < cur.first)) cur.first = created;
        if (created && (!cur.last || created > cur.last)) { cur.last = created; if (r.brokerName) cur.name = r.brokerName; }
      }
    }

    // для поиска по девяти известным цифрам побитых номеров
    const byPrefix9 = new Map();
    for (const b of brokers) {
      const t = tenDigits(b.phone);
      if (!t) continue;
      const k = t.slice(0, 9);
      if (!byPrefix9.has(k)) byPrefix9.set(k, []);
      byPrefix9.get(k).push(b);
    }

    const toCreate = [];
    const broken = { всего: 0, нашлиОдного: 0, нашлиНескольких: 0, неНашли: 0, заявокУнайденных: 0 };
    const brokenUnresolved = [];
    let alreadyHave = 0;
    let noName = 0;
    for (const p of people.values()) {
      const prefix9 = brokenPrefix9(p.phone);
      if (prefix9) {
        broken.всего++;
        const hits = byPrefix9.get(prefix9) || [];
        if (hits.length === 1) { broken.нашлиОдного++; broken.заявокУнайденных += p.rows; }
        else if (hits.length > 1) broken.нашлиНескольких++;
        else { broken.неНашли++; brokenUnresolved.push(p); }
        continue; // карточки по битым номерам НЕ заводим
      }
      if (known.has(p.ten)) { alreadyHave++; continue; }
      if (!p.name || !String(p.name).trim()) { noName++; continue; }
      toCreate.push(p);
    }
    toCreate.sort((a, b) => b.rows - a.rows);

    console.log("=== Брокеры из заявок старого кабинета ===");
    console.log(`  строк во входе:            ${list.length}${noPhone ? ` (без телефона брокера: ${noPhone})` : ""}`);
    console.log(`  уникальных брокеров:       ${people.size}`);
    console.log(`  уже есть у нас:            ${alreadyHave}`);
    console.log(`  без ФИО (пропуск):         ${noName}`);
    console.log(`  битых номеров (не заводим): ${broken.всего} — из них узнали человека по девяти цифрам: ${broken.нашлиОдного} (за ними ${broken.заявокУнайденных} заявок), несколько совпадений: ${broken.нашлиНескольких}, не нашли: ${broken.неНашли}`);
    console.log(`  к созданию:                ${toCreate.length}`);
    const rowsCovered = toCreate.reduce((s, p) => s + p.rows, 0);
    console.log(`  заявок за ними:            ${rowsCovered}`);

    const byYear = {};
    for (const p of toCreate) { const y = String(p.first || "").slice(0, 4) || "—"; byYear[y] = (byYear[y] || 0) + 1; }
    console.log(`  по годам первой заявки: ${JSON.stringify(byYear)}`);

    // кандидаты в дубли по ФИО
    const dupes = [];
    for (const p of toCreate) {
      const hits = byName.get(nameKey(p.name));
      if (hits && hits.length) dupes.push({ p, hits });
    }
    console.log(`\n  совпадают по ФИО с существующими карточками: ${dupes.length} (НЕ склеиваем)`);
    for (const d of dupes.slice(0, 30)) {
      console.log(`    ${d.p.name} · ${d.p.phone.slice(0, 6)}***${d.p.phone.slice(-2)} · заявок ${d.p.rows} — в базе уже есть ${d.hits.length} карточк(а/и) с этим ФИО`);
    }
    if (dupes.length > 30) console.log(`    … и ещё ${dupes.length - 30}`);

    if (brokenUnresolved.length) {
      console.log(`\n  битые номера, по которым человека не нашли: ${brokenUnresolved.length}`);
      for (const p of brokenUnresolved.slice(0, 15)) {
        console.log(`    ${p.name} · ${p.phone.slice(0, 6)}***${p.phone.slice(-2)} · заявок ${p.rows}`);
      }
      if (brokenUnresolved.length > 15) console.log(`    … и ещё ${brokenUnresolved.length - 15}`);
    }

    console.log("\n  примеры к созданию:");
    for (const p of toCreate.slice(0, 5)) {
      console.log(`    ${p.name} · ${p.phone.slice(0, 6)}***${p.phone.slice(-2)} · заявок ${p.rows} · первая ${String(p.first || "").slice(0, 10)}`);
    }

    if (!WRITE) {
      console.log("\nПРОГОН БЕЗ ЗАПИСИ: база не изменена (нужны DRY_RUN=0 и CONFIRM=1).");
      return;
    }

    let created = 0;
    let failed = 0;
    let noJournal = 0;
    for (const p of toCreate) {
      try {
        const card = await prisma.broker.create({
          data: {
            phone: p.phone,
            fullName: String(p.name).slice(0, 200),
            displayName: String(p.name).slice(0, 200),
            displayNameSource: "old_cabinet",
            status: "PENDING",
            role: "BROKER",
            isInBase: true,
            baseSource: "old_cabinet",
            createdAt: p.first ? new Date(p.first) : undefined,
          },
        });
        created++;
        try {
          await prisma.auditLog.create({
            data: {
              action: "BROKER_IMPORTED_OLD_CABINET",
              entity: "Broker",
              entityId: card.id,
              payload: {
                agencyRaw: null,
                source: "orders.xlsx (заявки старого кабинета)",
                fixationsInSource: p.rows,
                firstFixationAt: p.first || null,
                lastFixationAt: p.last || null,
              },
            },
          });
        } catch { noJournal++; }
      } catch (e) {
        failed++;
        if (failed <= 5) console.error(`    ошибка по ${p.phone.slice(0, 6)}***: ${e?.message || e}`);
      }
    }
    console.log(`\nЗАПИСЬ ВЫПОЛНЕНА: создано ${created}, ошибок ${failed}, без записи в журнал ${noJournal}`);
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
