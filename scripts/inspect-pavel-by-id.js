#!/usr/bin/env node
async function main() {
  const { PrismaClient } = require("@st-michael/database");
  const prisma = new PrismaClient();
  try {
    const c = await prisma.client.findUnique({
      where: { id: "f0e2c386-4c52-4a61-99ea-360382d3a08a" },
      select: { fullName: true, amoSyncStatus: true, amoSyncError: true, amoLeadId: true, amoSyncAttempts: true, amoSyncLastAttemptAt: true, fixationStatus: true, uniquenessStatus: true },
    });
    console.log(JSON.stringify(c, (k, v) => typeof v === "bigint" ? v.toString() : v, 2));
  } finally { await prisma.$disconnect(); }
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
