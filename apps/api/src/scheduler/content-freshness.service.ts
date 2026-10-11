import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaClient } from '@st-michael/database';
import { CatalogService } from '../catalog/catalog.service';
import { OpsAlertService } from '../ops-alert/ops-alert.service';

const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'май', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
export function moscowCalendar(now: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string) => Number(parts.find(p => p.type === type)!.value);
  const year = get('year'), month = get('month'), day = get('day');
  return { year, month, day, daysLeft: new Date(Date.UTC(year, month, 0)).getUTCDate() - day,
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
}

/** A title is an editorial freshness signal, NOT proof that an offer expired. */
export function conditionsWarning(names: string[], now: Date): string | null {
  const calendar = moscowCalendar(now);
  if (!names.length) return 'На лендинге не опубликован документ условий сотрудничества. Проверьте публикацию в CMS.';
  const periods = names.map(name => {
    const lower = name.toLowerCase();
    const month = MONTHS.findIndex(m => lower.includes(m)) + 1;
    const year = lower.match(/\b(20\d{2})\b/);
    return { month, year: year ? Number(year[1]) : null };
  });
  const current = periods.some(p => p.month === calendar.month && (p.year === null || p.year === calendar.year));
  const nextMonth = calendar.month === 12 ? 1 : calendar.month + 1;
  const nextYear = calendar.month === 12 ? calendar.year + 1 : calendar.year;
  const next = periods.some(p => p.month === nextMonth && (p.year === null || p.year === nextYear));
  if (!current && !next && periods.some(p => p.month))
    return 'В названии опубликованных условий указан другой месяц. Проверьте срок внутри PDF и публикацию новой редакции. Название само по себе не подтверждает прекращение условий.';
  if (calendar.daysLeft <= 5 && !next)
    return 'До конца месяца осталось не более 5 дней. Подготовьте и опубликуйте условия на следующий месяц; проверьте даты внутри PDF, не только название.';
  if (!periods.some(p => p.month))
    return 'Месяц действия опубликованных условий не указан в названии. Проверьте срок внутри PDF и укажите месяц/год редакции в CMS.';
  return null;
}

function maxAgeHours(): number {
  const value = Number(process.env.CONTENT_FEED_MAX_AGE_HOURS || 24);
  return Number.isFinite(value) && value >= 6 && value <= 168 ? value : 24;
}

@Injectable()
export class ContentFreshnessService {
  private readonly logger = new Logger(ContentFreshnessService.name);
  private running = false;
  constructor(@Inject('PrismaClient') private readonly prisma: PrismaClient,
    private readonly catalog: CatalogService, private readonly alerts: OpsAlertService) {}

  @Cron('15 9 * * *', { timeZone: 'Europe/Moscow' })
  async check(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Evaluate sources independently: one unavailable dependency must not hide the other.
      for (const [kind, evaluate] of [
        ['catalog', () => this.catalogWarning(now)],
        ['conditions', () => this.documentWarning(now)],
      ] as const) {
        try {
          await this.notify(kind, await evaluate(), now);
        } catch {
          this.logger.error(`[ContentFreshness] ${kind} check unavailable`);
          try { await this.notify(`${kind}-check`, 'Проверка свежести временно недоступна. Актуальность не подтверждена; проверьте журнал сервиса.', now); }
          catch { this.logger.error('[ContentFreshness] check alert unavailable'); }
        }
      }
    } finally { this.running = false; }
  }

  private async catalogWarning(now: Date): Promise<string | null> {
    const reports = await this.catalog.getFreshnessReport(now);
    const problems: string[] = [];
    const threshold = maxAgeHours() * 3_600_000;
    for (const report of reports) {
      const label = report.project === 'ZORGE9' ? 'Зорге 9' : report.project === 'SILVER_BOR' ? 'Квартал Серебряный бор' : 'Проект';
      const age = (value: string | null) => value ? now.getTime() - Date.parse(value) : NaN;
      const importedAge = age(report.lastSuccessfulImportAt);
      if (!Number.isFinite(importedAge)) problems.push(`${label}: нет подтверждённой даты успешного применения фида.`);
      else if (importedAge < -300_000 || importedAge > threshold) problems.push(`${label}: успешное применение фида не подтверждено за последние ${maxAgeHours()} ч.`);
      const sourceAge = age(report.sourceGeneratedAt);
      if (!Number.isFinite(sourceAge)) problems.push(`${label}: источник не сообщает проверяемую дату формирования; свежесть исходных цен не подтверждена.`);
      else if (sourceAge < -300_000 || sourceAge > threshold) problems.push(`${label}: дата формирования исходного фида вне допустимого окна ${maxAgeHours()} ч.`);
    }
    return problems.length ? problems.join('\n') + '\nНеизменные цены не считаются ошибкой. Проверьте источник и применение каталога; старые корректные данные автоматически не удаляются.' : null;
  }

  private async documentWarning(now: Date): Promise<string | null> {
    const docs = await this.prisma.document.findMany({ where: { category: 'cooperation', isPublic: true }, select: { name: true } });
    const names = docs.map(d => d.name).filter(name => /условия\s+сотрудничества|условия\s+вознаграждения/i.test(name));
    return conditionsWarning(names, now);
  }

  private async notify(kind: string, warning: string | null, now: Date) {
    // Durable per-day reservation survives restarts and prevents multi-replica fan-out.
    // Store attempt BEFORE Telegram: a timeout may mean the message was accepted.
    const stateKey = `content-freshness:state:${kind}`;
    const previous = await this.prisma.systemSetting.findUnique({ where: { key: stateKey } });
    if (!warning && previous?.value !== 'warning') return;
    const key = `content-freshness:alert:${kind}:${moscowCalendar(now).date}:${warning ? 'warning' : 'recovered'}`;
    try { await this.prisma.systemSetting.create({ data: { key, value: now.toISOString() } }); }
    catch (error) { if ((error as { code?: string }).code === 'P2002') return; throw error; }
    const message = warning
      ? `🟠 Кабинет брокера: контроль свежести ${kind === 'catalog' ? 'цен и каталога' : 'условий'}\n${warning}\nПроверка: ${moscowCalendar(now).date}, МСК`
      : `🟢 Кабинет брокера: проверка свежести ${kind === 'catalog' ? 'цен и каталога' : 'условий'} снова проходит.\nПроверка: ${moscowCalendar(now).date}, МСК`;
    const delivered = await this.alerts.sendSafely(message, { dedupKey: key, cooldownMs: 86_400_000 });
    if (!delivered) { this.logger.warn('[ContentFreshness] alert delivery not confirmed'); return; }
    await this.prisma.systemSetting.upsert({ where: { key: stateKey }, create: { key: stateKey, value: warning ? 'warning' : 'healthy' }, update: { value: warning ? 'warning' : 'healthy' } });
  }
}
