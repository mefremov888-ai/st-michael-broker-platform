/**
 * Одноразовая read-only развёртка (07.09.2026): «тихие» коллизии класса
 * Татьяны — брокеры, у которых amo по телефону возвращает НЕ тот контакт,
 * что записан в amo_contact_id. Плюс дубли телефонов среди самих брокеров.
 * Обходятся только ACTIVE брокеры с amo_contact_id (их немного), пауза 300мс.
 * Ничего не пишет.
 */
const { PrismaClient } = require("/app/node_modules/@prisma/client");

const PAUSE_MS = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (p) => (p ? String(p).slice(0, 5) + "***" : "—");

async function initAmo(prisma) {
  const { AmoCrmAdapter, setAmoTokens, setAmoTokenRefreshHook } =
    require("/app/packages/integrations/dist/amo-crm.adapter");
  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: ["AMO_ACCESS_TOKEN", "AMO_REFRESH_TOKEN"] } },
    select: { key: true, value: true },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  setAmoTokens(byKey.get("AMO_ACCESS_TOKEN") || "", byKey.get("AMO_REFRESH_TOKEN") || "");
  setAmoTokenRefreshHook(async (tokens) => {
    for (const [key, value] of [
      ["AMO_ACCESS_TOKEN", tokens.access],
      ["AMO_REFRESH_TOKEN", tokens.refresh],
    ]) {
      await prisma.systemSetting.upsert({
        where: { key },
        update: { value, updatedBy: "inspect-amo-mismatch" },
        create: { key, value, updatedBy: "inspect-amo-mismatch" },
      });
    }
  });
  return new AmoCrmAdapter();
}

async function main() {
  const prisma = new PrismaClient();

  // ─── 1. Дубли телефонов среди брокеров (чистый SQL, мгновенно) ───
  console.log("=== 1. Дубли основного телефона среди брокеров ===");
  const dupes = await prisma.$queryRaw`
    SELECT phone, COUNT(*)::int AS n,
           string_agg(left(full_name, 30) || CASE WHEN merged_into_id IS NOT NULL THEN ' [MERGED]' ELSE '' END, ' | ') AS names
    FROM brokers
    WHERE phone IS NOT NULL AND phone <> ''
    GROUP BY phone HAVING COUNT(*) > 1
    ORDER BY n DESC LIMIT 40`;
  console.log(`групп дублей: ${dupes.length}${dupes.length === 40 ? "+ (показаны первые 40)" : ""}`);
  for (const d of dupes) {
    console.log(`  ${mask(d.phone)} ×${d.n}: ${d.names}`);
  }
  console.log("");

  // ─── 2. Расхождения amo-контакта у ACTIVE брокеров ───
  const brokers = await prisma.broker.findMany({
    where: {
      status: "ACTIVE",
      role: "BROKER",
      mergedIntoId: null,
      NOT: [{ amoContactId: null }, { phone: null }],
    },
    select: { id: true, fullName: true, phone: true, amoContactId: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`=== 2. Сверка с amo: ACTIVE брокеров с amo-контактом: ${brokers.length} ===`);
  const amo = await initAmo(prisma);
  let checked = 0;
  let mismatches = 0;
  let notFound = 0;
  let errors = 0;
  for (const b of brokers) {
    let contact = null;
    try {
      contact = await amo.findBrokerContactByPhone(b.phone);
    } catch (e) {
      errors++;
      await sleep(PAUSE_MS);
      continue;
    }
    checked++;
    if (!contact) {
      notFound++;
    } else if (Number(b.amoContactId) !== Number(contact.id)) {
      mismatches++;
      const owner = await prisma.broker.findUnique({
        where: { amoContactId: BigInt(contact.id) },
        select: { id: true, fullName: true },
      });
      console.log(
        `  РАСХОЖДЕНИЕ: «${b.fullName}» (${mask(b.phone)}) БД=${b.amoContactId} amo=${contact.id} «${String(contact.name || "").slice(0, 40)}»` +
          (owner ? ` — контакт занят «${owner.fullName}»` : " — контакт в БД свободен"),
      );
    }
    await sleep(PAUSE_MS);
  }
  console.log("");
  console.log(
    `итог: проверено=${checked}, расхождений=${mismatches}, контакт-брокер в amo не найден=${notFound}, ошибок amo=${errors}`,
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(`FATAL: ${e?.message || e}`);
  process.exit(1);
});
