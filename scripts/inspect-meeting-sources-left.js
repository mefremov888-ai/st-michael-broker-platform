#!/usr/bin/env node
/**
 * 2026-09-14 (вопрос владельца «больше информации нет?»): ищем ещё не
 * использованные источники встреч в amoCRM. До сих пор мы брали только
 * воронку колл-центра 7600542 в статусе 142. Проверяем: есть ли встречи в
 * других воронках, заполнено ли поле «Дата и время встречи» у лидов, и
 * сколько таких лидов вообще. Только чтение.
 */
const PIPELINES = {
  7600542: "Колл-центр",
  7600546: "Продажи Берзарина",
  7600550: "Продажи Зорге 9",
  7600554: "Продажи Толбухина",
  10787390: "Брокеры",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function initAmo(prisma) {
  const { AmoCrmAdapter, setAmoTokens, setAmoTokenRefreshHook } = require("/app/packages/integrations/dist/amo-crm.adapter");
  const rows = await prisma.systemSetting.findMany({ where: { key: { in: ["AMO_ACCESS_TOKEN", "AMO_REFRESH_TOKEN"] } }, select: { key: true, value: true } });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  setAmoTokens(byKey.get("AMO_ACCESS_TOKEN") || "", byKey.get("AMO_REFRESH_TOKEN") || "");
  setAmoTokenRefreshHook(async (t) => {
    for (const [k, v] of [["AMO_ACCESS_TOKEN", t.access], ["AMO_REFRESH_TOKEN", t.refresh]])
      await prisma.systemSetting.upsert({ where: { key: k }, update: { value: v, updatedBy: "inspect" }, create: { key: k, value: v, updatedBy: "inspect" } });
  });
  return new AmoCrmAdapter();
}

const field = (lead, name) => {
  const f = (lead?.custom_fields_values || []).find((x) => String(x.field_name || "").toLowerCase().includes(name));
  return f?.values?.[0]?.value ?? null;
};

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const amo = await initAmo(prisma);
    const stat = {};
    for (const [pid, title] of Object.entries(PIPELINES)) {
      let page = 1, total = 0, withMeetingDate = 0, byStatus = {};
      for (;;) {
        let res;
        try { res = await amo["request"](`/leads?filter[pipeline_id]=${pid}&page=${page}&limit=250`); }
        catch (e) { console.error(`  воронка ${title}, страница ${page}: ${e?.message || e}`); break; }
        const list = res?._embedded?.leads || [];
        if (!list.length) break;
        for (const lead of list) {
          total++;
          byStatus[lead.status_id] = (byStatus[lead.status_id] || 0) + 1;
          const when = field(lead, "встреч");
          if (when) withMeetingDate++;
        }
        if (!res?._links?.next) break;
        page++;
        await sleep(280);
      }
      stat[title] = { total, withMeetingDate, byStatus };
      console.log(`  ${title}: лидов ${total}, с заполненной датой встречи ${withMeetingDate}`);
      const top = Object.entries(byStatus).sort((a, b) => b[1] - a[1]).slice(0, 5);
      console.log(`     топ статусов: ${top.map(([s, c]) => `${s}:${c}`).join("  ")}`);
    }

    const meetings = await prisma.meeting.count();
    const counted = await prisma.meeting.count({ where: { status: { in: ["CONFIRMED", "COMPLETED"] }, type: { not: "BROKER_TOUR" } } });
    console.log(`\n  встреч в базе: ${meetings}, из них засчитано: ${counted}`);
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
