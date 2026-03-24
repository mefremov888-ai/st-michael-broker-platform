import { PrismaClient, CommissionLevel, Project, UniquenessStatus, BrokerFunnelStage, BrokerSource, FixationStatus, ClientStatus, DealStatus, LotStatus, MeetingType, MeetingStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting seed...');

  // Create Agencies
  const agency1 = await prisma.agency.create({
    data: {
      name: 'Недвижимость+',
      legalName: 'ООО "Недвижимость+"',
      inn: '7701234567',
      phone: '+74951234567',
      email: 'info@nedvizh-plus.ru',
      address: 'Москва, ул. Ленина, 10',
      totalSqmSold: 150.5,
      commissionLevel: CommissionLevel.STRONG,
      quarterlyBonusStreak: 2,
    },
  });

  const agency2 = await prisma.agency.create({
    data: {
      name: 'Тренд',
      legalName: 'ИП Иванов Иван Иванович',
      inn: '7709876543',
      phone: '+74959876543',
      email: 'trend@realty.ru',
      address: 'Москва, пр. Мира, 25',
      totalSqmSold: 320.0,
      commissionLevel: CommissionLevel.ELITE,
      quarterlyBonusStreak: 1,
    },
  });

  const agency3 = await prisma.agency.create({
    data: {
      name: 'Ромашка',
      legalName: 'ООО "Ромашка"',
      inn: '7705551234',
      phone: '+74955551234',
      email: 'romashka@agency.ru',
      address: 'Москва, ул. Цветочная, 5',
      totalSqmSold: 75.0,
      commissionLevel: CommissionLevel.BASIC,
      quarterlyBonusStreak: 0,
    },
  });

  // Create Brokers
  const broker1 = await prisma.broker.create({
    data: {
      fullName: 'Александр Петров',
      phone: '+79001234567',
      email: 'alex.petrov@email.com',
      role: 'BROKER',
      status: 'ACTIVE',
      funnelStage: BrokerFunnelStage.DEAL,
      source: BrokerSource.BROKER_CABINET,
      brokerTourVisited: true,
      brokerTourDate: new Date('2024-01-15'),
      doNotCall: false,
      bestCallTime: '10:00-18:00',
      brokerAgencies: {
        create: [
          { agencyId: agency1.id, isPrimary: true },
          { agencyId: agency2.id, isPrimary: false },
        ],
      },
    },
  });

  const broker2 = await prisma.broker.create({
    data: {
      fullName: 'Мария Сидорова',
      phone: '+79009876543',
      email: 'maria.sidorova@email.com',
      role: 'BROKER',
      status: 'ACTIVE',
      funnelStage: BrokerFunnelStage.FIXATION,
      source: BrokerSource.CRM_MANUAL,
      brokerTourVisited: true,
      brokerTourDate: new Date('2024-02-01'),
      doNotCall: false,
      bestCallTime: '09:00-17:00',
      brokerAgencies: {
        create: [
          { agencyId: agency2.id, isPrimary: true },
        ],
      },
    },
  });

  const broker3 = await prisma.broker.create({
    data: {
      fullName: 'Дмитрий Иванов',
      phone: '+79005551234',
      email: 'dmitry.ivanov@email.com',
      role: 'BROKER',
      status: 'ACTIVE',
      funnelStage: BrokerFunnelStage.MEETING,
      source: BrokerSource.PHONE_CALL,
      brokerTourVisited: false,
      doNotCall: true,
      bestCallTime: '11:00-19:00',
      brokerAgencies: {
        create: [
          { agencyId: agency3.id, isPrimary: true },
        ],
      },
    },
  });

  // Create Clients
  const client1 = await prisma.client.create({
    data: {
      brokerId: broker1.id,
      fullName: 'Елена Козлова',
      phone: '+79011112233',
      email: 'elena.kozlova@email.com',
      comment: 'Интересуется 2-к квартирой',
      project: Project.ZORGE9,
      fixationAgencyId: agency1.id,
      uniquenessStatus: UniquenessStatus.CONDITIONALLY_UNIQUE,
      uniquenessExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      fixationStatus: FixationStatus.FIXED,
      fixationExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      inspectionActSigned: true,
      status: ClientStatus.BOOKED,
    },
  });

  const client2 = await prisma.client.create({
    data: {
      brokerId: broker2.id,
      fullName: 'Андрей Николаев',
      phone: '+79022223344',
      email: 'andrey.nikolaev@email.com',
      comment: 'Звонил по рекламе',
      project: Project.ZORGE9,
      fixationAgencyId: agency2.id,
      uniquenessStatus: UniquenessStatus.UNDER_REVIEW,
      uniquenessReason: 'Клиент на квалификации у другого брокера',
      fixationStatus: FixationStatus.NOT_FIXED,
      status: ClientStatus.NEW,
    },
  });

  const client3 = await prisma.client.create({
    data: {
      brokerId: broker1.id,
      fullName: 'Ольга Сергеева',
      phone: '+79033334455',
      email: 'olga.sergeeva@email.com',
      comment: 'Переоткрыта закрытая сделка',
      project: Project.ZORGE9,
      fixationAgencyId: agency1.id,
      uniquenessStatus: UniquenessStatus.CONDITIONALLY_UNIQUE,
      uniquenessReason: 'Переоткрыта закрытая сделка',
      uniquenessExpiresAt: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000), // 25 days
      fixationStatus: FixationStatus.NOT_FIXED,
      status: ClientStatus.NEW,
    },
  });

  const client4 = await prisma.client.create({
    data: {
      brokerId: broker3.id,
      fullName: 'Владимир Петрович',
      phone: '+79044445566',
      email: 'vladimir.petrovich@email.com',
      comment: 'Интересуется коммерцией',
      project: Project.ZORGE9,
      fixationAgencyId: agency3.id,
      uniquenessStatus: UniquenessStatus.CONDITIONALLY_UNIQUE,
      uniquenessExpiresAt: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000), // 15 days
      fixationStatus: FixationStatus.NOT_FIXED,
      status: ClientStatus.NEW,
    },
  });

  const client5 = await prisma.client.create({
    data: {
      brokerId: broker2.id,
      fullName: 'Татьяна Михайлова',
      phone: '+79055556677',
      email: 'tatyana.mikhailova@email.com',
      comment: 'Уникальный клиент',
      project: Project.ZORGE9,
      fixationAgencyId: agency2.id,
      uniquenessStatus: UniquenessStatus.CONDITIONALLY_UNIQUE,
      uniquenessExpiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000), // 20 days
      fixationStatus: FixationStatus.NOT_FIXED,
      status: ClientStatus.NEW,
    },
  });

  // Create Lots
  const lots = await Promise.all([
    prisma.lot.create({
      data: {
        number: '101',
        project: Project.ZORGE9,
        building: '1',
        floor: 1,
        rooms: 'Студия',
        sqm: 25.5,
        price: 4500000,
        pricePerSqm: 176470.59,
        status: LotStatus.AVAILABLE,
        description: 'Уютная студия с видом на парк',
      },
    }),
    prisma.lot.create({
      data: {
        number: '102',
        project: Project.ZORGE9,
        building: '1',
        floor: 1,
        rooms: '1',
        sqm: 35.2,
        price: 6200000,
        pricePerSqm: 176136.36,
        status: LotStatus.AVAILABLE,
        description: 'Однокомнатная квартира с балконом',
      },
    }),
    prisma.lot.create({
      data: {
        number: '201',
        project: Project.ZORGE9,
        building: '1',
        floor: 2,
        rooms: '2',
        sqm: 52.8,
        price: 9200000,
        pricePerSqm: 174242.42,
        status: LotStatus.BOOKED,
        description: 'Просторная двухкомнатная квартира',
      },
    }),
    prisma.lot.create({
      data: {
        number: '202',
        project: Project.ZORGE9,
        building: '1',
        floor: 2,
        rooms: '2',
        sqm: 55.1,
        price: 9600000,
        pricePerSqm: 174228.68,
        status: LotStatus.AVAILABLE,
        description: 'Двухкомнатная квартира с улучшенной отделкой',
      },
    }),
    prisma.lot.create({
      data: {
        number: '301',
        project: Project.ZORGE9,
        building: '1',
        floor: 3,
        rooms: '3',
        sqm: 75.3,
        price: 13100000,
        pricePerSqm: 173968.13,
        status: LotStatus.AVAILABLE,
        description: 'Трёхкомнатная квартира для семьи',
      },
    }),
    prisma.lot.create({
      data: {
        number: '302',
        project: Project.ZORGE9,
        building: '1',
        floor: 3,
        rooms: '3',
        sqm: 78.9,
        price: 13700000,
        pricePerSqm: 173637.58,
        status: LotStatus.SOLD,
        description: 'Трёхкомнатная квартира с террасой',
      },
    }),
    prisma.lot.create({
      data: {
        number: '401',
        project: Project.ZORGE9,
        building: '1',
        floor: 4,
        rooms: 'Студия',
        sqm: 28.7,
        price: 5000000,
        pricePerSqm: 174216.03,
        status: LotStatus.AVAILABLE,
        description: 'Студия на верхнем этаже',
      },
    }),
    prisma.lot.create({
      data: {
        number: '501',
        project: Project.ZORGE9,
        building: '1',
        floor: 5,
        rooms: '1',
        sqm: 38.4,
        price: 6700000,
        pricePerSqm: 174479.17,
        status: LotStatus.AVAILABLE,
        description: 'Однокомнатная квартира с панорамными окнами',
      },
    }),
    prisma.lot.create({
      data: {
        number: '601',
        project: Project.ZORGE9,
        building: '1',
        floor: 6,
        rooms: '2',
        sqm: 58.2,
        price: 10100000,
        pricePerSqm: 173539.52,
        status: LotStatus.AVAILABLE,
        description: 'Двухкомнатная квартира с двумя санузлами',
      },
    }),
    prisma.lot.create({
      data: {
        number: '701',
        project: Project.ZORGE9,
        building: '1',
        floor: 7,
        rooms: '3',
        sqm: 82.5,
        price: 14300000,
        pricePerSqm: 173333.33,
        status: LotStatus.AVAILABLE,
        description: 'Трёхкомнатная квартира с гардеробной',
      },
    }),
  ]);

  // Create Deals
  const deal1 = await prisma.deal.create({
    data: {
      clientId: client1.id,
      brokerId: broker1.id,
      agencyId: agency1.id,
      lotId: lots[2].id, // Booked 2-room
      project: Project.ZORGE9,
      contractType: 'DDU',
      amount: 9200000,
      sqm: 52.8,
      commissionRate: 6.0,
      commissionAmount: 552000,
      paymentReceived: true,
      paymentPercent: 100,
      isInstallment: false,
      status: DealStatus.PAID,
      signedAt: new Date('2024-02-15'),
      paidAt: new Date('2024-03-01'),
    },
  });

  const deal2 = await prisma.deal.create({
    data: {
      clientId: client3.id,
      brokerId: broker1.id,
      agencyId: agency1.id,
      lotId: lots[5].id, // Sold 3-room
      project: Project.ZORGE9,
      contractType: 'DDU',
      amount: 13700000,
      sqm: 78.9,
      commissionRate: 6.0,
      commissionAmount: 822000,
      paymentReceived: true,
      paymentPercent: 50,
      isInstallment: true,
      status: DealStatus.SIGNED,
      signedAt: new Date('2024-03-10'),
    },
  });

  const deal3 = await prisma.deal.create({
    data: {
      clientId: client5.id,
      brokerId: broker2.id,
      agencyId: agency2.id,
      project: Project.ZORGE9,
      contractType: 'DDU',
      amount: 6200000,
      sqm: 35.2,
      commissionRate: 7.0,
      commissionAmount: 434000,
      paymentReceived: false,
      paymentPercent: 0,
      isInstallment: false,
      status: DealStatus.PENDING,
    },
  });

  // Create Meetings
  await prisma.meeting.create({
    data: {
      clientId: client1.id,
      brokerId: broker1.id,
      type: MeetingType.OFFICE_VISIT,
      date: new Date('2024-02-10'),
      comment: 'Показ офиса и презентация ЖК',
      status: MeetingStatus.COMPLETED,
      actSigned: true,
    },
  });

  await prisma.meeting.create({
    data: {
      clientId: client2.id,
      brokerId: broker2.id,
      type: MeetingType.ONLINE,
      date: new Date('2024-03-05'),
      comment: 'Онлайн-презентация комплекса',
      status: MeetingStatus.CONFIRMED,
      actSigned: false,
    },
  });

  await prisma.meeting.create({
    data: {
      clientId: client4.id,
      brokerId: broker3.id,
      type: MeetingType.BROKER_TOUR,
      date: new Date('2024-03-15'),
      comment: 'Экскурсия по комплексу для брокера',
      status: MeetingStatus.PENDING,
      actSigned: false,
    },
  });

  await prisma.meeting.create({
    data: {
      clientId: client3.id,
      brokerId: broker1.id,
      type: MeetingType.OFFICE_VISIT,
      date: new Date('2024-03-08'),
      comment: 'Встреча для подписания акта',
      status: MeetingStatus.COMPLETED,
      actSigned: true,
    },
  });

  await prisma.meeting.create({
    data: {
      clientId: client5.id,
      brokerId: broker2.id,
      type: MeetingType.ONLINE,
      date: new Date('2024-03-12'),
      comment: 'Обсуждение ипотечных программ',
      status: MeetingStatus.PENDING,
      actSigned: false,
    },
  });

  // Create Documents
  await prisma.document.create({
    data: {
      name: 'Брошюра ЖК Зорге 9',
      type: 'pdf',
      category: 'brochure',
      project: Project.ZORGE9,
      fileUrl: 'https://example.com/brochure-zorge9.pdf',
      fileSize: 5242880, // 5MB
    },
  });

  await prisma.document.create({
    data: {
      name: 'Прайс-лист Зорге 9',
      type: 'xlsx',
      category: 'price',
      project: Project.ZORGE9,
      fileUrl: 'https://example.com/price-zorge9.xlsx',
      fileSize: 102400, // 100KB
    },
  });

  await prisma.document.create({
    data: {
      name: 'Планировки Зорге 9',
      type: 'pdf',
      category: 'layouts',
      project: Project.ZORGE9,
      fileUrl: 'https://example.com/layouts-zorge9.pdf',
      fileSize: 10485760, // 10MB
    },
  });

  await prisma.document.create({
    data: {
      name: 'Видео-презентация комплекса',
      type: 'mp4',
      category: 'video',
      project: Project.ZORGE9,
      fileUrl: 'https://example.com/video-zorge9.mp4',
      fileSize: 52428800, // 50MB
    },
  });

  await prisma.document.create({
    data: {
      name: 'Условия ипотеки',
      type: 'pdf',
      category: 'mortgage',
      project: Project.ZORGE9,
      fileUrl: 'https://example.com/mortgage-terms.pdf',
      fileSize: 204800, // 200KB
    },
  });

  await prisma.document.create({
    data: {
      name: 'Коммерческая недвижимость',
      type: 'pdf',
      category: 'commercial',
      project: Project.ZORGE9,
      fileUrl: 'https://example.com/commercial-zorge9.pdf',
      fileSize: 3145728, // 3MB
    },
  });

  await prisma.document.create({
    data: {
      name: 'Прайс-лист Квартал Серебряный Бор',
      type: 'xlsx',
      category: 'price',
      project: Project.SILVER_BOR,
      fileUrl: 'https://example.com/price-silver-bor.xlsx',
      fileSize: 153600, // 150KB
    },
  });

  await prisma.document.create({
    data: {
      name: 'Брошюра Квартал Серебряный Бор',
      type: 'pdf',
      category: 'brochure',
      project: Project.SILVER_BOR,
      fileUrl: 'https://example.com/brochure-silver-bor.pdf',
      fileSize: 4194304, // 4MB
    },
  });

  console.log('✅ Seed completed successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });