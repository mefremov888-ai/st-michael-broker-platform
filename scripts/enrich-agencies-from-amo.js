#!/usr/bin/env node
/**
 * 2026-09-07: обогащение карточек агентств (Agency) из справочника
 * КОМПАНИЙ amoCRM. В кабинете ~1400 карточек, у большинства нет телефона,
 * настоящего ИНН (плейсхолдеры NOINN-*), адреса и ответственного.
 *
 * Что делает:
 *   1. Выгружает все компании amo: GET /api/v4/companies постранично
 *      (limit=250, пауза 280мс). Поля: id, name, телефоны (field_code
 *      PHONE), ИНН и адрес — field_id ищутся динамически через
 *      GET /api/v4/companies/custom_fields (ИНН — по названию поля,
 *      содержащему «ИНН»; адрес — field_code ADDRESS, иначе по названию
 *      «адрес», НЕ «юр. адрес»), responsible_user_id; имена ответственных —
 *      GET /api/v4/users.
 *   2. Мэтчит компании на карточки Agency:
 *      — первично по каноническому ключу названия (копия
 *        normalizeAgencyMatchKey + AGENCY_KEY_ALIASES из
 *        apps/api/src/loyalty-base/loyalty-base.service.ts — менять ТОЛЬКО
 *        синхронно с оригиналом);
 *      — вторично по ИНН, если у карточки настоящий ИНН (не NOINN-*).
 *   3. Обновляет ТОЛЬКО пустые поля (ничего не перезаписывает):
 *      — phone: первый телефон компании, нормализованный в +7XXXXXXXXXX
 *        (не нормализуется — пропуск со счётчиком);
 *      — address: Agency.address ← поле «Адрес» компании (ADDRESS 557909 —
 *        адрес корреспонденции; «Юр. адрес» НЕ трогаем, он мапится в
 *        Agency.legalAddress синком реквизитов);
 *      — inn: настоящий ИНН (10/12 цифр) взамен NOINN-* ТОЛЬКО если не
 *        занят другой карточкой (agencies.inn UNIQUE) — конфликт = пропуск
 *        со счётчиком;
 *      — ответственный: у модели Agency НЕТ поля менеджера/описания/
 *        комментария — писать некуда, имена только показываются в отчёте
 *        (счётчик + примеры).
 *   4. Неоднозначности: 2+ карточки с одним ключом названия — все
 *      пропускаются (ambiguous); 2+ компании с одним ключом — ключ не
 *      участвует в мэтче по названию (остаётся шанс мэтча по ИНН).
 *
 * Токены amo — из SystemSetting через Prisma БЕЗ NestFactory(AppModule)
 * (полный контекст поднимает кроны), refresh-hook обязателен — тот же
 * приём, что scripts/canary-amo-check.js.
 *
 * Режимы (безопасный дефолт — только отчёт):
 *   DRY_RUN=1 (и всё, кроме DRY_RUN=0) — отчёт: компаний в amo, смэтчено
 *   карточек, «заполнится N» по каждому полю, конфликты ИНН, топ-20
 *   примеров. НИЧЕГО не пишет.
 *   DRY_RUN=0 — боевой: update порциями, счётчики.
 *
 * Запуск в контейнере api (workflow apply-agency-enrich.yml):
 *   DRY_RUN=1 node /app/scripts/enrich-agencies-from-amo.js
 */

const AMO_PAGE_PAUSE_MS = 280;
const PROGRESS_EVERY_PAGES = 10;
const APPLY_LOG_EVERY = 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Копия normalizeAgencyMatchKey + AGENCY_KEY_ALIASES из
// apps/api/src/loyalty-base/loyalty-base.service.ts (импорт из .ts в
// js-скрипт контейнера невозможен — dist не экспортирует модуль наружу).
// Менять ТОЛЬКО синхронно с оригиналом. ───
const AGENCY_NAME_STOP_TOKENS = new Set([
  "ооо",
  "оао",
  "зао",
  "пао",
  "ао",
  "ип",
  "ан",
  "агентство",
  "недвижимости",
  "llc",
  "ltd",
]);

function normalizeAgencyMatchKey(value) {
  const tokens = String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (!tokens.length) return null;
  const meaningful = tokens.filter(
    (token) => !AGENCY_NAME_STOP_TOKENS.has(token),
  );
  return (meaningful.length ? meaningful : tokens).join("") || null;
}

