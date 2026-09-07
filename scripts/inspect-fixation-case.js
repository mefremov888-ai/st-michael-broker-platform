#!/usr/bin/env node
/**
 * 2026-09-07: разбор обращения «зафиксировал клиента, а в “Мои клиенты” его
 * нет». Read-only: по телефону брокера и телефону клиента показывает, что
 * есть в кабинете и в amoCRM, и называет вероятную причину.
 *
 * Вход (env): BROKER_PHONE, CLIENT_PHONE (любой формат); BROKER_NAME — необязательно,
 * подстрока ФИО брокера (ищем карточки и по имени: телефон мог быть указан
 * у другого человека).
 * Телефоны в выводе маскируются (первые 6 цифр + ****), кроме id.
 *
 * Запуск в контейнере api (workflow inspect-fixation-case.yml):
 *   BROKER_PHONE=... CLIENT_PHONE=... node /app/scripts/inspect-fixation-case.js
 */

const HIST = "[old-cabinet:";
const digits = (v) => String(v || "").replace(/\D/g, "");
const last10 = (v) => digits(v).slice(-10);
const mask = (v) => { const d = digits(v); return d ? `+${d.slice(0, 5)}****${d.slice(-2)}` : "—"; };
const iso = (d) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) : "—");

async function main() {
  const brokerPhone = last10(process.env.BROKER_PHONE);
  const clientPhone = last10(process.env.CLIENT_PHONE);
  if (brokerPhone.length < 10 || clientPhone.length < 10) throw new Error("BROKER_PHONE и CLIENT_PHONE обязательны");
  const { AmoCrmAdapter, setAmoTokens, setAmoTokenRefreshHook } = require("/app/packages/integrations/dist/amo-crm.adapter");
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  const findings = [];
  try {
    // 1. Карточки брокера по телефону (все варианты формата: ищем по последним 10 цифрам).
    const brokers = await prisma.$queryRawUnsafe(
      `SELECT b.id, b.full_name AS "fullName", b.phone, b.role, b.status, b.merged_into_id AS "mergedIntoId", b.amo_contact_id AS "amoContactId", b.created_at AS "createdAt"
       FROM brokers b LEFT JOIN broker_phones p ON p.broker_id = b.id
       WHERE regexp_replace(COALESCE(b.phone,''), '\\D', '', 'g') LIKE $1 OR regexp_replace(COALESCE(p.phone,''), '\\D', '', 'g') LIKE $1
       GROUP BY b.id ORDER BY b.created_at`,
      `%${brokerPhone}`,
    ).catch(async (e) => {
      console.error(`[sql brokers] ${e?.message || e}`);
      // Запасной путь без raw SQL: по точным форматам.
      const variants = [`+7${brokerPhone}`, `8${brokerPhone}`, `7${brokerPhone}`, brokerPhone];
      return prisma.broker.findMany({ where: { OR: [{ phone: { in: variants } }, { phones: { some: { phone: { in: variants } } } }] }, select: { id: true, fullName: true, phone: true, role: true, status: true, mergedIntoId: true, amoContactId: true, createdAt: true } });
    });
    console.log(`=== Брокер по телефону ${mask(brokerPhone)}: карточек ${brokers.length} ===`);
    for (const b of brokers) {
      const agencies = await prisma.brokerAgency.findMany({ where: { brokerId: b.id }, select: { isPrimary: true, agency: { select: { name: true } } } });
      console.log(`  • ${b.fullName} | id ${b.id} | ${b.role}/${b.status} | тел. ${mask(b.phone)} | amo контакт ${b.amoContactId ?? "—"} | слита в ${b.mergedIntoId ?? "—"} | создана ${iso(b.createdAt)} | агентства: ${agencies.map((a) => a.agency.name + (a.isPrimary ? " (осн.)" : "")).join("; ") || "—"}`);
    }
    if (brokers.length === 0) findings.push("В кабинете нет ни одной карточки брокера с таким телефоном — брокер зарегистрирован под другим номером или не зарегистрирован.");
    if (brokers.length > 1) findings.push(`У брокера ${brokers.length} карточки в кабинете — клиент мог лечь на другую карточку (вход под другим аккаунтом).`);
    const brokerIds = brokers.map((b) => b.id);

    // 1б. Карточки брокера по имени (если задано) — телефон мог быть чужим.
    const nameQuery = String(process.env.BROKER_NAME || "").trim();
    if (nameQuery) {
      const byName = await prisma.broker.findMany({
        where: { fullName: { contains: nameQuery, mode: "insensitive" } },
        select: { id: true, fullName: true, phone: true, role: true, status: true, mergedIntoId: true, amoContactId: true, createdAt: true, brokerAgencies: { select: { isPrimary: true, agency: { select: { name: true } } } } },
        orderBy: { createdAt: "asc" },
      });
      console.log(`
=== Брокер по имени «${nameQuery}»: карточек ${byName.length} ===`);
      for (const b of byName) {
        console.log(`  • ${b.fullName} | id ${b.id} | ${b.role}/${b.status} | тел. ${mask(b.phone)}${brokerIds.includes(b.id) ? " (та же карточка, что по телефону)" : ""} | amo контакт ${b.amoContactId ?? "—"} | слита в ${b.mergedIntoId ?? "—"} | создана ${iso(b.createdAt)} | агентства: ${b.brokerAgencies.map((a) => a.agency.name + (a.isPrimary ? " (осн.)" : "")).join("; ") || "—"}`);
        if (!brokerIds.includes(b.id)) { brokerIds.push(b.id); brokers.push(b); }
      }
      if (byName.length && !byName.some((b) => digits(b.phone).endsWith(brokerPhone))) findings.push("Телефон из обращения принадлежит ДРУГОЙ карточке, чем ФИО агента: клиент привязан к карточке по телефону, а агент заходит под своей.");
    }

    // 2. Клиент по телефону — у всех брокеров.
    const clients = await prisma.$queryRawUnsafe(
      `SELECT c.id, c.full_name AS "fullName", c.phone, c.project, c.broker_id AS "brokerId", c.responsible_broker_id AS "responsibleBrokerId", c.uniqueness_status AS "uniquenessStatus", c.uniqueness_reason AS "uniquenessReason", c.fixation_status AS "fixationStatus", c.amo_lead_id AS "amoLeadId", c.amo_sync_status AS "amoSyncStatus", c.amo_sync_error AS "amoSyncError", c.created_at AS "createdAt", c.comment
       FROM clients c WHERE regexp_replace(COALESCE(c.phone,''), '\\D', '', 'g') LIKE $1 ORDER BY c.created_at DESC`,
      `%${clientPhone}`,
    ).catch((e) => { console.error(`[sql clients] ${e?.message || e}`); return []; });
    console.log(`\n=== Клиент по телефону ${mask(clientPhone)}: записей ${clients.length} ===`);
    const brokerName = new Map(brokers.map((b) => [b.id, b.fullName]));
    for (const c of clients) {
      const owner = brokerName.get(c.brokerId) || (await prisma.broker.findUnique({ where: { id: c.brokerId }, select: { fullName: true, phone: true, role: true, status: true, isCoordinator: true } }).then((b) => (b ? `${b.fullName} (${mask(b.phone)}, ${b.role}/${b.status}${b.isCoordinator ? ", координатор" : ""}, ДРУГОЙ брокер)` : c.brokerId)));
      const hist = String(c.comment || "").startsWith(HIST);
      console.log(`  • ${iso(c.createdAt)} | ${c.fullName} | проект ${c.project} | уникальность ${c.uniquenessStatus}${c.uniquenessReason ? ` (${c.uniquenessReason})` : ""} | фиксация ${c.fixationStatus} | лид amo ${c.amoLeadId ?? "—"} | синк ${c.amoSyncStatus}${c.amoSyncError ? ` (${String(c.amoSyncError).slice(0, 120)})` : ""} | брокер: ${owner}${c.responsibleBrokerId && c.responsibleBrokerId !== c.brokerId ? ` | ответственный: ${c.responsibleBrokerId}` : ""}${hist ? " | ИСТОРИЯ старого кабинета (брокеру не видна)" : ""}`);
    }
    if (clients.length === 0) findings.push("В кабинете нет записи клиента с таким телефоном — заявка в кабинет не записалась (или подана не через кабинет).");
    const mine = clients.filter((c) => brokerIds.includes(c.brokerId) || brokerIds.includes(c.responsibleBrokerId));
    const others = clients.filter((c) => !mine.includes(c));
    if (others.length && !mine.length) findings.push("Запись клиента есть, но привязана к ДРУГОМУ брокеру/карточке — поэтому в «Мои клиенты» у этого аккаунта её нет.");
    for (const c of mine) {
      if (String(c.comment || "").startsWith(HIST)) findings.push("Запись — историческая (старый кабинет): брокерам такие не показываются по решению владельца.");
      if (c.amoSyncStatus === "FAILED") findings.push(`Синк с amo провален: ${c.amoSyncError || "без текста"} — запись есть в кабинете, но в списке может стоять как «ожидает».`);
      if (c.uniquenessStatus === "UNDER_REVIEW") findings.push("Заявка на рассмотрении (UNDER_REVIEW): в списке брокера должна быть видна со статусом «на рассмотрении».");
    }

    // 3. amoCRM: контакт клиента и его лиды.
    try {
      const tokenRows = await prisma.systemSetting.findMany({ where: { key: { in: ["AMO_ACCESS_TOKEN", "AMO_REFRESH_TOKEN"] } }, select: { key: true, value: true } });
      const byKey = new Map(tokenRows.map((r) => [r.key, r.value]));
      setAmoTokens(byKey.get("AMO_ACCESS_TOKEN") || "", byKey.get("AMO_REFRESH_TOKEN") || "");
      setAmoTokenRefreshHook(async (tokens) => {
        for (const [key, value] of [["AMO_ACCESS_TOKEN", tokens.access], ["AMO_REFRESH_TOKEN", tokens.refresh]]) {
          await prisma.systemSetting.upsert({ where: { key }, update: { value, updatedBy: "inspect-fixation-case" }, create: { key, value, updatedBy: "inspect-fixation-case" } });
        }
      });
      const amo = new AmoCrmAdapter();
      const contact = await amo.findContactByPhone(`+7${clientPhone}`, { strict: true });
      console.log(`\n=== amoCRM: контакт клиента ${contact ? `#${contact.id} «${contact.name}»` : "НЕ НАЙДЕН"} ===`);
      if (contact) {
        const leads = await amo.getLeadsByContact(Number(contact.id));
        for (const l of leads) {
          const cf = (id) => (l.custom_fields_values || []).find((f) => Number(f.field_id) === id)?.values?.[0]?.value;
          console.log(`  • лид ${l.id} | воронка ${l.pipeline_id} | статус ${l.status_id} | создан ${iso(l.created_at * 1000)} | ответственный ${l.responsible_user_id} | агент: ${cf(835417) ?? "—"}`);
        }
        if (!leads.length) findings.push("Контакт в amo есть, но лидов у него нет — фиксация до amo не дошла.");
        const cabinetLeadIds = new Set(clients.map((c) => String(c.amoLeadId || "")));
        if (leads.length && !leads.some((l) => cabinetLeadIds.has(String(l.id)))) findings.push("Лиды в amo есть, но ни один не связан с записью кабинета — заявка была подана мимо кабинета (КЦ/amo) или связь не записалась.");
      } else {
        findings.push("Контакт клиента в amo не найден по телефону — заявка не создала контакт в amo.");
      }
      // Контакт брокера в amo.
      const bc = await amo.findContactByPhone(`+7${brokerPhone}`, { strict: true });
      console.log(`amoCRM: контакт брокера ${bc ? `#${bc.id} «${bc.name}»` : "НЕ НАЙДЕН"}`);
    } catch (e) {
      console.error(`[amo] ${e?.message || e}`);
    }

    console.log("\n=== Вероятная причина ===");
    for (const f of findings) console.log(`  – ${f}`);
    if (!findings.length) console.log("  – Записи есть и привязаны к этому брокеру; проверить фильтры списка (статус/проект/поиск) и кэш приложения.");
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
}
