import { Injectable, Inject, Logger } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';
import * as XLSX from 'xlsx';
import { parseAndFilter, VALID_CATEGORIES, BrokerCategoryCode } from './brokers-import.helper';
import { getSystemSetting } from '../common/system-setting';

/**
 * 2026-06-09: периодическая выгрузка базы брокеров из Google Sheets.
 *
 * Источник — публичная Google Sheet (расшарена «по ссылке: любой может смотреть»),
 * URL вида:
 *   https://docs.google.com/spreadsheets/d/<SHEET_ID>/export?format=csv&gid=<GID>
 * URL хранится в SystemSetting.GSHEETS_BROKERS_URL (можно править из
 * /admin/integrations без релиза).
 *
 * Логика парсинга/маппинга строки в Broker / CallLog — общая с XLSX-импортом
 * (brokers-import.helper.ts → mapRow + parseAndFilter). Колонки сейчас:
 *   Имя | Телефон брокера | Кол-во заявок на уникальность | Встречи | Сделки |
 *   ЗВОНОК | Результат звонка | Обзвон по Зорге | Комментарий | Столбец 1
 *
 * Cron — каждые 30 минут (см. scheduler.service). Запуск идемпотентен:
 * по phone делается upsert, CallLog не дублируется (см. runRealImport).
 */
@Injectable()
export class GoogleSheetsSyncService {
  private readonly logger = new Logger(GoogleSheetsSyncService.name);
  private running = false; // защита от наложения долгих синков
  private lastRunAt: Date | null = null;
  private lastResult: { ok: boolean; total: number; created: number; updated: number; errors: number; durationMs: number; error?: string } | null = null;

  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  getLastResult() {
    return { running: this.running, lastRunAt: this.lastRunAt, lastResult: this.lastResult };
  }

  /**
   * Триггерится из scheduler-cron или из admin endpoint (manual).
   * Если уже идёт синк — возвращает inflight=true без запуска.
   */
  async sync(): Promise<{ ok: boolean; inflight?: boolean; total?: number; created?: number; updated?: number; errors?: number; durationMs?: number; error?: string }> {
    if (this.running) {
      return { ok: false, inflight: true };
    }
    this.running = true;
    const started = Date.now();
    try {
      const url = await getSystemSetting(this.prisma, 'GSHEETS_BROKERS_URL');
      if (!url) {
        const err = 'GSHEETS_BROKERS_URL не задан (ни в БД, ни в env)';
        this.logger.warn(err);
        const res = { ok: false, error: err, durationMs: Date.now() - started };
        this.lastResult = { ok: false, total: 0, created: 0, updated: 0, errors: 0, error: err, durationMs: res.durationMs };
        return res;
      }

      // 1. Скачиваем CSV (8 MB лимит — для 11K строк хватает с запасом).
      const csvRes = await fetch(url, { redirect: 'follow' });
      if (!csvRes.ok) {
        const err = `Failed to fetch sheet: HTTP ${csvRes.status}`;
        this.logger.error(err);
        const r = { ok: false, error: err, durationMs: Date.now() - started };
        this.lastResult = { ok: false, total: 0, created: 0, updated: 0, errors: 0, error: err, durationMs: r.durationMs };
        return r;
      }
      const csvText = await csvRes.text();
      this.logger.log(`Downloaded CSV: ${csvText.length} bytes`);

      // 2. Парсим CSV через XLSX (он умеет читать CSV строкой).
      const workbook = XLSX.read(csvText, { type: 'string', raw: true });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      this.logger.log(`Parsed rows: ${rows.length}`);

      // 3. mapRow + дедуп по phone (общая с XLSX-импортом).
      const { candidates, stats } = parseAndFilter(rows, {
        filter: new Set<BrokerCategoryCode>(VALID_CATEGORIES),
        callFlagFilter: null,
        limit: null,
      });
      this.logger.log(`Valid candidates after dedup: ${candidates.length} (invalid phones: ${stats.invalidPhone}, sheet dups: ${stats.duplicatesInSheet})`);

      // 4. Upsert по phone. Стратегия та же что у XLSX-импорта в runRealImport:
      //    обновляем category/isInBase/baseSource/doNotCall + сохраняем fullName
      //    если у нас пусто. Не трогаем поля которые брокер сам ввёл в кабинете
      //    (email, role, status, telegramId и т.п.).
      let created = 0;
      let updated = 0;
      let errors = 0;
      const baseSource = 'google_sheet';

      for (const c of candidates) {
        try {
          const existing = await this.prisma.broker.findUnique({ where: { phone: c.phone } });
          if (existing) {
            // Считаем что изменения только в этих полях. fullName обновляем
            // только если у нас пусто (чтобы не перетереть то что брокер сам
            // указал при регистрации в кабинете).
            await this.prisma.broker.update({
              where: { id: existing.id },
              data: {
                category: c.category as any,
                isInBase: true,
                baseSource,
                doNotCall: existing.doNotCall || c.doNotCall,
                fullName: existing.fullName && existing.fullName !== '(без имени)' ? existing.fullName : (c.name || existing.fullName || '(без имени)'),
              },
            });
            updated++;
          } else {
            await this.prisma.broker.create({
              data: {
                fullName: c.name || '(без имени)',
                phone: c.phone,
                role: 'BROKER',
                status: 'PENDING',
                category: c.category as any,
                isInBase: true,
                baseSource,
                doNotCall: c.doNotCall,
              },
            });
            created++;
          }

          // CallLog идемпотентно (не дублировать одинаковые при повторных синках).
          if (c.callResult) {
            const exists = await this.prisma.callLog.findFirst({
              where: { brokerId: existing?.id, result: c.callResult as any, campaign: null, comment: c.comment },
              select: { id: true },
            });
            if (!exists && existing) {
              await this.prisma.callLog.create({
                data: { brokerId: existing.id, result: c.callResult as any, comment: c.comment, campaign: null },
              });
            }
          }
        } catch (e: any) {
          errors++;
          if (errors <= 5) this.logger.error(`upsert failed phone=${c.phone}: ${e?.message || e}`);
        }
      }

      const durationMs = Date.now() - started;
      this.lastRunAt = new Date();
      this.lastResult = { ok: true, total: candidates.length, created, updated, errors, durationMs };
      this.logger.log(`Sync done: total=${candidates.length} created=${created} updated=${updated} errors=${errors} in ${durationMs}ms`);
      return this.lastResult;
    } catch (e: any) {
      const err = String(e?.message || e).slice(0, 500);
      this.logger.error(`Sync failed: ${err}`);
      this.lastResult = { ok: false, total: 0, created: 0, updated: 0, errors: 0, error: err, durationMs: Date.now() - started };
      return { ok: false, error: err, durationMs: Date.now() - started };
    } finally {
      this.running = false;
    }
  }
}
