#!/usr/bin/env node
/**
 * 2026-09-07: досье по агентству (read-only) — всё, что есть в кабинете по
 * одному агентству: карточки, брокеры (с телефонами), фиксации (клиенты
 * брокеров, с пометкой «старый кабинет» / «новый кабинет»), сделки (Deal),
 * строки «Реестра сделок» (по брокерам и по названию агентства), встречи.
 *
 * Зачем: владелец просит выгрузку по агентству (например, «Тренд Агент»)
 * для передачи аналитику. Ничего не пишет.
 *
 * Вход (env):
 *   AGENCY_QUERY — регулярное выражение по name / legalName / inn агентства
 *                  (без учёта регистра), например: "тренд|trend|онлайн"
 * Выход: сводка в stdout + строки `SECTION_B64:<имя>:<base64 JSON>` для
 * каждого раздела (собираются офлайн в xlsx).
 *
 * Запуск в контейнере api (workflow export-agency-dossier.yml):
 *   AGENCY_QUERY="тренд|trend" node /app/scripts/export-agency-dossier.js
 */

const { canonicalAgencyMatchKey } = require("./enrich-agencies-from-amo");

const HIST_PREFIX = "[old-cabinet:";
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const num = (v) => (v === null || v === undefined ? null : Number(v));
const emit = (name, rows) => {
  const b64 = Buffer.from(JSON.stringify(rows), "utf8").toString("base64");
  // Длинные строки в логе GH режутся — шлём кусками по 60 000 символов.
  const CHUNK = 60000;
  const parts = Math.ceil(b64.length / CHUNK) || 1;
  for (let i = 0; i < parts; i++) {
    console.log(`SECTION_B64:${name}:${i + 1}/${parts}:${b64.slice(i * CHUNK, (i + 1) * CHUNK)}`);
  }
};

