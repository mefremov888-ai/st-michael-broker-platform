#!/usr/bin/env node
/**
 * 2026-09-17, решения владельца по трём заявкам, застрявшим в очереди amoCRM.
 *
 * 1) Клиент «Никита» (+7 915 401 88 36), две заявки от 13.08 от одного
 *    брокера в одну минуту. Одна упала на сетевой ошибке в дни блокировки
 *    нашего адреса в amoCRM, вторая встала на удержание из-за того же
 *    телефона. Уникальность истекла 12.09, лида в amo нет.
 *    Владелец 17.09: новую уникальность НЕ давать, в amo не отправлять.
 *    Помечаем удержанием, чтобы очередь их больше не брала, а автопроверка
 *    не считала сбоем отправки. Ничего не удаляем — записи остаются.
 *
 * 2) Клиент «Андрей» (+7 963 975 82 74), заявка от 10.09 на карточку
 *    брокера с номером +7 925 221 21 77 («Субоч Евгений»). Стоит на
 *    удержании, потому что у карточки не привязано агентство.
 *    В amoCRM контакт этого номера значится в агентстве AnivanEstate,
 *    владелец 17.09 подтвердил («главное чтобы номер совпал»).
 *    Привязываем агентство к брокеру и к заявке, сбрасываем счётчик
 *    попыток — дальше заявку подхватывает обычная очередь отправки.
 *
 * DRY_RUN=1 по умолчанию. Боевой режим: DRY_RUN=0 CONFIRM=1.
 */
const DRY_RUN = process.env.DRY_RUN !== "0";
const CONFIRMED = process.env.CONFIRM === "1" || process.env.CONFIRM === "true";
const WRITE = !DRY_RUN && CONFIRMED;

const NIKITA_PHONE = "+79154018836";
const SUBOCH_PHONE = "+79252212177";
const ANDREY_PHONE = "+79639758274";
const AGENCY_NAME = "AnivanEstate";
const HOLD_ERROR = "MANUAL_HOLD_EXPIRED_NOT_SENT";

const nameKey = (raw) => String(raw || "").toLowerCase().replace(/[^a-zа-я0-9]/g, "");

async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    console.log(`=== Режим: ${WRITE ? "APPLY (запись)" : "DRY-RUN (без записи)"} ===\n`);

    // --- 1. Заявки «Никита»: закрываем как несостоявшиеся ---
    const nikita = await prisma.client.findMany({
      where: {
        phone: NIKITA_PHONE,
        amoLeadId: null,
        amoSyncStatus: { in: ["FAILED", "PENDING"] },
      },
      select: {
        id: true, fullName: true, createdAt: true, uniquenessStatus: true,
        amoSyncStatus: true, amoSyncError: true, amoSyncAttempts: true,
      },
    });
    console.log(`1) Заявки «Никита» в очереди: ${nikita.length}`);
    for (const c of nikita) {
      console.log(`   ${c.fullName} · ${c.createdAt.toISOString().slice(0, 10)} · ${c.uniquenessStatus} · ${c.amoSyncStatus} · ${c.amoSyncError}`);
    }
    if (WRITE && nikita.length) {
      const res = await prisma.client.updateMany({
        where: { id: { in: nikita.map((c) => c.id) } },
        data: {
          amoSyncError: `${HOLD_ERROR}: уникальность истекла 12.09, решение владельца 17.09 — в amoCRM не отправлять`,
          amoSyncAttempts: 99,
        },
      });
      console.log(`   помечено удержанием: ${res.count}`);
      for (const c of nikita) {
        await prisma.auditLog.create({
          data: {
            action: "CLIENT_AMO_SYNC_ABANDONED",
            entity: "Client",
            entityId: c.id,
            payload: { reason: "expired_before_delivery", decidedBy: "owner", decidedAt: "2026-09-17", previousError: c.amoSyncError },
          },
        });
      }
    }

    // --- 2. Агентство для карточки Субоча ---
    const broker = await prisma.broker.findFirst({
      where: { phone: SUBOCH_PHONE },
      select: { id: true, fullName: true, displayName: true, phone: true, amoContactId: true },
    });
    console.log(`\n2) Брокер по номеру ${SUBOCH_PHONE}: ${broker ? `${broker.fullName} (имя для работы: ${broker.displayName}), контакт amo ${broker.amoContactId}` : "НЕ НАЙДЕН"}`);
    if (!broker) return;

    const agencies = await prisma.agency.findMany({ select: { id: true, name: true } });
    const exact = agencies.filter((a) => nameKey(a.name) === nameKey(AGENCY_NAME));
    console.log(`   карточек агентства «${AGENCY_NAME}»: ${exact.length}${exact.length ? " — " + exact.map((a) => a.name).join(", ") : ""}`);
    if (exact.length > 1) {
      console.log("   ОСТАНОВКА: под это название подходит несколько карточек — какая верная, решает человек.");
      for (const a of exact) console.log(`     · ${a.name}`);
      return;
    }
    // Карточки с таким названием в базе нет ни в одном написании (проверено
    // 17.09: ни «Anivan», ни «Аниван»). Заводим одну — название берём ровно
    // как в amoCRM. ИНН у нас NOT NULL и уникальный, поэтому ставим
    // детерминированный плейсхолдер, как делает импорт справочника агентств.
    let agency = exact[0];
    if (!agency) {
      const inn = "NOINN-" + require("crypto").createHash("sha1").update("anivanestate", "utf8").digest("hex").slice(0, 10);
      console.log(`   карточки нет ни в одном написании — заводим новую «${AGENCY_NAME}» (ИНН-плейсхолдер ${inn})`);
      if (WRITE) {
        agency = await prisma.agency.create({ data: { name: AGENCY_NAME, inn } });
        console.log("   карточка агентства создана");
      }
    }

    const links = await prisma.brokerAgency.findMany({ where: { brokerId: broker.id }, select: { id: true, agencyId: true } });
    console.log(`   агентств у брокера сейчас: ${links.length}`);

    const client = await prisma.client.findFirst({
      where: { phone: ANDREY_PHONE, brokerId: broker.id },
      select: { id: true, fullName: true, fixationAgencyId: true, amoSyncStatus: true, amoSyncAttempts: true, amoSyncError: true },
    });
    console.log(`   заявка «Андрей»: ${client ? `${client.fullName}, агентство ${client.fixationAgencyId || "не указано"}, ${client.amoSyncStatus}, попыток ${client.amoSyncAttempts}` : "НЕ НАЙДЕНА"}`);

    if (!WRITE) {
      console.log("\nПРОГОН БЕЗ ЗАПИСИ: база не изменена (нужны DRY_RUN=0 и CONFIRM=1).");
      return;
    }

    if (!links.length) {
      await prisma.brokerAgency.create({ data: { brokerId: broker.id, agencyId: agency.id, isPrimary: true } });
      console.log(`   агентство «${agency.name}» привязано к карточке брокера`);
    }
    if (client) {
      await prisma.client.update({
        where: { id: client.id },
        data: {
          fixationAgencyId: agency.id,
          amoSyncStatus: "PENDING",
          amoSyncAttempts: 0,
          amoSyncError: null,
        },
      });
      console.log("   заявка отпущена в очередь отправки (попытки обнулены)");
      await prisma.auditLog.create({
        data: {
          action: "CLIENT_AMO_SYNC_RELEASED",
          entity: "Client",
          entityId: client.id,
          payload: { agency: agency.name, decidedBy: "owner", decidedAt: "2026-09-17" },
        },
      });
    }
    console.log("\nЗАПИСЬ ВЫПОЛНЕНА.");
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
