#!/usr/bin/env node
// 2026-09-24: точная проверка, какой id в каком поле у заявки Таисии.
async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const c = await prisma.client.findUnique({
      where: { id: "982de355-993b-4303-b0d8-61f005028c89" },
      select: { id: true, brokerId: true, responsibleBrokerId: true, amoSyncError: true },
    });
    console.log("client.id:", c?.id);
    console.log("client.brokerId:", c?.brokerId);
    console.log("client.responsibleBrokerId:", c?.responsibleBrokerId);
    console.log("ALERT_ID: 6e414141-f2ca-4c71-8402-2032c9186568");
    console.log("brokerId === ALERT_ID:", c?.brokerId === "6e414141-f2ca-4c71-8402-2032c9186568");
    console.log("responsibleBrokerId === ALERT_ID:", c?.responsibleBrokerId === "6e414141-f2ca-4c71-8402-2032c9186568");
    console.log("amoSyncError raw:", c?.amoSyncError);
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
