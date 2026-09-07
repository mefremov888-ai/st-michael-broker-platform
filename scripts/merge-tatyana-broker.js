#!/usr/bin/env node
/**
 * 2026-09-07: склейка дублей брокера «Татьяна брокер» — лечение ежечасной
 * ошибки «amoCRM sync failed … Unique constraint failed on (amo_contact_id)».
 *
 * Причина: синк (scheduler.service.ts, handleAmoCrmSync) по телефону Татьяны
 * получает из amo contact id, который в БД уже занят ДРУГИМ брокером
 * (amo_contact_id @unique) → P2002 каждый час.
 *
 * Лечение — слить две карточки одного человека, зеркаля ручную склейку
 * /admin/broker-dedup (admin.service.ts, mergeBrokerDuplicates):
 *   • выживает брокер с реальными данными (больше клиентов / новее активность;
 *     карточка с паролем кабинета выживает ВСЕГДА — иначе умрёт логин);
 *   • телефоны слитого → broker_phones выжившего;
 *   • клиенты / сделки / встречи / звонки / call_logs / агентства → выжившему;
 *   • пустые поля выжившего обогащаются из слитого;
 *   • amo_contact_id: у слитого освобождается, выживший получает id, который
 *     amo реально возвращает по его телефону (кандидат синка) — конфликт
 *     исчезает; если amo недоступен — просто освобождаем id слитого, синк
 *     сам допишет правильный id на следующем прогоне (уже без P2002);
 *   • слитый помечается mergedIntoId / mergedAt / isInBase=false /
 *     doNotCall=true. НИЧЕГО НЕ УДАЛЯЕТСЯ.
 *
 * Управление (env):
 *   DRY_RUN=1 (default) — только план, без записи; DRY_RUN=0 — применить.
 *   SURVIVOR_ID / LOSER_ID — задать пару явно (id из inspect-tatyana-dup.js).
 *     Без них скрипт сам находит пару: «Татьяна брокер» + владелец
 *     конфликтующего amo_contact_id, и выбирает выжившего по правилу выше.
 *
 * Запуск в контейнере api (workflow apply-merge-tatyana-broker.yml):
 *   DRY_RUN=1 node /app/scripts/merge-tatyana-broker.js
 */

const DRY_RUN = process.env.DRY_RUN !== "0";
const ENV_SURVIVOR = (process.env.SURVIVOR_ID || "").trim();
const ENV_LOSER = (process.env.LOSER_ID || "").trim();

const mask = (p) => (p ? String(p).slice(0, 5) + "***" : "—");

const BROKER_SELECT = {
  id: true, fullName: true, phone: true, email: true, amoContactId: true,
  telegramChatId: true, telegramUsername: true, whatsappUsername: true,
  position: true, specialization: true, region: true, isRegional: true,
  isCoordinator: true, coordinatorAgency: true, doNotCall: true,
  category: true, lastCallAt: true, status: true, role: true,
  mergedIntoId: true, passwordHash: true, createdAt: true,
};

