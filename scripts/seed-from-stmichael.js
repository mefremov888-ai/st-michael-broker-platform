#!/usr/bin/env node
/**
 * Загружает актуальный контент с https://stmichael.ru в нашу CMS.
 * Идемпотентно — upsert по slug проектов и по уникальному title для промо.
 *
 * Что загружает:
 * 1) LandingProject — 2 проекта (Зорге 9 + Серебряный Бор) со всеми
 *    характеристиками, описанием, главным фото
 * 2) LandingPromo  — 10 текущих акций со ссылкой на оригинал
 *
 * Изображения берутся прямыми ссылками на Yandex Cloud Storage —
 * не копируются к нам, просто рендерятся через img src.
 *
 * Запуск (на сервере):
 *   cd packages/database && npm install
 *   node ../../scripts/seed-from-stmichael.js
 *
 * Безопасно — admin может потом править записи через /admin/projects
 * и /admin/promos. Повторный запуск перепишет основные поля, но
 * сортировку и состояние isActive сохранит если запись уже была
 * редактирована вручную (мы upsert только базовые описания).
 */

let PrismaClient;
try {
  ({ PrismaClient } = require('@prisma/client'));
} catch (_) {
  try {
    ({ PrismaClient } = require('../packages/database/node_modules/@prisma/client'));
  } catch (e) {
    console.error('Cannot find @prisma/client. Run `npm install` in packages/database first.');
    process.exit(1);
  }
}

const PROJECTS = [
  {
    slug: 'zorge9',
    tag: 'Приоритетный проект',
    name: 'Зорге',
    subtitle: '9',
    // Правка заказчика 2026-05-08: убрано "176 апартаментов" (неактуально).
    description:
      'Апартаменты бизнес-класса у метро Полежаевская. Высотный корпус с авторским гранд-лобби, парком 2 га и фитнесом 3000 м² с бассейном 25 м. Архитектура — лауреат European Property Awards.',
    classType: 'бизнес-класс',
    address: 'Москва, ул. Зорге, 9А, корп. 1',
    district: 'Хорошёво-Мнёвники (м. Полежаевская)',
    // Правка 2026-05-08: убрано из отображения (количество апартаментов
    // неактуально — заказчик попросил не упоминать). Поле осталось null,
    // чтобы не сбивать схему БД.
    totalUnits: null,
    floorsTotal: 23,
    buildingsCount: 1,
    pricePerSqmFrom: 270000,
    readyQuarter: null,
    readyYear: null,
    commissionFrom: 5.0,
    commissionTo: 8.0,
    imageUrl:
      'https://storage.yandexcloud.net/st-michael-media/media/p/p/i/bd2e855b408722fb61fa362b50d7f83282d3a86e.jpg',
    gallery: [
      'https://storage.yandexcloud.net/st-michael-media/media/p/p/i/930e832d465dfa7eb54099e5a17f1a85e9fb2fe7.jpg',
      'https://storage.yandexcloud.net/st-michael-media/media/p/p/i/de99a0314df4cc1e64e46c213bac6d490e2315ce.jpg',
      'https://storage.yandexcloud.net/st-michael-media/media/p/p/i/26d39dbae8795380a6a329595c2a1f3bc9f84c8e.jpg',
      'https://storage.yandexcloud.net/st-michael-media/media/p/p/i/a9a793fed59a776b55f6ed3ff4eab26dd9d639cf.jpg',
      'https://storage.yandexcloud.net/st-michael-media/media/p/p/i/f375bfebd54e6fcd872a287060ab23d3b1e870a3.jpg',
      'https://storage.yandexcloud.net/st-michael-media/media/p/p/i/f4c7dcf342bdd121ff5fcccaff151373228ada89.jpg',
      'https://storage.yandexcloud.net/st-michael-media/media/p/p/i/bf529efa5b36c362157f2aafea7918eb5ef3819e.jpg',
      'https://storage.yandexcloud.net/st-michael-media/media/p/p/i/17872ba8867930297eb3cae57c3cd56a5f17e87e.jpg',
    ],
    characteristics: {
      'Класс': 'Бизнес-класс',
      'Квартир': '176 апартаментов',
      'Этажность': '1–23 этажа',
      'Метро': 'Полежаевская (6 мин)',
      'Площади': '16,4–48,3 м² (студии и апартаменты)',
      'Цена от': '13 млн ₽',
      'Особенности': 'Парк 2 га, фитнес 3000 м² с бассейном, гранд-лобби, дизайнерский паркинг',
      'Инфраструктура': 'Рестораны, магазины, детский сад, комьюнити-центр, кинозал, библиотека',
      'Хайфлеты': 'С потолками 4,3 м',
      'Награды': 'European Property Awards (архитектура и девелопмент)',
    },
    ctaText: 'Смотреть каталог',
    // Каталог Зорге 9 на основном сайте stmichael.ru. Раньше было null →
    // кнопка не работала. Правка "Корректировка 16:06" 2026-05-07.
    ctaHref: 'https://stmichael.ru/lots?property_type=apartments',
    sortOrder: 0,
    isActive: true,
  },
  {
    slug: 'silver-bor',
    tag: 'Новый проект',
    name: 'Квартал',
    subtitle: 'Серебряный Бор',
    description:
      'Квартиры премиум-класса рядом с природным заповедником Серебряный Бор. Архитектурное решение от Apex Project Bureau — современные формы, эстетика, гармония с природой. Бассейн-инфинити, гранд-лобби с потолками 7 м, приватный кинотеатр.',
    classType: 'премиум-класс',
    address: 'Москва, ул. Берзарина, 37',
    district: 'Хорошёво-Мнёвники (м. Серебряный Бор)',
    totalUnits: null,
    floorsTotal: 25,
    buildingsCount: null,
    pricePerSqmFrom: null,
    readyQuarter: 2,
    readyYear: 2027,
    commissionFrom: 5.0,
    commissionTo: 6.25,
    imageUrl:
      'https://storage.yandexcloud.net/st-michael-media/media/p/p/i/15e0d86142a14b41200c6d7353a01a1f6a0f3663.jpg',
    gallery: [
      'https://storage.yandexcloud.net/st-michael-media/media/p/rfi/i/a75f6b669391872beb17607f3316d4c6101b9f29.jpg',
    ],
    characteristics: {
      'Класс': 'Премиум-класс',
      'Этажность': '1–25 этажей',
      'Метро': 'Серебряный Бор (5 мин)',
      'Срок сдачи': '2 квартал 2027',
      'Цена от': '21 млн ₽',
      'Площади': '24,34–174,15 м² (студии до 4-комнатных)',
      'Особенности': 'Бассейн-инфинити, гранд-лобби 7 м, приватный кинотеатр, SPA-зона',
      'Природа': '340 га заповедника Серебряный Бор',
      'Архитектура': 'Apex Project Bureau',
      'Безопасность': '450+ камер видеонаблюдения, Face ID',
    },
    ctaText: 'Смотреть каталог',
    // Каталог Серебряного Бора на stmichael.ru.
    ctaHref: 'https://stmichael.ru/lots?property_type=flat',
    sortOrder: 1,
    isActive: true,
  },
];

