/**
 * 2026-09-16: кто создаёт заявки «на другого брокера» и что при этом
 * достаётся самому брокеру. Только чтение.
 */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const creators = await prisma.$queryRawUnsafe(
    `select left(b.full_name, 30) as creator, b.role::text as role, b.phone,
            count(*)::int as cnt,
            min(to_char(c.created_at,'YYYY-MM-DD')) as first_at,
            max(to_char(c.created_at,'YYYY-MM-DD')) as last_at
       from clients c join brokers b on b.id = c.broker_id
      where c.responsible_broker_id is not null and c.responsible_broker_id <> c.broker_id
      group by 1,2,3 order by 4 desc limit 10`);
  console.log("Кто создаёт заявки на другого брокера:");
  for (const r of creators)
    console.log(`  ${r.creator} | роль ${r.role} | ${r.phone} | ${r.cnt} шт | ${r.first_at}..${r.last_at}`);

  const deals = await prisma.$queryRawUnsafe(
    `select count(*)::int as cnt from deals d join clients c on c.id = d.client_id
      where c.responsible_broker_id is not null and c.responsible_broker_id <> c.broker_id`);
  console.log(`\nСделок по таким карточкам: ${deals[0].cnt}`);

  const meetings = await prisma.$queryRawUnsafe(
    `select count(*)::int as cnt from meetings m join clients c on c.id = m.client_id
      where c.responsible_broker_id is not null and c.responsible_broker_id <> c.broker_id`);
  console.log(`Встреч по таким карточкам: ${meetings[0].cnt}`);

  const reg = await prisma.$queryRawUnsafe(
    `select left(b.full_name,30) as creator, count(*)::int as cnt
       from clients c join brokers b on b.id = c.broker_id
      where c.responsible_broker_id is not null and c.responsible_broker_id <> c.broker_id
        and c.created_at > now() - interval '30 days'
      group by 1 order by 2 desc limit 5`);
  console.log("\nЗа последние 30 дней создавали:");
  for (const r of reg) console.log(`  ${r.creator}: ${r.cnt}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