const AGENCY_KEY_ALIASES = {
  // registry_deals.agencyCanonical «trend agent» → карточка «ООО «Онлайн Недвижимость»»
  trendagent: normalizeAgencyMatchKey("ООО «Онлайн Недвижимость»"),
  // registry_deals.agencyCanonical «нмаркет.про» → карточка «Нмаркет»
  нмаркетпро: normalizeAgencyMatchKey("Нмаркет"),
};

function canonicalAgencyMatchKey(value) {
  const key = normalizeAgencyMatchKey(value);
  if (!key) return null;
  return Object.prototype.hasOwnProperty.call(AGENCY_KEY_ALIASES, key)
    ? AGENCY_KEY_ALIASES[key]
    : key;
}
// ─── конец копии ───

// Настоящий ИНН — строго 10 или 12 цифр (плейсхолдеры вида NOINN-* не такие).
function isRealInn(value) {
  return /^(\d{10}|\d{12})$/.test(String(value ?? "").trim());
}

function isPlaceholderInn(value) {
  return String(value ?? "").startsWith("NOINN-");
}

// Нормализация телефона в +7XXXXXXXXXX. Возвращает null, если из значения
// не собирается российский номер (короткий, иностранный, мусор) — такие
// НЕ пишем, только считаем.
function normalizePhoneRu(raw) {
  const digits = String(raw ?? "").replace(/\D+/g, "");
  if (digits.length === 10) return `+7${digits}`;
  if (digits.length === 11 && (digits[0] === "7" || digits[0] === "8")) {
    return `+7${digits.slice(1)}`;
  }
  return null;
}

// Значение кастом-поля компании по field_id (первое непустое).
function cfValueById(entity, fieldId) {
  if (!fieldId) return null;
  const fields = entity?.custom_fields_values || [];
  for (const f of fields) {
    if (Number(f?.field_id) !== Number(fieldId)) continue;
    for (const v of f?.values || []) {
      const s = String(v?.value ?? "").trim();
      if (s) return s;
    }
  }
  return null;
}

// Все значения полей с field_code (у телефона их может быть несколько).
function cfValuesByCode(entity, code) {
  const out = [];
  const fields = entity?.custom_fields_values || [];
  for (const f of fields) {
    if (String(f?.field_code || "") !== code) continue;
    for (const v of f?.values || []) {
      const s = String(v?.value ?? "").trim();
      if (s) out.push(s);
    }
  }
  return out;
}

/**
 * Поиск нужных полей в справочнике кастом-полей компаний.
 *  — ИНН: поле, чьё название содержит «ИНН» (регистронезависимо); если
 *    таких несколько — точное «ИНН» приоритетно.
 *  — Адрес: field_code === 'ADDRESS'; иначе название содержит «адрес»,
 *    но НЕ «юр» (юр. адрес — отдельное поле под Agency.legalAddress).
 * Ожидаемо найдутся ИНН=663911 и Адрес=557909 (AMO_COMPANY_FIELDS в
 * packages/integrations/src/amo-crm.fields.ts) — лог покажет фактические.
 */
function pickCompanyFields(customFields) {
  const innCandidates = customFields.filter((f) =>
    String(f?.name || "").toLowerCase().includes("инн"),
  );
  const innExact = innCandidates.find(
    (f) => String(f?.name || "").trim().toLowerCase() === "инн",
  );
  const innField = innExact || innCandidates[0] || null;

  const addressByCode = customFields.find(
    (f) => String(f?.code || "") === "ADDRESS",
  );
  const addressByName = customFields.find((f) => {
    const n = String(f?.name || "").toLowerCase();
    return n.includes("адрес") && !n.includes("юр");
  });
  const addressField = addressByCode || addressByName || null;

  return { innField, addressField };
}

/**
 * Чистая функция планирования (без БД и без amo) — используется скриптом
 * и локальной проверкой.
 *   companies: [{id, name, phones: [], inn, address, responsibleName}]
 *   agencies:  [{id, name, legalName, inn, phone, address}]
 * Возвращает { stats, updates, examples }.
 */