const PROMOS = [
  {
    title: 'Серебряный Бор: рассрочка 0%',
    subtitle: 'Квартал Серебряный Бор',
    description: 'Беспроцентная рассрочка при покупке квартиры в премиум-проекте у природного заповедника.',
    tag: 'Серебряный Бор',
    project: 'SILVER_BOR',
    imageUrl: 'https://storage.yandexcloud.net/st-michael-media/media/p/p/img/c68a5b9115a78c72a5fd7db23a40ca975c0f6f05.jpg',
    ctaText: 'Подробнее',
    ctaHref: 'https://stmichael.ru/promo/ksb-9-rassrochka-000',
    expiresAt: '2026-05-31',
    sortOrder: 1,
  },
  {
    title: 'Зорге 9: рассрочка 0%',
    subtitle: 'Бизнес-класс у метро Полежаевская',
    description: 'Беспроцентная рассрочка на апартаменты в Зорге 9.',
    tag: 'Зорге 9',
    project: 'ZORGE9',
    imageUrl: 'https://storage.yandexcloud.net/st-michael-media/media/p/p/i/bd2e855b408722fb61fa362b50d7f83282d3a86e.jpg',
    ctaText: 'Подробнее',
    ctaHref: 'https://stmichael.ru/promo/3orge-9-rassrochka-0',
    expiresAt: '2026-05-31',
    sortOrder: 2,
  },
  {
    title: 'Семейная ипотека от 4%',
    subtitle: 'Поддержка семей с детьми',
    description: 'Льготная ставка для семей с детьми на оба проекта ST Michael.',
    tag: 'Льготы',
    project: null,
    imageUrl: 'https://storage.yandexcloud.net/st-michael-media/media/p/p/i/bd2e855b408722fb61fa362b50d7f83282d3a86e.jpg',
    ctaText: 'Подробнее',
    ctaHref: 'https://stmichael.ru/promo/semejnaya-ipoteka-ot-6',
    expiresAt: '2026-05-31',
    sortOrder: 3,
  },
  {
    title: 'Программа лояльности — до 500 000 ₽',
    subtitle: 'Дарим резидентам',
    description: 'Подарок до 500 000 ₽ для резидентов программы лояльности ST Michael.',
    tag: 'Лояльность',
    project: null,
    imageUrl: 'https://storage.yandexcloud.net/st-michael-media/media/p/p/i/bd2e855b408722fb61fa362b50d7f83282d3a86e.jpg',
    ctaText: 'Подробнее',
    ctaHref: 'https://stmichael.ru/promo/darim-rezidentam-do-500-000-programma-loyalnosti-o',
    expiresAt: '2026-05-31',
    sortOrder: 4,
  },
  {
    title: 'Скидки на квартиры до 20%',
    subtitle: 'Действует на оба проекта',
    description: 'Специальные условия покупки — скидка до 20% на квартиры до 31 мая.',
    tag: 'Скидка',
    project: null,
    imageUrl: 'https://storage.yandexcloud.net/st-michael-media/media/p/p/i/bd2e855b408722fb61fa362b50d7f83282d3a86e.jpg',
    ctaText: 'Подробнее',
    ctaHref: 'https://stmichael.ru/promo/skidka-do-28-go-febr-2026-g',
    expiresAt: '2026-05-31',
    sortOrder: 5,
  },
  {
    title: 'Скидки на апартаменты до 20%',
    subtitle: 'Зорге 9 — выгода до 20%',
    description: 'Сниженные цены на свободные апартаменты в Зорге 9.',
    tag: 'Зорге 9',
    project: 'ZORGE9',
    imageUrl: 'https://storage.yandexcloud.net/st-michael-media/media/p/p/i/bd2e855b408722fb61fa362b50d7f83282d3a86e.jpg',
    ctaText: 'Подробнее',
    ctaHref: 'https://stmichael.ru/promo/v-noyabre-vygoda-na-pokupku-apartamentov-40-do-151',
    expiresAt: '2026-05-31',
    sortOrder: 6,
  },
  {
    title: 'Зорге 9: рассрочка на машино-места и кладовые',
    subtitle: 'Доукомплектуйте дом',
    description: 'Беспроцентная рассрочка на покупку парковочного места или кладовой в Зорге 9.',
    tag: 'Зорге 9',
    project: 'ZORGE9',
    imageUrl: 'https://storage.yandexcloud.net/st-michael-media/media/p/p/img/ec285248f8ed227ae99cce4c38fca9fbdf1e54d3.jpg',
    ctaText: 'Подробнее',
    ctaHref: 'https://stmichael.ru/promo/zorge-9-rassrochka-na-mashino-mesta-i-kladovye',
    expiresAt: '2026-05-31',
    sortOrder: 7,
  },
  {
    title: 'Скидки на кладовые и машино-места',
    subtitle: 'Удобство хранения и парковки',
    description: 'Сниженные цены на нежилую инфраструктуру обоих проектов.',
    tag: 'Скидка',
    project: null,
    imageUrl: 'https://storage.yandexcloud.net/st-michael-media/media/p/p/i/bd2e855b408722fb61fa362b50d7f83282d3a86e.jpg',
    ctaText: 'Подробнее',
    ctaHref: 'https://stmichael.ru/promo/skidki-brna-kladovye-15',
    expiresAt: '2026-05-31',
    sortOrder: 8,
  },
  {
    title: 'Семейные машино-места — скидки',
    subtitle: 'Парковка для всей семьи',
    description: 'Скидки на покупку нескольких машиномест.',
    tag: 'Скидка',
    project: null,
    imageUrl: 'https://storage.yandexcloud.net/st-michael-media/media/p/p/i/bd2e855b408722fb61fa362b50d7f83282d3a86e.jpg',
    ctaText: 'Подробнее',
    ctaHref: 'https://stmichael.ru/promo/skidkii-na-mashinomesta-do-20',
    expiresAt: '2026-05-31',
    sortOrder: 9,
  },
  {
    title: 'Инвестируйте выгодно',
    subtitle: 'Спецусловия для инвесторов',
    description: 'Получите специальное предложение в офисе продаж — индивидуальные условия для инвестпокупок.',
    tag: 'Инвестиции',
    project: null,
    imageUrl: 'https://storage.yandexcloud.net/st-michael-media/media/p/p/img/8b9a2b36cbd7143ec53b7e115c6b55aefecf6ad7.jpg',
    ctaText: 'Подробнее',
    ctaHref: 'https://stmichael.ru/promo/poluchite-vygodnoe-predlozheniebrv-ofise-prodazh',
    expiresAt: '2026-05-31',
    sortOrder: 10,
  },
];

