#!/usr/bin/env node
/**
 * Read-only comparison of a broker's primary agency and amoCRM Company links.
 * Prints identifiers only: no names, phone numbers, emails, or INN values.
 */

(async () => {
  const brokerId = String(process.env.BROKER_ID || '').trim();
  if (!brokerId) {
    console.error('ERROR: BROKER_ID is required');
    process.exit(1);
  }

  const { PrismaClient } = require('@st-michael/database');
  const { AmoCrmAdapter } = require('@st-michael/integrations');
  const prisma = new PrismaClient();
  const amo = new AmoCrmAdapter();

  try {
    const broker = await prisma.broker.findUnique({
      where: { id: brokerId },
      select: {
        id: true,
        amoContactId: true,
        brokerAgencies: {
          where: { isPrimary: true },
          select: { agency: { select: { id: true, inn: true } } },
          take: 1,
        },
      },
    });
    if (!broker) throw new Error('BROKER_NOT_FOUND');

    const agency = broker.brokerAgencies[0]?.agency || null;
    if (!broker.amoContactId) throw new Error('BROKER_AMO_CONTACT_MISSING');
    if (!agency?.inn) throw new Error('BROKER_PRIMARY_AGENCY_MISSING');

    const expectedCompany = await amo.findCompanyByInn(agency.inn);
    const currentCompanyIds = await amo.getContactCompanyIds(
      Number(broker.amoContactId),
    );
    const expectedAmoCompanyId = expectedCompany?.id
      ? Number(expectedCompany.id)
      : null;
    const exactMatch =
      expectedAmoCompanyId !== null &&
      currentCompanyIds.length === 1 &&
      currentCompanyIds[0] === expectedAmoCompanyId;

    console.log(JSON.stringify({
      brokerId: broker.id,
      amoContactId: String(broker.amoContactId),
      primaryAgencyId: agency.id,
      expectedAmoCompanyId,
      currentCompanyIds,
      exactMatch,
      readOnly: true,
    }));
  } finally {
    await prisma.$disconnect();
  }
})().catch((error) => {
  console.error(`ERROR: ${error?.message || error}`);
  process.exit(1);
});