async function main() {
  const query = String(process.env.AGENCY_QUERY || "").trim();
  if (!query) throw new Error("AGENCY_QUERY пуст");
  const re = new RegExp(query, "i");
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    // 1. Карточки агентств.
    const allAgencies = await prisma.agency.findMany({
      select: { id: true, name: true, legalName: true, inn: true, createdAt: true, totalSqmSold: true },
    });
    const agencies = allAgencies.filter((a) => re.test(a.name || "") || re.test(a.legalName || "") || re.test(a.inn || ""));
    console.log(`=== Досье по агентству: /${query}/i — карточек найдено: ${agencies.length} ===`);
    for (const a of agencies) console.log(`  • ${a.name}${a.legalName ? ` (${a.legalName})` : ""} ИНН ${a.inn} · создана ${iso(a.createdAt)}`);
    const agencyIds = agencies.map((a) => a.id);
    const agencyKeys = new Set(agencies.flatMap((a) => [a.name, a.legalName].map(canonicalAgencyMatchKey).filter(Boolean)));

    // 2. Брокеры агентства (все связи, не только primary; включая слитые карточки → их основной).
    const links = agencyIds.length
      ? await prisma.brokerAgency.findMany({ where: { agencyId: { in: agencyIds } }, select: { brokerId: true, agencyId: true, isPrimary: true } })
      : [];
    const brokerIds = [...new Set(links.map((l) => l.brokerId))];
    const brokers = brokerIds.length
      ? await prisma.broker.findMany({
          where: { id: { in: brokerIds } },
          select: {
            id: true, fullName: true, phone: true, email: true, role: true, status: true, isCoordinator: true,
            createdAt: true, amoContactId: true, mergedIntoId: true, region: true, funnelStage: true,
            phones: { select: { phone: true, isPrimary: true } },
            _count: { select: { clients: true, deals: true, meetings: true } },
          },
        })
      : [];
    const agencyName = new Map(agencies.map((a) => [a.id, a.name]));
    const brokerAgencies = new Map();
    for (const l of links) {
      const list = brokerAgencies.get(l.brokerId) || [];
      list.push(`${agencyName.get(l.agencyId)}${l.isPrimary ? " (осн.)" : ""}`);
      brokerAgencies.set(l.brokerId, list);
    }
    const brokerRows = brokers.map((b) => ({
      id: b.id,
      fullName: b.fullName,
      phones: [b.phone, ...b.phones.map((p) => p.phone)].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join(", "),
      email: b.email,
      role: b.role,
      status: b.status,
      funnelStage: b.funnelStage,
      isCoordinator: b.isCoordinator,
      region: b.region,
      agencies: (brokerAgencies.get(b.id) || []).join("; "),
      amoContactId: b.amoContactId ? String(b.amoContactId) : null,
      mergedInto: b.mergedIntoId || null,
      registeredAt: iso(b.createdAt),
      clients: b._count.clients,
      deals: b._count.deals,
      meetings: b._count.meetings,
    }));
    console.log(`Брокеров: ${brokerRows.length}`);
    const brokerName = new Map(brokers.map((b) => [b.id, b.fullName]));

    // 3. Фиксации (клиенты брокеров: владелец или ответственный) + клиенты с fixationAgencyId.
    const clients = brokerIds.length || agencyIds.length
      ? await prisma.client.findMany({
          where: {
            OR: [
              ...(brokerIds.length ? [{ brokerId: { in: brokerIds } }, { responsibleBrokerId: { in: brokerIds } }] : []),
              ...(agencyIds.length ? [{ fixationAgencyId: { in: agencyIds } }] : []),
            ],
          },
          select: {
            id: true, createdAt: true, fullName: true, phone: true, email: true, project: true,
            uniquenessStatus: true, uniquenessExpiresAt: true, fixationStatus: true, fixationExpiresAt: true,
            amoLeadId: true, comment: true, brokerId: true, responsibleBrokerId: true, propertyType: true,
          },
          orderBy: { createdAt: "asc" },
        })
      : [];
    const clientRows = clients.map((c) => ({
      source: String(c.comment || "").startsWith(HIST_PREFIX) ? "старый кабинет" : "новый кабинет",
      date: iso(c.createdAt),
      broker: brokerName.get(c.brokerId) || c.brokerId,
      responsible: c.responsibleBrokerId && c.responsibleBrokerId !== c.brokerId ? brokerName.get(c.responsibleBrokerId) || c.responsibleBrokerId : null,
      client: c.fullName,
      clientPhone: c.phone,
      clientEmail: c.email,
      project: c.project,
      propertyType: c.propertyType || null,
      uniquenessStatus: c.uniquenessStatus,
      uniquenessExpiresAt: iso(c.uniquenessExpiresAt),
      fixationStatus: c.fixationStatus,
      fixationExpiresAt: iso(c.fixationExpiresAt),
      amoLeadId: c.amoLeadId ? String(c.amoLeadId) : null,
      comment: c.comment || null,
    }));
    const hist = clientRows.filter((r) => r.source === "старый кабинет").length;
    console.log(`Фиксаций (клиентов): ${clientRows.length}, из них старый кабинет: ${hist}`);

    // 4. Сделки (Deal): брокеров агентства или с agencyId.
    const deals = brokerIds.length || agencyIds.length
      ? await prisma.deal.findMany({
          where: { OR: [...(brokerIds.length ? [{ brokerId: { in: brokerIds } }] : []), ...(agencyIds.length ? [{ agencyId: { in: agencyIds } }] : [])] },
          select: {
            id: true, createdAt: true, signedAt: true, status: true, amount: true, commissionAmount: true, project: true,
            contractType: true, brokerId: true, amoDealId: true, client: { select: { fullName: true, phone: true } },
            lot: { select: { number: true, floor: true, sqm: true, building: true } },
          },
          orderBy: { signedAt: "asc" },
        })
      : [];
    const dealRows = deals.map((d) => ({
      source: "новый кабинет (amo)",
      signedAt: iso(d.signedAt),
      createdAt: iso(d.createdAt),
      broker: brokerName.get(d.brokerId) || d.brokerId,
      client: d.client?.fullName || null,
      clientPhone: d.client?.phone || null,
      project: d.project,
      status: d.status,
      contractType: d.contractType || null,
      amount: d.amount === null ? null : String(d.amount),
      commission: d.commissionAmount === null || d.commissionAmount === undefined ? null : String(d.commissionAmount),
      lot: d.lot ? `${d.lot.number || ""}${d.lot.building ? ` / ${d.lot.building}` : ""}${d.lot.floor ? ` / эт. ${d.lot.floor}` : ""}${d.lot.sqm ? ` / ${d.lot.sqm} м²` : ""}` : null,
      amoLeadId: d.amoDealId ? String(d.amoDealId) : null,
    }));
    console.log(`Сделок (Deal): ${dealRows.length}`);

    // 5. Реестр сделок: по брокерам и по названию агентства.
    const registryAll = await prisma.registryDeal.findMany({
      select: {
        id: true, contractNumber: true, project: true, signedAt: true, paidAt: true, amount: true,
        dvouDate: true, dvouPaidAt: true, dvouAmount: true, agencyNameRaw: true, agencyCanonical: true,
        brokerId: true, amoLeadId: true, sqm: true, floor: true, building: true, apartmentNumber: true, source: true,
      },
    });
    const brokerSet = new Set(brokerIds);
    const registry = registryAll.filter((r) => {
      if (r.brokerId && brokerSet.has(r.brokerId)) return true;
      const keys = [r.agencyCanonical, r.agencyNameRaw].map(canonicalAgencyMatchKey).filter(Boolean);
      if (keys.some((k) => agencyKeys.has(k))) return true;
      return re.test(r.agencyNameRaw || "") || re.test(r.agencyCanonical || "");
    });
    const registryRows = registry
      .map((r) => ({
        source: "реестр Google" + (r.source === "AMO_ONLY" ? " (только amo)" : ""),
        paidAt: iso(r.paidAt),
        signedAt: iso(r.signedAt),
        isDeal: r.paidAt ? "да" : "нет (нет даты оплаты)",
        contractNumber: r.contractNumber,
        project: r.project,
        amount: r.amount === null ? null : String(r.amount),
        dvouPaidAt: iso(r.dvouPaidAt),
        dvouDate: iso(r.dvouDate),
        dvouAmount: r.dvouAmount === null || r.dvouAmount === undefined ? null : String(r.dvouAmount),
        agencyInRegistry: r.agencyNameRaw || r.agencyCanonical,
        broker: r.brokerId ? brokerName.get(r.brokerId) || r.brokerId : null,
        object: [r.building ? `корпус ${r.building}` : null, r.floor ? `эт. ${r.floor}` : null, r.apartmentNumber ? `кв. ${r.apartmentNumber}` : null, r.sqm ? `${r.sqm} м²` : null].filter(Boolean).join(", ") || null,
        amoLeadId: r.amoLeadId ? String(r.amoLeadId) : null,
      }))
      .sort((a, b) => String(a.paidAt || a.signedAt || "").localeCompare(String(b.paidAt || b.signedAt || "")));
    console.log(`Строк реестра: ${registryRows.length}, из них сделок (с датой оплаты): ${registryRows.filter((r) => r.paidAt).length}, платных броней: ${registryRows.filter((r) => r.dvouPaidAt).length}`);

    // 6. Встречи брокеров.
    const meetings = brokerIds.length
      ? await prisma.meeting.findMany({
          where: { brokerId: { in: brokerIds } },
          select: { date: true, status: true, brokerId: true, client: { select: { fullName: true, phone: true, project: true } } },
          orderBy: { date: "asc" },
        })
      : [];
    const meetingRows = meetings.map((m) => ({
      date: iso(m.date), status: m.status, broker: brokerName.get(m.brokerId) || m.brokerId,
      client: m.client?.fullName || null, clientPhone: m.client?.phone || null, project: m.client?.project || null,
    }));
    console.log(`Встреч: ${meetingRows.length}`);

    emit("agencies", agencies.map((a) => ({ name: a.name, legalName: a.legalName, inn: a.inn, createdAt: iso(a.createdAt), totalSqmSold: num(a.totalSqmSold) })));
    emit("brokers", brokerRows);
    emit("fixations", clientRows);
    emit("deals", dealRows);
    emit("registry", registryRows);
    emit("meetings", meetingRows);
    console.log("RESULT: " + JSON.stringify({ agencies: agencies.length, brokers: brokerRows.length, fixations: clientRows.length, fixationsOldCabinet: hist, deals: dealRows.length, registry: registryRows.length, meetings: meetingRows.length }));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
}
