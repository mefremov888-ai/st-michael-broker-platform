#!/usr/bin/env node
/**
 * 2026-09-04: назначить файл на кнопку «Условия вознаграждения» главной
 * страницы БЕЗ участия админки (пользователь попросил сделать за него).
 *
 * Механика кнопки (PR #386): лендинг открывает документ категории
 * cooperation с маркером [landing-rewards-button] в description.
 * Скрипт: находит документ по подстроке имени (argv[2], по умолчанию
 * «сотрудничества сентябрь»), снимает маркер с других, ставит на него,
 * включает isPublic. Печатает до/после.
 *
 * Запуск в контейнере api (workflow set-rewards-doc.yml):
 *   node /app/scripts/set-rewards-doc.js "сотрудничества сентябрь"
 */
const MARKER = '[landing-rewards-button]';

(async () => {
  const { PrismaClient } = require('@st-michael/database');
  const prisma = new PrismaClient();
  const needle = (process.argv[2] || 'сотрудничества сентябрь').toLowerCase();
  try {
    const docs = await prisma.document.findMany({
      where: { category: 'cooperation' },
      select: { id: true, name: true, description: true, isPublic: true, fileUrl: true },
    });
    console.log('Документы cooperation:');
    for (const d of docs) {
      const marked = (d.description || '').includes(MARKER) ? ' ⭐' : '';
      console.log(`  • «${d.name}»${marked} public=${d.isPublic}`);
    }
    const target = docs.find((d) => d.name.toLowerCase().includes(needle));
    if (!target) {
      console.log(`НЕ НАЙДЕН документ с «${needle}» в названии — ничего не изменено.`);
      return;
    }
    for (const d of docs) {
      if (d.id !== target.id && (d.description || '').includes(MARKER)) {
        await prisma.document.update({
          where: { id: d.id },
          data: { description: (d.description || '').replace(MARKER, '').trim() || null },
        });
        console.log(`Маркер снят с «${d.name}»`);
      }
    }
    const desc = (target.description || '').includes(MARKER)
      ? target.description
      : `${MARKER} ${target.description || ''}`.trim();
    await prisma.document.update({
      where: { id: target.id },
      data: { description: desc, isPublic: true },
    });
    console.log(`ГОТОВО: кнопка «Условия вознаграждения» теперь открывает «${target.name}» (${target.fileUrl})`);
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
