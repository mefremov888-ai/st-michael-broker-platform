#!/usr/bin/env node
/**
 * Удаляет неактуальные документы из category=cooperation:
 *   - tz_stmichael_посадка брокерская.pdf (тестовая преза, попала случайно)
 *   - "Как начать сотрудничать с St Michael" (старый howto, заменяется новым
 *     файлом "Условия вознаграждения партнёром" — см. далее)
 *
 * По правке "Корректировка 2" (2026-05-07).
 *
 * Идемпотентен: если файлов нет — просто молча пройдёт.
 *
 * Запуск через workflow: Actions → Заполнить данные → task=cleanup-cooperation
 */

let PrismaClient;
try {
  ({ PrismaClient } = require('@prisma/client'));
} catch (_) {
  ({ PrismaClient } = require('../packages/database/node_modules/@prisma/client'));
}

const TARGETS = [
  { match: { name: 'tz_stmichael_посадка брокерская.pdf' }, label: 'старый тестовый PDF' },
  { match: { description: '[seed:cooperation-doc-howto]' }, label: '"Как начать сотрудничать" (старый)' },
  { match: { name: 'Как начать сотрудничать с St Michael' }, label: '"Как начать сотрудничать" (по имени)' },
];

(async () => {
  const prisma = new PrismaClient();
  let removed = 0;

  for (const t of TARGETS) {
    const existing = await prisma.document.findMany({
      where: { ...t.match, category: 'cooperation' },
    });
    for (const d of existing) {
      await prisma.document.delete({ where: { id: d.id } });
      console.log(`✓ Удалён: ${t.label} (id=${d.id}, name="${d.name}")`);
      removed++;
    }
  }

  if (removed === 0) {
    console.log('Нет документов для удаления (уже почищено).');
  } else {
    console.log(`\nИтого удалено: ${removed}`);
  }

  await prisma.$disconnect();
})().catch((e) => {
  console.error('Error:', e?.message || e);
  process.exit(1);
});