(async () => {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();

  const counts = async (id) => {
    const [clients, deals, meetings, calls, callLogs, respClients] = await Promise.all([
      prisma.client.count({ where: { brokerId: id } }),
      prisma.deal.count({ where: { brokerId: id } }),
      prisma.meeting.count({ where: { brokerId: id } }),
      prisma.call.count({ where: { brokerId: id } }),
      prisma.callLog.count({ where: { brokerId: id } }),
      prisma.client.count({ where: { responsibleBrokerId: id } }),
    ]);
    const lastClient = await prisma.client.findFirst({
      where: { brokerId: id },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    return { clients, deals, meetings, calls, callLogs, respClients, lastClientAt: lastClient?.createdAt || null };
  };

  const show = (b, c, label) => {
    console.log(`${label}: ${b.id}`);
    console.log(`  «${b.fullName}» | ${mask(b.phone)} | amo=${b.amoContactId ?? "NULL"} | ${b.status}/${b.role}` +
      `${b.passwordHash ? " | ПАРОЛЬ КАБИНЕТА" : ""}${b.mergedIntoId ? " | УЖЕ СЛИТ" : ""}`);
    console.log(`  клиенты=${c.clients} (отв.=${c.respClients}) сделки=${c.deals} встречи=${c.meetings} ` +
      `звонки=${c.calls} call_logs=${c.callLogs} | последний клиент: ` +
      `${c.lastClientAt ? c.lastClientAt.toISOString().slice(0, 10) : "—"}`);
  };

  try {
    console.log(`=== Режим: ${DRY_RUN ? "DRY-RUN (только план)" : "APPLY (запись в БД!)"} ===\n`);

    // ─── amo (нужен и для авто-поиска пары, и для целевого amo_contact_id) ───
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
            update: { value, updatedBy: "merge-tatyana-broker" },
            create: { key, value, updatedBy: "merge-tatyana-broker" },
          });
        }
        console.error("amo tokens refreshed and persisted");
      });
      amo = new AmoCrmAdapter();
    } catch (e) {
      console.log(`amoCRM-адаптер недоступен (${e?.message || e}) — работаем только по БД.\n`);
    }

    // ─── 1. Находим пару ───
    let a = null; // первая карточка (Татьяна с конфликтом)
    let b = null; // вторая карточка (владелец конфликтующего id)
    if (ENV_SURVIVOR && ENV_LOSER) {
      a = await prisma.broker.findUnique({ where: { id: ENV_SURVIVOR }, select: BROKER_SELECT });
      b = await prisma.broker.findUnique({ where: { id: ENV_LOSER }, select: BROKER_SELECT });
      if (!a || !b) throw new Error("SURVIVOR_ID/LOSER_ID: брокер не найден в БД");
      if (a.id === b.id) throw new Error("SURVIVOR_ID и LOSER_ID совпадают");
    } else {
      const tatyanas = await prisma.broker.findMany({
        where: {
          AND: [
            { fullName: { contains: "татьяна", mode: "insensitive" } },
            { fullName: { contains: "брокер", mode: "insensitive" } },
          ],
          mergedIntoId: null,
        },
        select: BROKER_SELECT,
        orderBy: { createdAt: "asc" },
      });
      if (tatyanas.length === 0) throw new Error("«Татьяна брокер» не найдена (mergedIntoId=null)");

      // Ищем ту, у кого lookup синка даёт ЧУЖОЙ contact id.
      for (const t of tatyanas) {
        if (!t.phone || !amo) continue;
        const contact = await amo.findBrokerContactByPhone(t.phone).catch(() => null);
        if (!contact) continue;
        if (t.amoContactId && Number(t.amoContactId) === contact.id) continue; // конфликта нет
        const owner = await prisma.broker.findUnique({
          where: { amoContactId: BigInt(contact.id) },
          select: BROKER_SELECT,
        });
        if (owner && owner.id !== t.id) { a = t; b = owner; break; }
      }
      // Fallback без amo: второй брокер с тем же телефоном.
      if (!a) {
        for (const t of tatyanas) {
          const digits = String(t.phone || "").replace(/\D/g, "").slice(-10);
          if (digits.length < 10) continue;
          const twin = await prisma.broker.findFirst({
            where: {
              id: { not: t.id },
              mergedIntoId: null,
              OR: [
                { phone: { endsWith: digits } },
                { phones: { some: { phone: { endsWith: digits } } } },
              ],
            },
            select: BROKER_SELECT,
          });
          if (twin) { a = t; b = twin; break; }
        }
      }
      if (!a || !b) {
        throw new Error(
          "Пара дублей не найдена автоматически. Запустите inspect-tatyana-dup.js " +
            "и передайте SURVIVOR_ID/LOSER_ID явно.",
        );
      }
    }

    if (a.mergedIntoId || b.mergedIntoId) throw new Error("Одна из карточек уже слита — стоп.");
    if (a.role !== "BROKER" || b.role !== "BROKER") throw new Error("Сливать можно только role=BROKER — стоп.");

    const ca = await counts(a.id);
    const cb = await counts(b.id);
    console.log("─── Кандидаты на склейку ───");
    show(a, ca, "Карточка A");
    show(b, cb, "Карточка B");
    console.log("");

    // ─── 2. Выбор выжившего ───
    let survivor, loser, cs, cl, reason;
    if (ENV_SURVIVOR && ENV_LOSER) {
      survivor = a; loser = b; cs = ca; cl = cb;
      reason = "задан явно через SURVIVOR_ID/LOSER_ID";
    } else if (a.passwordHash && b.passwordHash) {
      throw new Error("ОБЕ карточки зарегистрированы в кабинете — авто-склейка запрещена, только руками.");
    } else if (a.passwordHash !== null && !b.passwordHash) {
      survivor = a; loser = b; cs = ca; cl = cb;
      reason = "у A пароль кабинета (логин должен выжить)";
    } else if (b.passwordHash !== null && !a.passwordHash) {
      survivor = b; loser = a; cs = cb; cl = ca;
      reason = "у B пароль кабинета (логин должен выжить)";
    } else if (ca.clients !== cb.clients) {
      [survivor, loser, cs, cl] = ca.clients > cb.clients ? [a, b, ca, cb] : [b, a, cb, ca];
      reason = "больше клиентов";
    } else if (ca.deals !== cb.deals) {
      [survivor, loser, cs, cl] = ca.deals > cb.deals ? [a, b, ca, cb] : [b, a, cb, ca];
      reason = "больше сделок";
    } else {
      const ta = ca.lastClientAt?.getTime() || a.createdAt.getTime();
      const tb = cb.lastClientAt?.getTime() || b.createdAt.getTime();
      [survivor, loser, cs, cl] = ta >= tb ? [a, b, ca, cb] : [b, a, cb, ca];
      reason = "новее активность";
    }
    // Страховки как в admin.service.ts: карточка с паролем не может быть слита.
    if (loser.passwordHash && survivor.passwordHash) {
      throw new Error("Обе карточки зарегистрированы в кабинете — такое слияние делаем только руками.");
    }
    if (loser.passwordHash && !survivor.passwordHash) {
      throw new Error(`«${loser.fullName}» зарегистрирован в кабинете — он должен быть выжившим. Поменяйте SURVIVOR_ID/LOSER_ID.`);
    }

    // ─── 3. Целевой amo_contact_id выжившего ───
    // Тот id, который amo реально возвращает по телефону выжившего, — его и
    // будет писать синк. Если amo молчит: берём id слитого (если у выжившего
    // нет своего) или оставляем как есть — конфликт снят освобождением id.
    let targetAmoId = survivor.amoContactId ? BigInt(survivor.amoContactId) : null;
    let targetAmoSrc = "текущий id выжившего";
    if (amo && survivor.phone) {
      const contact = await amo.findBrokerContactByPhone(survivor.phone).catch(() => null);
      if (contact) { targetAmoId = BigInt(contact.id); targetAmoSrc = "lookup amo по телефону выжившего"; }
    }
    if (!targetAmoId && loser.amoContactId) {
      targetAmoId = BigInt(loser.amoContactId);
      targetAmoSrc = "id слитого (у выжившего не было)";
    }

    console.log("─── План склейки ───");
    console.log(`ВЫЖИВАЕТ: ${survivor.id} «${survivor.fullName}» — ${reason}`);
    console.log(`СЛИВАЕТСЯ: ${loser.id} «${loser.fullName}»`);
    console.log(`Переносится выжившему: клиенты=${cl.clients} (+отв.=${cl.respClients}) сделки=${cl.deals} ` +
      `встречи=${cl.meetings} звонки=${cl.calls} call_logs=${cl.callLogs}`);
    console.log(`amo_contact_id: у слитого ${loser.amoContactId ?? "NULL"} → NULL; ` +
      `у выжившего ${survivor.amoContactId ?? "NULL"} → ${targetAmoId ?? "NULL"} (${targetAmoSrc})`);
    console.log(`Телефон слитого ${mask(loser.phone)} → broker_phones выжившего. Ничего не удаляется.\n`);

    if (DRY_RUN) {
      console.log("DRY-RUN: ничего не изменено. Для применения запустите с DRY_RUN=0.");
      return;
    }

    // ─── 4. Применение (одна транзакция, зеркало admin.service.ts) ───
    await prisma.$transaction(async (tx) => {
      // 1. Телефоны слитого → broker_phones выжившего (unique(phone) — skipDuplicates).
      const loserPhones = await tx.brokerPhone.findMany({ where: { brokerId: loser.id } });
      await tx.brokerPhone.createMany({
        data: [
          ...(loser.phone ? [{ brokerId: survivor.id, phone: loser.phone }] : []),
          ...loserPhones.map((p) => ({ brokerId: survivor.id, phone: p.phone })),
        ],
        skipDuplicates: true,
      });
      await tx.brokerPhone.deleteMany({ where: { brokerId: loser.id } });

      // 2. История и связи → выжившему.
      const r1 = await tx.callLog.updateMany({ where: { brokerId: loser.id }, data: { brokerId: survivor.id } });
      const r2 = await tx.client.updateMany({ where: { brokerId: loser.id }, data: { brokerId: survivor.id } });
      const r3 = await tx.client.updateMany({ where: { responsibleBrokerId: loser.id }, data: { responsibleBrokerId: survivor.id } });
      const r4 = await tx.deal.updateMany({ where: { brokerId: loser.id }, data: { brokerId: survivor.id } });
      const r5 = await tx.meeting.updateMany({ where: { brokerId: loser.id }, data: { brokerId: survivor.id } });
      const r6 = await tx.call.updateMany({ where: { brokerId: loser.id }, data: { brokerId: survivor.id } });

      // Агентства: переносим только отсутствующие у выжившего.
      const loserAgencies = await tx.brokerAgency.findMany({ where: { brokerId: loser.id } });
      for (const ba of loserAgencies) {
        const exists = await tx.brokerAgency.findUnique({
          where: { brokerId_agencyId: { brokerId: survivor.id, agencyId: ba.agencyId } },
        });
        if (!exists) {
          await tx.brokerAgency.update({ where: { id: ba.id }, data: { brokerId: survivor.id, isPrimary: false } });
        } else {
          await tx.brokerAgency.delete({ where: { id: ba.id } });
        }
      }

      // 3. Обогащение пустых полей выжившего + amo_contact_id.
      const catRank = { CONVERTED: 5, HOT: 4, WARM: 3, COLD: 2, ON_BOT_REVIEW: 1, BLACKLIST: 0 };
      const patch = {};
      if (!survivor.email && loser.email) patch.email = loser.email;
      if (!survivor.position && loser.position) patch.position = loser.position;
      if (!survivor.telegramUsername && loser.telegramUsername) patch.telegramUsername = loser.telegramUsername;
      if (!survivor.whatsappUsername && loser.whatsappUsername) patch.whatsappUsername = loser.whatsappUsername;
      if (!survivor.specialization && loser.specialization) patch.specialization = loser.specialization;
      if (!survivor.region && loser.region) patch.region = loser.region;
      if (loser.isRegional && !survivor.isRegional) patch.isRegional = true;
      if (loser.isCoordinator && !survivor.isCoordinator) patch.isCoordinator = true;
      if (!survivor.coordinatorAgency && loser.coordinatorAgency) patch.coordinatorAgency = loser.coordinatorAgency;
      if ((catRank[loser.category] ?? 0) > (catRank[survivor.category] ?? 0)) patch.category = loser.category;
      if (loser.lastCallAt && (!survivor.lastCallAt || loser.lastCallAt > survivor.lastCallAt)) patch.lastCallAt = loser.lastCallAt;

      // Unique-поля освобождаем у слитого ДО записи выжившему.
      await tx.broker.update({
        where: { id: loser.id },
        data: { amoContactId: null, telegramChatId: null },
      });
      if (targetAmoId && (!survivor.amoContactId || BigInt(survivor.amoContactId) !== targetAmoId)) {
        patch.amoContactId = targetAmoId;
      }
      if (!survivor.telegramChatId && loser.telegramChatId) patch.telegramChatId = loser.telegramChatId;
      if (Object.keys(patch).length > 0) {
        await tx.broker.update({ where: { id: survivor.id }, data: patch });
      }

      // 4. Помечаем слитого (НЕ удаляем).
      await tx.broker.update({
        where: { id: loser.id },
        data: { mergedIntoId: survivor.id, mergedAt: new Date(), isInBase: false, doNotCall: true },
      });

      await tx.auditLog.create({
        data: {
          userId: null,
          action: "BROKER_DEDUP_MERGE",
          entity: "Broker",
          entityId: survivor.id,
          payload: {
            via: "scripts/merge-tatyana-broker.js",
            primaryId: survivor.id,
            duplicateIds: [loser.id],
            movedClients: r2.count,
            movedResponsible: r3.count,
            movedDeals: r4.count,
            movedMeetings: r5.count,
            movedCalls: r6.count,
            movedCallLogs: r1.count,
            amoContactId: targetAmoId ? String(targetAmoId) : null,
          },
        },
      });

      console.log(`ГОТОВО: перенесено клиентов=${r2.count} (отв.=${r3.count}) сделок=${r4.count} ` +
        `встреч=${r5.count} звонков=${r6.count} call_logs=${r1.count}.`);
      console.log(`Выживший ${survivor.id} amo_contact_id=${targetAmoId ?? "NULL"}; ` +
        `слитый ${loser.id} помечен mergedIntoId.`);
    });
    console.log("\n=== Склейка применена. Проверьте лог синка через час: ошибка P2002 должна исчезнуть. ===");
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