function planEnrichment(companies, agencies, options = {}) {
  // 2026-09-07: исключения по решению владельца — карточки с этими ИНН не
  // трогаем (пример: «Агентство 7707083893» по ИНН мэтчится на компанию amo
  // «не работаем», адрес от неё брать нельзя). Передаётся через env
  // EXCLUDE_AGENCY_INNS="7707083893,..." (workflow input exclude_inns).
  const excludeInns = new Set(
    (options.excludeInns || []).map((v) => String(v).trim()).filter(Boolean),
  );
  const stats = {
    excludedByOwner: 0,
    companiesTotal: companies.length,
    agenciesTotal: agencies.length,
    ambiguousAgencies: 0, // 2+ карточки с одним ключом — все пропущены
    ambiguousCompanyKeys: 0, // 2+ компании с одним ключом — ключ не мэтчится по названию
    matchedByName: 0,
    matchedByInn: 0,
    matchedTotal: 0,
    fillPhone: 0,
    phoneUnparsed: 0, // телефон есть, но не нормализуется в +7…
    fillAddress: 0,
    fillInn: 0,
    innConflict: 0, // настоящий ИНН уже занят другой карточкой
    responsibleKnown: 0, // ответственный известен, но у Agency нет поля — пропуск
  };

  // Индексы компаний.
  const companiesByKey = new Map();
  const companiesByInn = new Map();
  for (const c of companies) {
    const key = canonicalAgencyMatchKey(c.name);
    if (key) {
      if (!companiesByKey.has(key)) companiesByKey.set(key, []);
      companiesByKey.get(key).push(c);
    }
    if (isRealInn(c.inn)) {
      const inn = String(c.inn).trim();
      if (!companiesByInn.has(inn)) companiesByInn.set(inn, []);
      companiesByInn.get(inn).push(c);
    }
  }
  for (const list of companiesByKey.values()) {
    if (list.length > 1) stats.ambiguousCompanyKeys++;
  }

  // Ключи карточек: карточка может «звучать» и как name, и как legalName.
  // Ключ, на который претендуют 2+ карточки, — неоднозначный: все такие
  // карточки пропускаются целиком (требование задачи).
  const keyToAgencyIds = new Map();
  const agencyKeys = new Map(); // agencyId -> [keys]
  for (const a of agencies) {
    const keys = [];
    for (const v of [a.name, a.legalName]) {
      const key = canonicalAgencyMatchKey(v);
      if (key && !keys.includes(key)) keys.push(key);
    }
    agencyKeys.set(a.id, keys);
    for (const key of keys) {
      if (!keyToAgencyIds.has(key)) keyToAgencyIds.set(key, new Set());
      keyToAgencyIds.get(key).add(a.id);
    }
  }
  const ambiguousAgencyIds = new Set();
  for (const ids of keyToAgencyIds.values()) {
    if (ids.size > 1) for (const id of ids) ambiguousAgencyIds.add(id);
  }

  // ИНН, уже занятые карточками (для unique-проверки), + занятые этим прогоном.
  const usedInns = new Set(
    agencies.map((a) => String(a.inn ?? "").trim()).filter(Boolean),
  );

  const updates = [];
  const examples = [];

  for (const a of agencies) {
    if (excludeInns.has(String(a.inn ?? "").trim())) {
      stats.excludedByOwner++;
      continue;
    }
    if (ambiguousAgencyIds.has(a.id)) {
      stats.ambiguousAgencies++;
      continue;
    }

    // 1) мэтч по названию: ключ должен указывать ровно на одну компанию.
    let company = null;
    let via = null;
    for (const key of agencyKeys.get(a.id) || []) {
      const list = companiesByKey.get(key) || [];
      if (list.length === 1) {
        company = list[0];
        via = "name";
        break;
      }
    }
    // 2) вторичный мэтч по настоящему ИНН карточки.
    if (!company && isRealInn(a.inn)) {
      const list = companiesByInn.get(String(a.inn).trim()) || [];
      if (list.length === 1) {
        company = list[0];
        via = "inn";
      }
    }
    if (!company) continue;

    if (via === "name") stats.matchedByName++;
    else stats.matchedByInn++;
    stats.matchedTotal++;

    const data = {};
    const filledFields = [];

    // phone — только если у карточки пусто.
    if (!String(a.phone ?? "").trim() && company.phones.length) {
      let normalized = null;
      for (const p of company.phones) {
        normalized = normalizePhoneRu(p);
        if (normalized) break;
      }
      if (normalized) {
        data.phone = normalized;
        filledFields.push(`phone=${normalized}`);
        stats.fillPhone++;
      } else {
        stats.phoneUnparsed++;
      }
    }

    // address — только если у карточки пусто.
    if (!String(a.address ?? "").trim() && company.address) {
      data.address = String(company.address).trim();
      filledFields.push("address");
      stats.fillAddress++;
    }

    // inn — ТОЛЬКО взамен плейсхолдера NOINN-*, только настоящий и не занятый.
    if (isPlaceholderInn(a.inn) && isRealInn(company.inn)) {
      const inn = String(company.inn).trim();
      if (usedInns.has(inn)) {
        stats.innConflict++;
      } else {
        usedInns.add(inn);
        data.inn = inn;
        filledFields.push(`inn=${inn}`);
        stats.fillInn++;
      }
    }

    // ответственный — у Agency нет поля (managerName/description/comment
    // отсутствуют в схеме) — только счётчик и отчёт.
    if (company.responsibleName) stats.responsibleKnown++;

    if (Object.keys(data).length > 0) {
      updates.push({ agencyId: a.id, agencyName: a.name, data });
      examples.push({
        agencyName: a.name,
        companyName: company.name,
        via,
        fields: filledFields,
        responsibleName: company.responsibleName || null,
        weight: filledFields.length,
      });
    }
  }

  examples.sort((x, y) => y.weight - x.weight);
  return { stats, updates, examples };
}

