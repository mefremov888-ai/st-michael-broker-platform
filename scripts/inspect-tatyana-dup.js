#!/usr/bin/env node
/**
 * 2026-09-07: диагностика (read-only) для брокера «Татьяна брокер».
 *
 * Симптом: каждый час в логах api —
 *   «amoCRM sync failed for broker Татьяна брокер:
 *    Unique constraint failed on the fields: (amo_contact_id)».
 *
 * Механика (scheduler.service.ts, handleAmoCrmSync): для каждого ACTIVE
 * брокера с amo_contact_id синк вызывает amo.findBrokerContactByPhone(phone);
 * если amo вернул ДРУГОЙ contact id — пытается записать его брокеру:
 *   prisma.broker.update({ data: { amoContactId: brokerContact.id } })
 * Если этот contact id уже занят другим брокером (amo_contact_id @unique) —
 * падает P2002 и весь синк этого брокера прерывается.
 *
 * Скрипт:
 *   1. Печатает всех брокеров с ФИО ~ «Татьяна брокер» (полностью) и
 *      сводку по прочим «Татьянам» (кратко).
 *   2. Для каждой «Татьяны брокер» повторяет lookup синка
 *      (findBrokerContactByPhone — только чтение amo) и вычисляет
 *      КАНДИДАТА amo_contact_id, который синк пытается ей записать.
 *   3. Находит в БД брокера-ВЛАДЕЛЬЦА конфликтующего id и печатает
 *      обе карточки с counters: клиенты / сделки / встречи / звонки.
 *   4. Fallback без amo: брокеры, у которых совпадает телефон
 *      (brokers.phone или broker_phones.phone).
 *
 * В БД НИЧЕГО не пишет (кроме персиста ротации amo-токенов — обязательная
 * механика refresh_token, как в cleanup-test-agencies.js).
 *
 * Запуск в контейнере api: node /app/scripts/inspect-tatyana-dup.js
 */

const last10 = (p) => String(p || "").replace(/\D/g, "").slice(-10);
const mask = (p) => (p ? String(p).slice(0, 5) + "***" : "—");

