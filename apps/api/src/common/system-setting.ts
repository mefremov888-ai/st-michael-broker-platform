import type { PrismaClient } from '@st-michael/database';

/**
 * 2026-06-04: Чтение KV-настройки из БД с env-fallback.
 * Используется для админ-настроек интеграций (MOREKIT_WEBHOOK_URL и т.п.),
 * чтобы менять без релиза. Если в БД нет ключа — возвращаем process.env[key].
 *
 * Не кэшируем: настройка может меняться через UI, частота вызовов низкая
 * (только при фиксации/похожих действиях).
 */
export async function getSystemSetting(
  prisma: PrismaClient,
  key: string,
): Promise<string> {
  try {
    const row = await prisma.systemSetting.findUnique({
      where: { key },
      select: { value: true },
    });
    if (row && row.value) return row.value;
  } catch (e: any) {
    // Если миграция не применена — fallback на env молча.
    console.warn(`[getSystemSetting] DB read failed for ${key}: ${e?.message || e}`);
  }
  return process.env[key] || '';
}