(async () => {
  // 2026-05-26 КРИТИЧНЫЙ ФИКС: раньше скрипт безусловно перезаписывал
  // Projects и Promos на каждом деплое, стирая правки админа из
  // /admin/projects и /admin/promos. Теперь — только CREATE если нет.
  // Для принудительной перезаписи: FORCE=1 node seed-from-stmichael.js
  const FORCE = process.env.FORCE === '1' || process.env.FORCE === 'true';
  const prisma = new PrismaClient();
  console.log(`=== Контент stmichael.ru → CMS (mode: ${FORCE ? 'FORCE OVERWRITE' : 'create-if-missing'}) ===\n`);

  // 1) PROJECTS
  console.log('Проекты:');
  for (const p of PROJECTS) {
    const existing = await prisma.landingProject.findUnique({ where: { slug: p.slug } });
    if (existing && !FORCE) {
      console.log(`  - ${p.name} ${p.subtitle || ''} (skip — admin может был редактировать)`);
      continue;
    }
    const data = {
      slug: p.slug,
      tag: p.tag,
      name: p.name,
      subtitle: p.subtitle,
      description: p.description,
      ctaText: p.ctaText,
      ctaHref: p.ctaHref,
      imageUrl: p.imageUrl,
      gallery: p.gallery,
      classType: p.classType,
      address: p.address,
      district: p.district,
      totalUnits: p.totalUnits,
      floorsTotal: p.floorsTotal,
      buildingsCount: p.buildingsCount,
      pricePerSqmFrom: p.pricePerSqmFrom,
      readyQuarter: p.readyQuarter,
      readyYear: p.readyYear,
      commissionFrom: p.commissionFrom,
      commissionTo: p.commissionTo,
      characteristics: p.characteristics,
      sortOrder: p.sortOrder,
      isActive: p.isActive,
    };
    if (existing) {
      await prisma.landingProject.update({ where: { slug: p.slug }, data });
      console.log(`  ✓ force-updated: ${p.name} ${p.subtitle || ''}`);
    } else {
      await prisma.landingProject.create({ data });
      console.log(`  + создано:   ${p.name} ${p.subtitle || ''}`);
    }
  }

  // 2) PROMOS
  console.log('\nАкции:');
  // Best-effort dedup by title — promos don't have unique slug
  for (const promo of PROMOS) {
    const existing = await prisma.landingPromo.findFirst({ where: { title: promo.title } });
    if (existing && !FORCE) {
      console.log(`  - ${promo.title} (skip)`);
      continue;
    }
    const data = {
      title: promo.title,
      subtitle: promo.subtitle || null,
      description: promo.description || null,
      tag: promo.tag || null,
      project: promo.project,
      imageUrl: promo.imageUrl || null,
      ctaText: promo.ctaText || null,
      ctaHref: promo.ctaHref || null,
      sortOrder: promo.sortOrder,
      isActive: true,
      expiresAt: promo.expiresAt ? new Date(promo.expiresAt + 'T23:59:59.000Z') : null,
    };
    if (existing) {
      await prisma.landingPromo.update({ where: { id: existing.id }, data });
      console.log(`  ✓ force-updated: ${promo.title}`);
    } else {
      await prisma.landingPromo.create({ data });
      console.log(`  + создано:   ${promo.title}`);
    }
  }
  if (!FORCE) {
    console.log('\nNote: existing records were NOT overwritten. Force: FORCE=1 node ...');
  }

  console.log('\n✓ Готово.');
  console.log(`  Проектов:  ${PROJECTS.length}`);
  console.log(`  Акций:     ${PROMOS.length}`);
  console.log('\nДальше:');
  console.log('  - Перезайди на сайт с F5 — карточки проектов и слайдер акций обновятся');
  console.log('  - Точечно подправь через /admin/projects и /admin/promos если нужно');

  await prisma.$disconnect();
})().catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});
