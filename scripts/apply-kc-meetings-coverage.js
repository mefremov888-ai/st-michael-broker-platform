#!/usr/bin/env node
/**
 * ПРИМЕНЕНИЕ (DRY_RUN=1 по умолчанию, боевой режим DRY_RUN=0 + CONFIRM=1).
 * 2026-09-14 (вопрос владельца: «а эти встречи ты постарался разнести?»):
 * охват ВСЕХ карточек колл-центра «встреча проведена», а не только спорных.
 * Прежний план (inspect-meeting-attribution-plan) пропускал карточки, чей
 * телефон не совпал ни с одной заявкой, — их никто не разносил. Здесь
 * считаем, сколько встреч ещё можно вернуть по контакту-брокеру на самой
 * карточке и по брокеру строки реестра, и создаёт их.
 *
 * Исходные правила плана (для справки):
 *   правило 1 — брокер прикреплён к карточке КЦ вторым контактом;
 *   правило 2 — брокер указан в строке реестра ДДУ по этой сделке;
 *   правило 3 — ровно одна фиксация была действующей на дату встречи
 *               (по замеру ошибается примерно в одном случае из пяти).
 * Считает, сколько встреч добавится, скольким брокерам, и сколько уже
 * есть в базе (дедуп по брокеру, дню и типу). НИЧЕГО НЕ ПИШЕТ.
 */
const DRY_RUN = process.env.DRY_RUN !== "0";
const CONFIRMED = process.env.CONFIRM === "1" || process.env.CONFIRM === "true";
const WRITE = !DRY_RUN && CONFIRMED;
const KC_PIPELINE_ID = 7600542;
const KC_MEETING_HELD_STATUS = 142;
const AMO_PAUSE_MS = 280;
const CONTRACT_FIELD_ID = 558577;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

function contractKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[abcekmhopxyt]/g, (ch) => ({ a: "а", b: "в", c: "с", e: "е", k: "к", m: "м", h: "н", o: "о", p: "р", x: "х", y: "у", t: "т" })[ch] || ch)
    .replace(/\s+/g, "")
    .trim();
}

function phoneKeyCandidates(raw) {
  const keys = new Set();
  for (const chunk of String(raw || "").split(/[,;\/]|\s(?:или|и)\s/)) {
    const digits = chunk.replace(/\D/g, "");
    if (!digits) continue;
    if (digits.length === 10) keys.add(digits);
    else if (digits.length === 11 && (digits[0] === "7" || digits[0] === "8")) keys.add(digits.slice(1));
    else if (digits.length > 11 && (digits[0] === "7" || digits[0] === "8")) keys.add(digits.slice(1, 11));
  }
  return [...keys];
}

const leadCustomField = (lead, name) => {
  const f = (lead?.custom_fields_values || []).find((x) => x.field_name === name);
  return f?.values?.[0]?.value ?? null;
};
const leadFieldById = (lead, id) => {
  const f = (lead?.custom_fields_values || []).find((x) => Number(x.field_id) === id);
  return f?.values?.[0]?.value ?? null;
};

function leadMeetingDate(lead) {
  for (const candidate of [leadCustomField(lead, "Дата и время встречи"), lead?.closed_at, lead?.created_at]) {
    const num = Number(candidate);
    if (Number.isFinite(num) && num > 0) {
      const d = new Date(num * 1000);
      if (!isNaN(d.getTime())) return d;
    }
  }
  return null;
}

function contactPhoneKeys(contact) {
  const out = new Set();
  for (const field of contact?.custom_fields_values || []) {
    if (String(field.field_code || "").toUpperCase() !== "PHONE") continue;
    for (const v of field.values || []) for (const key of phoneKeyCandidates(v?.value)) out.add(key);
  }
  return [...out];
}