(async () => {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();

  const brokerCounts = async (id) => {
    const [clients, deals, meetings, calls] = await Promise.all([
      prisma.client.count({ where: { brokerId: id } }),
      prisma.deal.count({ where: { brokerId: id } }),
      prisma.meeting.count({ where: { brokerId: id } }),
      prisma.call.count({ where: { brokerId: id } }),
    ]);
    return { clients, deals, meetings, calls };
  };

  const printBroker = async (b, label) => {
    const c = await brokerCounts(b.id);
    const extraPhones = await prisma.brokerPhone.findMany({
      where: { brokerId: b.id },
      select: { phone: true, isPrimary: true },
    });
    const lastClient = await prisma.client.findFirst({
      where: { brokerId: b.id },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    console.log(`${label}`);
    console.log(`  id:             ${b.id}`);
    console.log(`  full_name:      «${b.fullName}»`);
    console.log(`  phone:          ${mask(b.phone)}`);
    console.log(`  amo_contact_id: ${b.amoContactId ?? "NULL"}`);
    console.log(`  status/role:    ${b.status} / ${b.role}`);
    console.log(`  merged_into_id: ${b.mergedIntoId ?? "—"}`);
    console.log(`  password:       ${b.passwordHash ? "ЕСТЬ (зарегистрирован в кабинете!)" : "нет"}`);
    console.log(`  created_at:     ${b.createdAt?.toISOString?.().slice(0, 10)}`);
    console.log(`  клиенты=${c.clients} сделки=${c.deals} встречи=${c.meetings} звонки=${c.calls}`);
    console.log(`  последний клиент: ${lastClient ? lastClient.createdAt.toISOString().slice(0, 10) : "—"}`);
    if (extraPhones.length > 0) {
      console.log(`  broker_phones:  ${extraPhones.map((p) => mask(p.phone)).join(", ")}`);
    }
    console.log("");
    return c;
  };

  const brokerSelect = {
    id: true, fullName: true, phone: true, amoContactId: true,
    status: true, role: true, mergedIntoId: true, passwordHash: true,
    createdAt: true,
  };

  try {
    console.log("=== 1. Брокеры «Татьяна брокер» (полная выборка) ===\n");
    const tatyanaBrokers = await prisma.broker.findMany({
      where: {
        AND: [
          { fullName: { contains: "татьяна", mode: "insensitive" } },
          { fullName: { contains: "брокер", mode: "insensitive" } },
        ],
      },
      select: brokerSelect,
      orderBy: { createdAt: "asc" },
    });
    if (tatyanaBrokers.length === 0) {
      console.log("Не найдено ни одного брокера с ФИО «*татьяна*брокер*».\n");
    }
    for (const b of tatyanaBrokers) await printBroker(b, "─── Татьяна брокер ───");

    const allTatyana = await prisma.broker.count({
      where: { fullName: { contains: "татьяна", mode: "insensitive" } },
    });
    const tatyanaWithAmo = await prisma.broker.findMany({
      where: {
        fullName: { contains: "татьяна", mode: "insensitive" },
        amoContactId: { not: null },
        status: "ACTIVE",
        NOT: { id: { in: tatyanaBrokers.map((b) => b.id) } },
      },
      select: brokerSelect,
      orderBy: { createdAt: "asc" },
      take: 20,
    });
    console.log(`Всего «Татьян» в базе: ${allTatyana}.`);
    console.log(`Из них ACTIVE с amo_contact_id (кроме уже показанных, top-20): ${tatyanaWithAmo.length}`);
    for (const b of tatyanaWithAmo) {
      console.log(
        `  • ${b.id} | «${b.fullName}» | ${mask(b.phone)} | amo=${b.amoContactId} | ${b.status}/${b.role}` +
          `${b.mergedIntoId ? " | MERGED" : ""}`,
      );
    }
    console.log("");

    // ─── 2. Кандидат amo_contact_id — повторяем lookup синка (read-only) ───
    console.log("=== 2. Кандидат из amoCRM (findBrokerContactByPhone, как в синке) ===\n");
    let amoOk = false;
    let amo = null;
    try {
      const {
        AmoCrmAdapter, setAmoTokens, setAmoTokenRefreshHook,
      } = require("/app/packages/integrations/dist/amo-crm.adapter");
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
            update: { value, updatedBy: "inspect-tatyana-dup" },
            create: { key, value, updatedBy: "inspect-tatyana-dup" },
          });
        }
        console.error("amo tokens refreshed and persisted");
      });
      amo = new AmoCrmAdapter();
      amoOk = true;
    } catch (e) {
      console.log(`amoCRM-адаптер недоступен, раздел пропущен: ${e?.message || e}\n`);
    }

    const conflictOwnerIds = new Set();
    if (amoOk) {
      for (const b of tatyanaBrokers) {
        if (!b.phone) continue;
        let contact = null;
        try {
          contact = await amo.findBrokerContactByPhone(b.phone);
        } catch (e) {
          console.log(`  «${b.fullName}»: ошибка amo — ${e?.message || e}`);
          continue;
        }
        if (!contact) {
          console.log(`  «${b.fullName}» (${mask(b.phone)}): amo контакт-брокер по телефону НЕ найден.`);
          continue;
        }
        const current = b.amoContactId ? Number(b.amoContactId) : null;
        console.log(`  «${b.fullName}» (${mask(b.phone)}):`);
        console.log(`    текущий amo_contact_id в БД: ${current ?? "NULL"}`);
        console.log(`    кандидат из amo:             ${contact.id} («${contact.name || ""}»)`);
        if (current === contact.id) {
          console.log("    совпадают — конфликт по этому брокеру сейчас не воспроизводится.");
        } else {
          console.log("    НЕ совпадают → синк попытается записать кандидата → вот источник P2002.");
          const owner = await prisma.broker.findUnique({
            where: { amoContactId: BigInt(contact.id) },
            select: brokerSelect,
          });
          if (owner) {
            conflictOwnerIds.add(owner.id);
            console.log(`    владелец кандидата в БД: ${owner.id} «${owner.fullName}»`);
          } else {
            console.log("    кандидат в БД никем не занят — тогда причина не в этом id.");
          }
        }
        console.log("");
      }
    }

    if (conflictOwnerIds.size > 0) {
      console.log("=== 3. Карточки владельцев конфликтующего amo_contact_id ===\n");
      for (const id of conflictOwnerIds) {
        const owner = await prisma.broker.findUnique({ where: { id }, select: brokerSelect });
        if (owner) await printBroker(owner, "─── Владелец конфликтующего id ───");
      }
    }

    // ─── 4. Fallback: совпадения по телефону в самой БД ───
    console.log("=== 4. Брокеры с совпадающим телефоном (по БД, без amo) ===\n");
    for (const b of tatyanaBrokers) {
      const digits = last10(b.phone);
      if (digits.length < 10) continue;
      const samePhone = await prisma.broker.findMany({
        where: {
          id: { not: b.id },
          OR: [
            { phone: { endsWith: digits } },
            { phones: { some: { phone: { endsWith: digits } } } },
          ],
        },
        select: brokerSelect,
      });
      if (samePhone.length === 0) {
        console.log(`  «${b.fullName}»: других брокеров с тем же телефоном в БД нет.`);
      } else {
        for (const o of samePhone) {
          await printBroker(o, `─── Совпадение телефона с «${b.fullName}» ───`);
        }
      }
    }
    console.log("\n=== Диагностика завершена (read-only) ===");
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