function printReport(stats, updates, examples) {
  console.log("=== Сводка обогащения агентств из amoCRM ===");
  console.log(`Компаний в amo всего:               ${stats.companiesTotal}`);
  console.log(`Карточек Agency в БД:               ${stats.agenciesTotal}`);
  console.log(`Смэтчилось карточек:                ${stats.matchedTotal}`);
  console.log(`  по названию:                      ${stats.matchedByName}`);
  console.log(`  по ИНН (вторичный мэтч):          ${stats.matchedByInn}`);
  console.log(`Карточек к обновлению:              ${updates.length}`);
  console.log(`Заполнится телефон:                 ${stats.fillPhone}`);
  console.log(`  телефон не распознан (+7…):       ${stats.phoneUnparsed}`);
  console.log(`Заполнится адрес:                   ${stats.fillAddress}`);
  console.log(`Заполнится настоящий ИНН:           ${stats.fillInn}`);
  console.log(`  конфликтов ИНН (занят, пропуск):  ${stats.innConflict}`);
  console.log(`Неоднозначных карточек (пропуск):   ${stats.ambiguousAgencies}`);
  console.log(`Исключено по решению владельца:     ${stats.excludedByOwner}`);
  console.log(`Неоднозначных ключей компаний:      ${stats.ambiguousCompanyKeys}`);
  console.log(
    `Ответственный известен (некуда писать, у Agency нет поля): ${stats.responsibleKnown}`,
  );

  console.log("\nТоп-20 примеров «карточка ← компания (поля)»:");
  for (const e of examples.slice(0, 20)) {
    const resp = e.responsibleName ? `; отв.: ${e.responsibleName}` : "";
    console.log(
      `  ${e.agencyName} ← ${e.companyName} [${e.via}] (${e.fields.join(", ")}${resp})`,
    );
  }
}