async function initAmo(prisma) {
  const { AmoCrmAdapter, setAmoTokens, setAmoTokenRefreshHook } = require("/app/packages/integrations/dist/amo-crm.adapter");
  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: ["AMO_ACCESS_TOKEN", "AMO_REFRESH_TOKEN"] } },
    select: { key: true, value: true },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  setAmoTokens(byKey.get("AMO_ACCESS_TOKEN") || "", byKey.get("AMO_REFRESH_TOKEN") || "");
  setAmoTokenRefreshHook(async (tokens) => {
    for (const [key, value] of [["AMO_ACCESS_TOKEN", tokens.access], ["AMO_REFRESH_TOKEN", tokens.refresh]]) {
      await prisma.systemSetting.upsert({ where: { key }, update: { value, updatedBy: "inspect" }, create: { key, value, updatedBy: "inspect" } });
    }
  });
  return new AmoCrmAdapter();
}

function table(title, rows, total) {
  console.log(`\n=== ${title} ===`);
  for (const [label, value, note] of rows) {
    const share = total && typeof value === "number" ? `  ${Math.round((value / total) * 100)}%` : "";
    console.log(`  ${String(label).padEnd(52)} ${String(value).padStart(6)}${share}${note ? "  · " + note : ""}`);
  }
}

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const amo = await initAmo(prisma);

    const leads = [];
    let page = 1;
    for (;;) {
      let res;
      try {
        res = await amo["request"](`/leads?filter[pipeline_id]=${KC_PIPELINE_ID}&page=${page}&limit=250&with=contacts`);
      } catch (e) {
        console.error(`страница ${page}: ${e?.message || e}`);
        break;
      }
      const list = res?._embedded?.leads || [];
      if (!list.length) break;
      for (const lead of list) if (Number(lead.status_id) === KC_MEETING_HELD_STATUS) leads.push(lead);
      if (!res?._links?.next) break;
      page++;
      await sleep(AMO_PAUSE_MS);
    }
    console.log(`Карточек колл-центра «встреча проведена»: ${leads.length}`);

    // контакты (все, не только главный)
    const mainContactByLead = new Map();
    const allContactsByLead = new Map();
    for (const lead of leads) {
      const contacts = lead?._embedded?.contacts || [];
      const main = contacts.find((c) => c.is_main) || contacts[0];
      if (main?.id) mainContactByLead.set(lead.id, Number(main.id));
      allContactsByLead.set(lead.id, contacts.map((c) => Number(c.id)).filter(Boolean));
    }
    const everyContact = new Set();
    for (const ids of allContactsByLead.values()) for (const id of ids) everyContact.add(id);
    const contactMap = await amo.getContactsByIds([...everyContact]);

    // дочерние сделки → номер договора
    const daughterByLead = new Map();
    for (const lead of leads) {
      const raw = String(leadCustomField(lead, "cc_id_daughter") || "").replace(/\D/g, "");
      if (raw) daughterByLead.set(lead.id, raw);
    }
    const daughters = new Map();
    const uniq = [...new Set(daughterByLead.values())];
    for (let i = 0; i < uniq.length; i += 200) {
      const query = uniq.slice(i, i + 200).map((id) => `filter[id][]=${id}`).join("&");
      try {
        const res = await amo["request"](`/leads?${query}&limit=250`);
        for (const l of res?._embedded?.leads || []) daughters.set(String(l.id), l);
      } catch (e) {
        console.error(`дочерние ${i}: ${e?.message || e}`);
      }
      await sleep(AMO_PAUSE_MS);
    }

    // база
    const clients = await prisma.client.findMany({
      select: { id: true, phone: true, brokerId: true, createdAt: true, uniquenessStatus: true, uniquenessExpiresAt: true },
    });
    const byPhone = new Map();
    for (const c of clients) {
      for (const key of phoneKeyCandidates(c.phone)) {
        if (!byPhone.has(key)) byPhone.set(key, []);
        byPhone.get(key).push(c);
      }
    }
    const brokers = await prisma.broker.findMany({ where: { mergedIntoId: null }, select: { id: true, phone: true } });
    const extraPhones = await prisma.brokerPhone.findMany({ select: { brokerId: true, phone: true } });
    const brokerByPhone = new Map();
    for (const b of brokers) for (const key of phoneKeyCandidates(b.phone)) brokerByPhone.set(key, b.id);
    for (const ph of extraPhones) for (const key of phoneKeyCandidates(ph.phone)) if (!brokerByPhone.has(key)) brokerByPhone.set(key, ph.brokerId);

    const registry = await prisma.registryDeal.findMany({ select: { contractNumber: true, brokerId: true, amoLeadId: true } });
    const regByContract = new Map();
    const regByLead = new Map();
    for (const r of registry) {
      const key = contractKey(r.contractNumber);
      if (key && !regByContract.has(key)) regByContract.set(key, r);
      if (r.amoLeadId !== null && r.amoLeadId !== undefined) regByLead.set(String(r.amoLeadId), r);
    }

    // существующие встречи для дедупа: брокер + день
    const existing = await prisma.meeting.findMany({ select: { brokerId: true, date: true, comment: true } });
    const existingKeys = new Set(existing.map((m) => `${m.brokerId}|${dayKey(m.date)}`));
    const existingMarkers = new Set();
    for (const m of existing) {
      const match = String(m.comment || "").match(/\[amo:kc-lead:(\d+)\]/);
      if (match) existingMarkers.add(match[1]);
    }
    console.log(`Встреч в базе: ${existing.length}, с меткой карточки КЦ: ${existingMarkers.size}`);

    const isActiveOn = (client, when) => {
      if (!when) return false;
      if (String(client.uniquenessStatus) === "REJECTED") return false;
      const from = client.createdAt ? new Date(client.createdAt).getTime() : 0;
      const to = client.uniquenessExpiresAt ? new Date(client.uniquenessExpiresAt).getTime() : 0;
      if (!to) return false;
      const t = when.getTime();
      return t >= from - 86400000 && t <= to + 86400000;
    };

    // 2026-09-14: охват ВСЕХ карточек КЦ «встреча проведена», а не только
    // спорных. План привязки смотрел лишь карточки, чей телефон совпал с
    // несколькими заявками; карточки без совпадения он пропускал как
    // «уже разобраны» — на деле их никто не разносил.
    const stat = {
      total: 0,
      noDate: 0,
      alreadyMarked: 0,
      matchedOne: 0,
      matchedMany: 0,
      matchedNone: 0,
      recoverableByBrokerContact: 0,
      recoverableByRegistry: 0,
      hopeless: 0,
      dedupSameDay: 0,
      dealConflict: 0,
      created: 0,
      writeErrors: 0,
    };
    const conflicts = [];
    const writeErrors = [];
    const byYear = new Map();
    const recoverBrokers = new Set();
    const samples = [];

    for (const lead of leads) {
      stat.total++;
      const when = leadMeetingDate(lead);
      if (!when) { stat.noDate++; continue; }
      const year = dayKey(when).slice(0, 4);

      if (existingMarkers.has(String(lead.id))) { stat.alreadyMarked++; continue; }

      const main = contactMap.get(mainContactByLead.get(lead.id));
      const keys = main ? contactPhoneKeys(main) : [];
      const candidates = [];
      for (const key of keys) for (const c of byPhone.get(key) || []) if (!candidates.some((x) => x.id === c.id)) candidates.push(c);

      if (candidates.length === 1) stat.matchedOne++;
      else if (candidates.length > 1) stat.matchedMany++;
      else stat.matchedNone++;

      // брокер прямым указанием: контакт-брокер на карточке
      const brokerIdsOnLead = new Set();
      for (const cid of allContactsByLead.get(lead.id) || []) {
        const c = contactMap.get(cid);
        if (!c) continue;
        for (const key of contactPhoneKeys(c)) {
          const bid = brokerByPhone.get(key);
          if (bid) brokerIdsOnLead.add(bid);
        }
      }

      // брокер из строки реестра по дочерней сделке / номеру договора
      const daughterId = daughterByLead.get(lead.id);
      const daughter = daughterId ? daughters.get(daughterId) : null;
      const contractRaw = daughter ? leadFieldById(daughter, CONTRACT_FIELD_ID) : null;
      let deal = daughterId ? regByLead.get(daughterId) : null;
      if (!deal && contractRaw) deal = regByContract.get(contractKey(contractRaw)) || null;

      let brokerId = null;
      let how = null;
      if (brokerIdsOnLead.size === 1) { brokerId = [...brokerIdsOnLead][0]; how = "контакт-брокер"; }
      else if (brokerIdsOnLead.size > 1) { brokerId = [...brokerIdsOnLead][0]; how = "контакт-брокер (несколько)"; }
      else if (deal?.brokerId) { brokerId = deal.brokerId; how = "строка реестра"; }

      if (!brokerId) { stat.hopeless++; continue; }
      if (existingKeys.has(`${brokerId}|${dayKey(when)}`)) { stat.dedupSameDay++; continue; }

      // Требование владельца 11.09: если по этому договору сделка прошла
      // через ДРУГОГО брокера — не записываем, показываем списком.
      if (deal?.brokerId && deal.brokerId !== brokerId) {
        stat.dealConflict++;
        if (conflicts.length < 10) conflicts.push(`лид ${lead.id} · ${dayKey(when)} · выбран ${brokerId} · в реестре ${deal.brokerId}`);
        continue;
      }

      if (how.startsWith("контакт")) stat.recoverableByBrokerContact++;
      else stat.recoverableByRegistry++;
      existingKeys.add(`${brokerId}|${dayKey(when)}`);
      recoverBrokers.add(brokerId);
      byYear.set(year, (byYear.get(year) || 0) + 1);
      if (samples.length < 10) samples.push(`лид ${lead.id} · ${dayKey(when)} · ${how} · брокер ${brokerId}`);

      if (WRITE) {
        try {
          await prisma.meeting.create({
            data: {
              brokerId,
              clientId: candidates.length === 1 ? candidates[0].id : null,
              type: "OFFICE_VISIT",
              status: "COMPLETED",
              date: when,
              comment: `[amo:kc-lead:${lead.id}] встреча колл-центра, брокер определён: ${how}`,
            },
          });
          stat.created++;
        } catch (e) {
          stat.writeErrors++;
          if (writeErrors.length < 5) writeErrors.push(`лид ${lead.id}: ${e?.message || e}`);
        }
      }
    }

    table("Карточки КЦ «встреча проведена» — охват", [
      ["Всего карточек", stat.total],
      ["Без даты встречи", stat.noDate],
      ["Уже перенесены (метка карточки)", stat.alreadyMarked],
      ["Телефон клиента совпал с одной заявкой", stat.matchedOne],
      ["Телефон совпал с несколькими", stat.matchedMany],
      ["Телефон НЕ найден в базе", stat.matchedNone],
    ], stat.total);

    const recoverable = stat.recoverableByBrokerContact + stat.recoverableByRegistry;
    table("Что ещё можно разнести", [
      ["По контакту-брокеру на карточке", stat.recoverableByBrokerContact],
      ["По брокеру строки реестра", stat.recoverableByRegistry],
      ["ИТОГО новых встреч", recoverable],
      ["Брокеров, которых это коснётся", recoverBrokers.size],
      ["Отсечено дедупом (встреча в тот же день)", stat.dedupSameDay],
      ["Брокера определить нечем", stat.hopeless],
      ["Разошлось с брокером сделки — пропущено", stat.dealConflict],
    ], stat.total);
    if (conflicts.length) {
      console.log("\n  расхождения со сделкой (проверить руками):");
      for (const c of conflicts) console.log(`    ${c}`);
    }

    console.log("\n=== Новые встречи по годам ===");
    for (const y of [...byYear.keys()].sort()) console.log(`  ${y}: ${byYear.get(y)}`);
    console.log("\n  примеры:");
    for (const s of samples) console.log(`    ${s}`);
    if (WRITE) {
      console.log(`\nЗАПИСЬ ВЫПОЛНЕНА: создано встреч ${stat.created}, ошибок ${stat.writeErrors}`);
      for (const e of writeErrors) console.log(`    ${e}`);
    } else {
      console.log("\nПРОГОН БЕЗ ЗАПИСИ: база не изменена (нужны DRY_RUN=0 и CONFIRM=1).");
    }

  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || e);
  process.exit(1);
});
