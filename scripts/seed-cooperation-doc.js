#!/usr/bin/env node
/**
 * Сидит документы в категорию cooperation. Идемпотентен (UPSERT по description).
 *
 * Текущий список (по правкам заказчика):
 *   - "Условия вознаграждения партнёром St Michael (новая объединённая шкала)" —
 *     актуальный документ с условиями вознаграждения, объединённая шкала по
 *     обоим проектам (по правке "Корректировка 16:06" от 2026-05-07).
 *
 * Старый файл "Как начать сотрудничать" удалён по правке заказчика — см.
 * scripts/cleanup-cooperation-docs.js.
 *
 * Запуск через workflow: task=seed-cooperation-doc
 */

let PrismaClient;
try {
  ({ PrismaClient } = require('@prisma/client'));
} catch (_) {
  ({ PrismaClient } = require('../packages/database/node_modules/@prisma/client'));
}

const DOCS = [
  {
    name: 'Условия вознаграждения партнёром St Michael',
    description: '[seed:cooperation-rewards-conditions]',
    type: 'DOCX',
    category: 'cooperation',
    // Путь /cooperation/* — статика веб-контейнера. /docs/* конфликтует со
    // Swagger UI на API (nginx роутит /docs → API).
    fileUrl: '/cooperation/conditions-of-rewards-st-michael.docx',
    isPublic: true,
    sortOrder: 1,
  },
];

(async () => {
  const prisma = new PrismaClient();

  for (const DOC of DOCS) {
    const existing = await prisma.document.findFirst({
      where: { description: DOC.description },
    });

    if (existing) {
      await prisma.document.update({
        where: { id: existing.id },
        data: DOC,
      });
      console.log(`✓ Обновлён: ${DOC.name}`);
    } else {
      await prisma.document.create({ data: DOC });
      console.log(`✓ Создан: ${DOC.name}`);
    }
  }

  await prisma.$disconnect();
})().catch((e) => {
  console.error('Error:', e?.message || e);
  process.exit(1);
});