// ─── Основной прогон (в контейнере api) ───
async function main() {
  // Безопасный дефолт: боевой режим ТОЛЬКО при явном DRY_RUN=0.
  const dryRun = process.env.DRY_RUN !== "0";
  console.log(
    `=== Режим: ${dryRun ? "DRY-RUN (только отчёт)" : "APPLY (запись в БД!)"} ===\n`,
  );

  const {
    AmoCrmAdapter,
    setAmoTokens,
    setAmoTokenRefreshHook,
  } = require("/app/packages/integrations/dist/amo-crm.adapter");
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();

  try {
    // Токены из SystemSetting + refresh-hook (refresh_token ротируется при
    // каждом использовании) — как в canary-amo-check.js.
    const rows = await prisma.systemSetting.findMany({
      where: { key: { in: ["AMO_ACCESS_TOKEN", "AMO_REFRESH_TOKEN"] } },
      select: { key: true, value: true },
    });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    setAmoTokens(
      byKey.get("AMO_ACCESS_TOKEN") || process.env.AMO_ACCESS_TOKEN || "",
      byKey.get("AMO_REFRESH_TOKEN") || process.env.AMO_REFRESH_TOKEN || "",
    );
    setAmoTokenRefreshHook(async (tokens) => {
      for (const [key, value] of [
        ["AMO_ACCESS_TOKEN", tokens.access],
        ["AMO_REFRESH_TOKEN", tokens.refresh],
      ]) {
        await prisma.systemSetting.upsert({
          where: { key },
          update: { value, updatedBy: "enrich-agencies-from-amo" },
          create: { key, value, updatedBy: "enrich-agencies-from-amo" },
        });
      }
      console.error("amo tokens refreshed and persisted");
    });

    const amo = new AmoCrmAdapter();
    // ВАЖНО: adapter.request() сам добавляет /api/v4 — пути без префикса.

    // 1. Справочник кастом-полей компаний → поля ИНН и адреса.
    const customFields = [];
    for (let page = 1; ; page++) {
      const res = await amo["request"](
        `/companies/custom_fields?page=${page}&limit=250`,
      );
      const list = res?._embedded?.custom_fields || [];
      customFields.push(...list);
      if (!res?._links?.next || list.length === 0) break;
      await sleep(AMO_PAGE_PAUSE_MS);
    }
    const { innField, addressField } = pickCompanyFields(customFields);
    console.log(
      `Поле ИНН: ${innField ? `id=${innField.id} «${innField.name}»` : "НЕ НАЙДЕНО — ИНН пропускается"}`,
    );
    console.log(
      `Поле адреса: ${addressField ? `id=${addressField.id} «${addressField.name}» (code=${addressField.code || "—"})` : "НЕ НАЙДЕНО — адрес пропускается"}`,
    );

    // 2. Пользователи amo → имя ответственного.
    const usersById = new Map();
    for (let page = 1; ; page++) {
      const res = await amo["request"](`/users?page=${page}&limit=250`);
      const list = res?._embedded?.users || [];
      for (const u of list) usersById.set(Number(u.id), String(u.name || ""));
      if (!res?._links?.next || list.length === 0) break;
      await sleep(AMO_PAGE_PAUSE_MS);
    }
    console.log(`Пользователей amo: ${usersById.size}`);

    // 3. Все компании amo постранично.
    const companies = [];
    for (let page = 1; ; page++) {
      const res = await amo["request"](`/companies?page=${page}&limit=250`);
      const list = res?._embedded?.companies || [];
      if (list.length === 0) break;
      for (const c of list) {
        companies.push({
          id: c.id,
          name: String(c.name || "").trim(),
          phones: cfValuesByCode(c, "PHONE"),
          inn: innField ? cfValueById(c, innField.id) : null,
          address: addressField ? cfValueById(c, addressField.id) : null,
          responsibleName:
            usersById.get(Number(c.responsible_user_id)) || null,
        });
      }
      if (page % PROGRESS_EVERY_PAGES === 0) {
        console.log(`— прогресс: ${companies.length} компаний —`);
      }
      if (!res?._links?.next) break;
      await sleep(AMO_PAGE_PAUSE_MS);
    }
    console.log(`Компаний в amo: ${companies.length}\n`);

    // 4. Карточки Agency и план обновлений.
    const agencies = await prisma.agency.findMany({
      select: {
        id: true,
        name: true,
        legalName: true,
        inn: true,
        phone: true,
        address: true,
      },
    });

    const excludeInns = String(process.env.EXCLUDE_AGENCY_INNS || "")
      .split(/[,\s;]+/)
      .filter(Boolean);
    if (excludeInns.length) {
      console.log(`Исключены по решению владельца (ИНН): ${excludeInns.join(", ")}`);
    }
    const { stats, updates, examples } = planEnrichment(companies, agencies, {
      excludeInns,
    });
    printReport(stats, updates, examples);

    if (dryRun) {
      console.log("\nDRY-RUN: ничего не записано. Для записи DRY_RUN=0.");
      return;
    }

    // 5. Боевой прогон: поля у карточек разные — обновляем по одной,
    // ошибка одной строки (например, гонка по unique inn, P2002) не
    // роняет весь прогон.
    let updated = 0;
    let failed = 0;
    let innConflictApply = 0;
    for (const u of updates) {
      try {
        await prisma.agency.update({ where: { id: u.agencyId }, data: u.data });
        updated++;
      } catch (e) {
        if (e?.code === "P2002") {
          innConflictApply++;
          // Повтор без ИНН — телефон/адрес не должны пропасть из-за гонки.
          const { inn, ...rest } = u.data;
          if (Object.keys(rest).length > 0) {
            try {
              await prisma.agency.update({
                where: { id: u.agencyId },
                data: rest,
              });
              updated++;
            } catch (e2) {
              failed++;
              console.error(`Ошибка «${u.agencyName}»: ${e2?.message || e2}`);
            }
          }
        } else {
          failed++;
          console.error(`Ошибка «${u.agencyName}»: ${e?.message || e}`);
        }
      }
      if ((updated + failed) % APPLY_LOG_EVERY === 0) {
        console.log(`— обновлено ${updated}/${updates.length} —`);
      }
    }
    console.log(`\nupdated=${updated}`);
    console.log(`ИНН-конфликтов при записи (гонка): ${innConflictApply}`);
    console.log(`Ошибок: ${failed}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("FATAL:", e?.message || e);
    process.exit(1);
  });
}

module.exports = {
  normalizeAgencyMatchKey,
  canonicalAgencyMatchKey,
  AGENCY_KEY_ALIASES,
  normalizePhoneRu,
  isRealInn,
  isPlaceholderInn,
  pickCompanyFields,
  planEnrichment,
};
