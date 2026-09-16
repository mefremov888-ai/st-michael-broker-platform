/**
 * 2026-09-16: «Исполнитель по фиксации» — у кого он стоит и откуда взялся.
 *
 * Кабинет показывает брокеру плашку «Исполнитель по фиксации» вместо статуса
 * уникальности, когда создатель заявки (broker_id) и ответственный
 * (responsible_broker_id) — РАЗНЫЕ брокеры, а смотрит тот, кто ответственный.
 *
 * Два пути, как так получается:
 *   1) кто-то зафиксировал клиента НА этого брокера («Фиксирую на другого»);
 *   2) синхронизация с amoCRM: клиент с таким телефоном уже был у другого
 *      брокера, синк переиспользовал карточку и назначил нового брокера
 *      ответственным (amocrm.service.ts, правка 02.07).
 *
 * Скрипт только читает.
 */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const [{ total }] = await prisma.$queryRawUnsafe(
    `select count(*)::int as total from clients`,
  );
  const [{ delegated }] = await prisma.$queryRawUnsafe(
    `select count(*)::int as delegated from clients
      where responsible_broker_id is not null
        and responsible_broker_id <> broker_id`,
  );
  console.log(`Всего карточек клиентов: ${total}`);
  console.log(`Из них «создатель не равен ответственному»: ${delegated}`);

  const byMonth = await prisma.$queryRawUnsafe(
    `select to_char(created_at, 'YYYY-MM') as month, count(*)::int as cnt
       from clients
      where responsible_broker_id is not null
        and responsible_broker_id <> broker_id
      group by 1 order by 1`,
  );
  console.log("\nПо месяцам создания карточки:");
  for (const r of byMonth) console.log(`  ${r.month}: ${r.cnt}`);

  const byStatus = await prisma.$queryRawUnsafe(
    `select uniqueness_status as status, count(*)::int as cnt
       from clients
      where responsible_broker_id is not null
        and responsible_broker_id <> broker_id
      group by 1 order by 2 desc`,
  );
  console.log("\nПо статусу уникальности карточки:");
  for (const r of byStatus) console.log(`  ${r.status}: ${r.cnt}`);

  const rows = await prisma.$queryRawUnsafe(
    `select to_char(c.created_at, 'YYYY-MM-DD HH24:MI') as created,
            c.uniqueness_status as status,
            c.amo_lead_id::text as lead,
            left(c.full_name, 26) as client,
            left(bc.full_name, 24) as creator,
            left(br.full_name, 24) as responsible,
            left(coalesce(c.uniqueness_reason, ''), 60) as reason
       from clients c
       join brokers bc on bc.id = c.broker_id
       join brokers br on br.id = c.responsible_broker_id
      where c.responsible_broker_id is not null
        and c.responsible_broker_id <> c.broker_id
      order by c.created_at desc
      limit 25`,
  );
  console.log("\nПоследние 25 случаев:");
  for (const r of rows) {
    console.log(
      `${r.created} | ${r.status} | создал: ${r.creator} | ответственный: ${r.responsible} | лид ${r.lead || "—"} | ${r.client}`,
    );
    if (r.reason) console.log(`      причина: ${r.reason}`);
  }

  const [{ executors }] = await prisma.$queryRawUnsafe(
    `select count(distinct responsible_broker_id)::int as executors from clients
      where responsible_broker_id is not null and responsible_broker_id <> broker_id`,
  );
  console.log(`\nРазных брокеров в роли исполнителя: ${executors}`);

  const noOwn = await prisma.$queryRawUnsafe(
    `select count(*)::int as cnt from (
       select distinct c.responsible_broker_id as bid from clients c
        where c.responsible_broker_id is not null and c.responsible_broker_id <> c.broker_id
     ) x
     where not exists (select 1 from clients o where o.broker_id = x.bid)`,
  );
  console.log(`Из них не подавали ни одной своей заявки: ${noOwn[0].cnt}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
