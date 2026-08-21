import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaClient, UniquenessStatus } from '@st-michael/database';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { AmoCrmAdapter, AMO_CONTACT_FIELDS, AMO_LEAD_FIELDS, AMO_PIPELINES, getLeadCustomFieldNumber, getLeadCustomFieldValue, pipelineToProject, leadToProject, statusToDealStatus, isDealStage, mapMeetingStatus, BROKER_PIPELINE_ID, MorekitAdapter, morekitPhone, morekitProjectName, morekitLeadDate } from '@st-michael/integrations';
import { getSystemSetting } from '../common/system-setting';
import { CmsService } from '../cms/cms.service';
/**
 * Чистит имя клиента от служебных суффиксов amoCRM: "от брокера", "от Владимира",
 * "от боркера" (опечатка) и т.п. Убираем всё начиная от слова "от ".
 * Правка 2026-05-13.
 */
function cleanClientName(raw: string | null | undefined): string {
  if (!raw) return 'Без имени';
  const cleaned = String(raw).replace(/\s+от\s+.+$/iu, '').trim();
  return cleaned || 'Без имени';
}
import { CatalogService } from '../catalog/catalog.service';
import { YandexDiskPhotosService } from '../catalog/yandex-disk-photos.service';
import { levelForSqm, rateFor, rateForWithPolicy } from '../commission/commission.service';
import { GoogleSheetsSyncService } from '../admin/google-sheets-sync.service';
import { AdminService } from '../admin/admin.service';
import {
  brokerTourSnapshotFromAmoContact,
  buildBrokerTourUpdate,
} from '../amocrm/broker-tour-sync';
import { OpsAlertService } from '../ops-alert/ops-alert.service';
import {
  AMO_RETRY_MAX_ATTEMPTS,
  AMO_UNIQUENESS_RECHECK_MARKER,
  hasConfiguredAmoCredentials,
  requeueAmoAuthDeadLetters,
  sanitizeAmoSyncError,
} from '../common/amo-sync-retry';

const OPS_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly amo = new AmoCrmAdapter();
  private readonly morekit = new MorekitAdapter();
  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    @InjectQueue('notifications') private notificationQueue: Queue,
    private readonly catalogService: CatalogService,
    private readonly yandexDiskPhotosService: YandexDiskPhotosService,
    private readonly gsheets: GoogleSheetsSyncService,
    private readonly adminService: AdminService,
    private readonly cms: CmsService,
    @Optional() private readonly opsAlerts?: OpsAlertService,
  ) {}

  // Placeholder — AmoReconciliationService не подключён в этой версии.
  @Cron('30 */10 * * * *')
  async handleAmoUniquenessReconciliation() {
    // no-op until amo-reconciliation.service is deployed
  }

  // amoCRM contact fields are the source of truth for broker-tour attendance.
  // Fetch only contacts linked to canonical brokers (not the whole amo base)
  // through the adapter's 250-ID batches. There is deliberately no env-token
  // guard: AmoCrmAdapter can restore tokens from SystemSetting at bootstrap.
  @Cron('15 15,45 * * * *')
  async handleBrokerTourContactSync() {
    try {
      const brokers = await this.prisma.broker.findMany({
        where: {
          role: 'BROKER',
          mergedIntoId: null,
          amoContactId: { not: null },
        },
        select: {
          id: true,
          amoContactId: true,
          brokerTourVisited: true,
          brokerTourDate: true,
        },
      });
      if (brokers.length === 0) return;

      const amoIds = brokers
        .map((broker) => Number(broker.amoContactId))
        .filter((id) => Number.isSafeInteger(id) && id > 0);
      const contacts = await this.amo.getContactsByIds(amoIds);

      let updated = 0;
      let missing = 0;
      let errors = 0;
      for (const broker of brokers) {
        const amoContactId = Number(broker.amoContactId);
        const contact = contacts.get(amoContactId);
        if (!contact) {
          missing++;
          continue;
        }

        const update = buildBrokerTourUpdate(
          broker,
          brokerTourSnapshotFromAmoContact(contact),
        );
        if (!update) continue;

        try {
          await this.prisma.broker.update({
            where: { id: broker.id },
            data: update,
          });
          updated++;
        } catch {
          errors++;
        }
      }

      this.logger.log(
        `[broker-tour-sync] linked=${brokers.length} fetched=${contacts.size} updated=${updated} missing=${missing} errors=${errors}`,
      );
    } catch (error: any) {
      this.logger.error(`[broker-tour-sync] fatal error=${error?.name || 'unknown'}`);
    }
  }
  // 2026-07-01: каждые 10 минут — автосинк задач-встреч из amoCRM в наши
  // Meeting. Менеджер ставит в amoCRM задачу типа «Встреча» (task_type_id=2)
  // с датой на лиде клиента брокера — в кабинете брокера сразу появляется
  // соответствующая Meeting запись. Раньше синк шёл только раз в 30 мин
  // через handleAmoCrmSync и только из custom_field «Дата и время встречи»
  // лида — задачи-встречи не подхватывались, брокер не видел новые встречи.
  @Cron('*/10 * * * *')
  async handleAmoMeetingTasksSync() {
    if (!hasConfiguredAmoCredentials()) {
      await this.alertAmoTokenMissing();
      return;
    }
    const MEETING_TASK_TYPE = 2;

    // Берём только клиентов с amoLeadId, чей лид был обновлён за 60 дней
    // (иначе тянем весь исторический список — тяжело).
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const clients = await this.prisma.client.findMany({
      where: {
        amoLeadId: { not: null },
        OR: [
          { amoUpdatedAt: { gte: sixtyDaysAgo } },
          { amoUpdatedAt: null }, // старые записи без даты — проверим
        ],
      },
      select: { id: true, brokerId: true, amoLeadId: true },
      take: 500, // лимит на прогон
    });
    if (clients.length === 0) return;

    let created = 0;
    let skipped = 0;
    let errors = 0;
    for (const c of clients) {
      const leadId = Number(c.amoLeadId);
      if (!leadId) continue;
      try {
        const tasks = await this.amo.getTasksByEntity('leads', leadId);
        for (const t of tasks) {
          if (t.task_type_id !== MEETING_TASK_TYPE) continue;
          if (!t.complete_till) continue;
          const meetingDate = new Date(t.complete_till * 1000);
          if (isNaN(meetingDate.getTime())) continue;

          // Уже есть Meeting с этой датой у этого брокера/клиента? Skip.
          const existing = await this.prisma.meeting.findFirst({
            where: {
              brokerId: c.brokerId,
              clientId: c.id,
              date: meetingDate,
            },
          });
          if (existing) {
            // Синк статуса: если task завершена → COMPLETED.
            if (t.is_completed && existing.status !== 'COMPLETED') {
              await this.prisma.meeting.update({
                where: { id: existing.id },
                data: { status: 'COMPLETED' as any },
              });
            }
            skipped++;
            continue;
          }

          // Определяем тип встречи по тексту задачи.
          const textLower = (t.text || '').toLowerCase();
          const type = textLower.includes('онлайн') ? 'ONLINE'
            : textLower.includes('тур') ? 'BROKER_TOUR'
            : 'OFFICE_VISIT';

          await this.prisma.meeting.create({
            data: {
              brokerId: c.brokerId,
              clientId: c.id,
              type: type as any,
              status: (t.is_completed ? 'COMPLETED' : 'PENDING') as any,
              date: meetingDate,
              comment: null,
            },
          });
          created++;
        }
      } catch (e: any) {
        errors++;
        if (errors <= 3) this.logger.warn(`[amo-meeting-tasks] lead ${leadId} failed: ${e?.message || e}`);
      }
    }
    if (created > 0 || errors > 0) {
      this.logger.log(`[amo-meeting-tasks] clients=${clients.length} created=${created} skipped=${skipped} errors=${errors}`);
    }
  }

  // 2026-07-01: каждые 10 минут — синк СТАТУСОВ активных встреч из amoCRM.
  // Логика:
  //   - берём Meeting.status ∈ (PENDING, CONFIRMED) и date за последние 7
  //     дней или в будущем (не имеет смысла обновлять старые);
  //   - вытягиваем client.amoLeadId → getLead(id) → mapMeetingStatus(lead.status_id);
  //   - если статус изменился, обновляем Meeting.status.
  //   - оптимизация: если несколько встреч у одного клиента (amoLeadId) —
  //     один запрос к amoCRM.
  @Cron('*/10 * * * *')
  async handleMeetingsStatusSync() {
    // Client — это заявка конкретного брокера, а не уникальная карточка
    // физлица. Записи с одинаковым телефоном намеренно сохраняются отдельно:
    // иначе исчезают конкурирующие фиксации и история проверки уникальности.

    // 2026-07-01: одноразовая очистка старых comment «Тип из amoCRM: X».
    // До PR #207 синк писал этот бесполезный текст в comment. После PR #207
    // новые встречи такое уже не пишут, но старые записи в БД остались —
    // засоряли UI в /meetings. Один UPDATE, потом всегда UPDATE 0.
    try {
      // 2026-07-22: было UPDATE "Meeting" — таблица meetings (@@map),
      // 42P01 каждый цикл, очистка комментариев так и не отработала.
      await this.prisma.$executeRaw`
        UPDATE "meetings"
        SET "comment" = NULL
        WHERE "comment" LIKE 'Тип из amoCRM:%'
      `;
    } catch (e: any) {
      this.logger.error(`[meetings-status-sync] cleanup «Тип из amoCRM» error: ${e?.message || e}`);
    }

    // 2026-07-01: одноразовая очистка старых записей «[timestamp] amoCRM
    // статус: XXX» в client.comment. Webhook перестал писать это в PR #218,
    // но старые записи остались и брокер видит их в карточке клиента.
    // Regexp удаляет все такие строки (с необязательным \n). Потом NULLим
    // пустые comment. Идемпотентно.
    try {
      // 2026-07-22: было UPDATE "Client" — таблица clients (@@map), 42P01.
      await this.prisma.$executeRaw`
        UPDATE "clients"
        SET "comment" = regexp_replace(
          "comment",
          E'\\n?\\[\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}\\] amoCRM статус: \\d+',
          '',
          'g'
        )
        WHERE "comment" ~ 'amoCRM статус: \\d+'
      `;
      await this.prisma.$executeRaw`
        UPDATE "clients"
        SET "comment" = NULL
        WHERE "comment" IS NOT NULL AND TRIM("comment") = ''
      `;
    } catch (e: any) {
      this.logger.error(`[meetings-status-sync] cleanup «amoCRM статус» error: ${e?.message || e}`);
    }

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    try {
      const meetings = await this.prisma.meeting.findMany({
        where: {
          status: { in: ['PENDING' as any, 'CONFIRMED' as any] },
          date: { gte: sevenDaysAgo },
        },
        include: { client: { select: { amoLeadId: true } } },
      });
      // Группируем по amoLeadId, чтобы 1 запрос — 1 лид.
      const byLeadId = new Map<number, typeof meetings>();
      for (const m of meetings) {
        const leadId = m.client?.amoLeadId ? Number(m.client.amoLeadId) : null;
        if (!leadId) continue;
        if (!byLeadId.has(leadId)) byLeadId.set(leadId, []);
        byLeadId.get(leadId)!.push(m);
      }
      if (byLeadId.size === 0) {
        this.logger.log('[meetings-status-sync] нечего синкать');
        return;
      }
      let updated = 0;
      let checked = 0;
      let errors = 0;
      for (const [leadId, group] of byLeadId.entries()) {
        try {
          const lead = await this.amo.getLead(leadId);
          checked++;
          if (!lead) continue;
          const newStatus = mapMeetingStatus((lead as any).status_id);
          for (const m of group) {
            if (m.status !== newStatus) {
              await this.prisma.meeting.update({
                where: { id: m.id },
                data: { status: newStatus as any },
              });
              updated++;
            }
          }
        } catch (e: any) {
          errors++;
          if (errors <= 3) this.logger.warn(`[meetings-status-sync] lead ${leadId} failed: ${e?.message || e}`);
        }
      }
      this.logger.log(`[meetings-status-sync] leads=${byLeadId.size} checked=${checked} updated=${updated} errors=${errors}`);
    } catch (e: any) {
      this.logger.error(`[meetings-status-sync] fatal: ${e?.message || e}`);
    }
  }

  // 2026-07-06: раз в сутки — синк брокеров из amoCRM (воронка «БРОКЕРЫ»
  // pipeline 10787390). Существующие в БД брокеры обновляются в consistent
  // manner (fullName/email заполняем только если у нас пусто — не перетираем
  // то, что брокер сам ввёл в кабинете). Новые — создаются со статусом
  // PENDING. Плюс: у каждого брокера контакт линкуется с amoCRM Company
  // по ИНН — «Компания» на карточке заполняется автоматически.
  // Время: 03:00 UTC = 06:00 МСК. Google-синк идёт раньше (02:00 UTC).
  @Cron('0 3 * * *')
  async handleAmoBrokersSync() {
    if (!hasConfiguredAmoCredentials()) {
      this.logger.warn('[amo-brokers] AMO_ACCESS_TOKEN не задан — skip');
      await this.alertAmoTokenMissing();
      return;
    }
    this.logger.log('[amo-brokers] запускаю importBrokersFromAmo...');
    try {
      const r = await this.adminService.importBrokersFromAmo();
      this.logger.log(
        `[amo-brokers] OK: leads=${r.foundLeads} contacts=${r.uniqueContacts} `
          + `created=${r.created} updated=${r.updated} skipped=${r.skipped}`
          + (r.errors?.length ? ` errors=${r.errors.length}` : ''),
      );
    } catch (e: any) {
      this.logger.error(`[amo-brokers] FAILED: ${e?.message || e}`);
    }
  }

  // 2026-06-09: каждые 30 минут — синк брокерской базы из Google Sheet.
  // URL читается из SystemSetting.GSHEETS_BROKERS_URL. Если URL пуст —
  // сервис сам залогирует warning и завершится без ошибки.
  @Cron('*/30 * * * *')
  async handleGSheetsBrokersSync() {
    const r = await this.gsheets.sync();
    if (r.inflight) {
      this.logger.log('[gsheets-brokers] предыдущий синк ещё идёт, skip');
    } else if (r.ok) {
      this.logger.log(`[gsheets-brokers] OK: total=${r.total} created=${r.created} updated=${r.updated} errors=${r.errors} ${r.durationMs}ms`);
    } else if (r.error) {
      this.logger.warn(`[gsheets-brokers] FAILED: ${r.error}`);
    }
  }
  // 2026-07-23: КЦ-заявки, зависшие на Админе. MoreKIT ставит оператора в
  // ЗАДАЧЕ, а карточку синкает разовый 5-мин поллинг при создании фиксации —
  // но для делегированных/повторных фиксаций синк выключен, а позднее
  // назначение MoreKIT (задача пришла после поллинга) никто не подхватывает.
  // Итог: лид остаётся на владельце токена (Админ), поле «Ответственный КЦ»
  // = «Без КЦ».
  //
  // ПРЕДОХРАНИТЕЛЬ (из-за него periodic-синк откатывали в июне): трогаем ТОЛЬКО
  // лиды, всё ещё висящие на Админе, и ставим ответственного из СВЕЖЕЙ задачи
  // НЕ-Админа. Как только лид на живом операторе — фильтр его больше не
  // возвращает, «прыгания» ответственного нет.
  @Cron('*/5 * * * *')
  async handleStuckKcLeadResponsible() {
    const adminId = Number(process.env.AMO_ADMIN_USER_ID || 6089620);
    if (!adminId) return;
    const sinceSec = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60; // за 7 дней
    let stuck: any[] = [];
    try {
      stuck = await this.amo.getLeadsByPipelineAndResponsible(AMO_PIPELINES.KC, adminId, sinceSec);
    } catch (e: any) {
      this.logger.warn(`[kc-responsible-sync] выборка лидов упала: ${e?.message || e}`);
      return;
    }
    if (!stuck.length) return;

    let fixed = 0;
    for (const lead of stuck) {
      try {
        // Не трогаем закрытые лиды (успех/отказ).
        if (lead.status_id === 142 || lead.status_id === 143) continue;
        // Повторная проверка ответственного на свежих данных (защита от гонки).
        if (Number(lead.responsible_user_id) !== adminId) continue;
        const tasks = await this.amo.getTasksByEntity('leads', lead.id);
        const opTask = tasks
          .filter((t) => t.responsible_user_id && Number(t.responsible_user_id) !== adminId)
          .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];
        if (!opTask?.responsible_user_id) continue; // MoreKIT ещё не назначил оператора
        await this.amo.updateLead(lead.id, { responsible_user_id: opTask.responsible_user_id });
        fixed++;
        this.logger.log(
          `[kc-responsible-sync] lead=${lead.id}: ${adminId} → ${opTask.responsible_user_id} (task ${opTask.id})`,
        );
      } catch (e: any) {
        this.logger.error(`[kc-responsible-sync] lead=${lead.id} error: ${e?.message || e}`);
      }
    }
    if (fixed) this.logger.log(`[kc-responsible-sync] исправлено заявок: ${fixed} из ${stuck.length} на Админе`);
  }

  // 2026-05-29: Yandex.Disk локальный кеш файлов — раз в сутки в 04:00.
  // Скачивает физически файлы в /app/uploads/yandex/, обновляет Document.fileUrl
  // на /files/yandex/... — nginx отдаёт напрямую без обращения к Я.Диску.
  // Преимущество: превью видео/фото/PDF открывается в браузере сразу, без
  // лишнего клика через Я.Диск UI.
  @Cron('0 4 * * *')
  async handleYandexDiskSync() {
    const publicKey = process.env.YANDEX_DISK_PUBLIC_KEY;
    if (!publicKey) {
      this.logger.warn('YANDEX_DISK_PUBLIC_KEY не настроен — пропускаю синк материалов');
      return;
    }
    this.logger.log('Yandex.Disk files sync started (local cache)...');
    try {
      const { spawnSync } = require('child_process');
      const path = require('path');
      const scriptPath = path.resolve(__dirname, '../../../../scripts/sync-yandex-files.js');
      const result = spawnSync('node', [scriptPath], {
        env: { ...process.env, YANDEX_DISK_PUBLIC_KEY: publicKey },
        encoding: 'utf-8',
        timeout: 60 * 60 * 1000, // до часа — на первый прогон много скачать
      });
      if (result.stdout) this.logger.log(result.stdout.trim());
      if (result.stderr) this.logger.error(result.stderr.trim());
    } catch (e) {
      this.logger.error(`Yandex.Disk files sync failed: ${e}`);
    }
  }
  // 2026-08-21: was once a day at 03:00 — bumped to every 2h so price/status
  // changes in ProfitBase (booked/sold, discounts) show up sooner. Kept
  // separate from the heavier Yandex.Disk photo enrichment below, which
  // stays daily (re-walking/re-downloading those folders every 2h would
  // hammer Yandex's public API for no benefit — photo folders barely change).
  @Cron('0 */2 * * *')
  async handleCatalogSync() {
    this.logger.log('Starting Profitbase XML feed sync...');
    try {
      const result = await this.catalogService.syncFromFeed();
      this.logger.log(`Catalog sync complete: +${result.created}, ~${result.updated}, total ${result.total}`);
    } catch (e) {
      this.logger.error(`Catalog sync failed: ${e}`);
    }
  }

  // 2026-08-21: daily, offset from the 03:00 (now every-2h) feed sync and
  // the 04:00 Yandex materials sync so the two Yandex.Disk jobs don't
  // overlap. Recomputes Lot.photos from the latest planImageUrl/
  // feedImageUrls plus personal Yandex.Disk photos — see
  // docs/yandex-disk-photos-feed.md.
  @Cron('30 4 * * *')
  async handleYandexDiskLotPhotosSync() {
    this.logger.log('Starting Yandex.Disk lot-photos enrichment...');
    try {
      const result = await this.yandexDiskPhotosService.enrichLotsWithPhotos();
      this.logger.log(
        `Yandex.Disk lot-photos enrichment complete: source1=${result.matchedSource1}, source2=${result.matchedSource2}, updated=${result.updated}, failed=${result.failed}`,
      );
    } catch (e) {
      this.logger.error(`Yandex.Disk lot-photos enrichment failed: ${e}`);
    }
  }
  // Run every day at 09:00
  @Cron('0 9 * * *')
  async handleFixationReminders() {
    this.logger.log('Running fixation reminder check...');
    const now = new Date();
    const in7days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const in3days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    const in1day = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);
    // 7-day reminder
    const expiring7 = await this.prisma.client.findMany({
      where: {
        uniquenessStatus: 'CONDITIONALLY_UNIQUE',
        uniquenessExpiresAt: { gte: now, lte: in7days },
      },
      include: { broker: true },
    });
    for (const client of expiring7) {
      const daysLeft = Math.ceil(
        (client.uniquenessExpiresAt!.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
      );
      // Only send for exact 7, 3, 1 day boundaries (avoid duplicates)
      if (daysLeft === 7 || daysLeft === 3 || daysLeft === 1) {
        const subject = 'Истечение фиксации';
        const body = `Уникальность клиента ${client.fullName} (${client.phone}) истекает через ${daysLeft} дн. Продлите или завершите фиксацию.`;
        // Fan out to all channels — processor will respect broker preferences.
        await this.notificationQueue.add('send', {
          brokerId: client.brokerId, channel: 'SMS', body, eventType: 'FIXATION_EXPIRY',
        });
        await this.notificationQueue.add('send', {
          brokerId: client.brokerId, channel: 'EMAIL', subject, body, eventType: 'FIXATION_EXPIRY',
        });
        await this.notificationQueue.add('send', {
          brokerId: client.brokerId,
          channel: 'PUSH',
          subject,
          body,
          eventType: 'FIXATION_EXPIRY',
          data: { url: '/clients', tag: `fix-expiry-${client.id}` },
        });
        if (client.broker.telegramChatId) {
          await this.notificationQueue.add('send', {
            brokerId: client.brokerId,
            channel: 'TELEGRAM',
            body: `⚠️ Уникальность клиента <b>${client.fullName}</b> истекает через <b>${daysLeft} дн.</b>\nТелефон: ${client.phone}`,
            eventType: 'FIXATION_EXPIRY',
          });
        }
        this.logger.log(`Reminder sent: ${client.fullName} → ${client.broker.fullName} (${daysLeft}d left)`);
      }
    }
    this.logger.log(`Fixation reminders: checked ${expiring7.length} clients`);
  }
  // Run every hour — expire stale fixations
  @Cron(CronExpression.EVERY_HOUR)
  async handleFixationExpiry() {
    const now = new Date();
    // Expire uniqueness
    const expiredUniqueness = await this.prisma.client.updateMany({
      where: {
        uniquenessStatus: 'CONDITIONALLY_UNIQUE',
        uniquenessExpiresAt: { lt: now },
      },
      data: {
        uniquenessStatus: 'EXPIRED',
        uniquenessReason: 'Автоматически истёк срок уникальности',
      },
    });
    if (expiredUniqueness.count > 0) {
      this.logger.log(`Expired ${expiredUniqueness.count} uniqueness records`);
      // Notify brokers about expired clients
      const expiredClients = await this.prisma.client.findMany({
        where: {
          uniquenessStatus: 'EXPIRED',
          uniquenessReason: 'Автоматически истёк срок уникальности',
          updatedAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) }, // Last hour
        },
      });
      for (const client of expiredClients) {
        const body = `Уникальность клиента ${client.fullName} (${client.phone}) истекла. Подайте новую заявку для продления.`;
        await this.notificationQueue.add('send', {
          brokerId: client.brokerId, channel: 'SMS', body, eventType: 'FIXATION_EXPIRY',
        });
        await this.notificationQueue.add('send', {
          brokerId: client.brokerId,
          channel: 'PUSH',
          subject: 'Фиксация истекла',
          body,
          eventType: 'FIXATION_EXPIRY',
          data: { url: '/clients', tag: `fix-expired-${client.id}` },
        });
      }
    }
    // Expire fixations
    const expiredFixations = await this.prisma.client.updateMany({
      where: {
        fixationStatus: 'FIXED',
        fixationExpiresAt: { lt: now },
      },
      data: {
        fixationStatus: 'EXPIRED',
      },
    });
    if (expiredFixations.count > 0) {
      this.logger.log(`Expired ${expiredFixations.count} fixation records`);
    }
  }
  // Run every 15 min — fire 24h and 1h reminders for upcoming meetings
  @Cron('*/15 * * * *')
  async handleMeetingReminders() {
    const now = new Date();
    // 24h-ahead window: [now+23h45m, now+24h15m]
    const t24Lo = new Date(now.getTime() + (23 * 60 + 45) * 60 * 1000);
    const t24Hi = new Date(now.getTime() + (24 * 60 + 15) * 60 * 1000);
    const upcoming24 = await this.prisma.meeting.findMany({
      where: {
        status: { not: 'CANCELLED' },
        reminded24h: false,
        date: { gte: t24Lo, lte: t24Hi },
      },
      include: {
        client: { select: { fullName: true, phone: true } },
        broker: { select: { telegramChatId: true } },
      },
    });
    for (const m of upcoming24) {
      await this.fanOutMeetingReminder(m, '24 ч');
      await this.prisma.meeting.update({ where: { id: m.id }, data: { reminded24h: true } });
    }
    // 1h-ahead window: [now+45m, now+1h15m]
    const t1Lo = new Date(now.getTime() + 45 * 60 * 1000);
    const t1Hi = new Date(now.getTime() + 75 * 60 * 1000);
    const upcoming1 = await this.prisma.meeting.findMany({
      where: {
        status: { not: 'CANCELLED' },
        reminded1h: false,
        date: { gte: t1Lo, lte: t1Hi },
      },
      include: {
        client: { select: { fullName: true, phone: true } },
        broker: { select: { telegramChatId: true } },
      },
    });
    for (const m of upcoming1) {
      await this.fanOutMeetingReminder(m, '1 ч');
      await this.prisma.meeting.update({ where: { id: m.id }, data: { reminded1h: true } });
    }
    if (upcoming24.length || upcoming1.length) {
      this.logger.log(`Meeting reminders: 24h=${upcoming24.length}, 1h=${upcoming1.length}`);
    }
  }
  private async fanOutMeetingReminder(
    m: { id: string; brokerId: string; date: Date; type: string; client: { fullName: string; phone: string }; broker: { telegramChatId: bigint | null } },
    when: string,
  ) {
    const dateStr = new Date(m.date).toLocaleString('ru-RU', {
      day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit',
    });
    const typeLabel = m.type === 'OFFICE_VISIT' ? 'в офисе' : m.type === 'ONLINE' ? 'онлайн' : 'брокер-тур';
    const subject = `Напоминание о встрече`;
    const body = `Напоминание: встреча ${typeLabel} с ${m.client.fullName} (${m.client.phone}) через ${when} — ${dateStr}.`;
    await this.notificationQueue.add('send', {
      brokerId: m.brokerId, channel: 'PUSH', subject, body,
      eventType: 'MEETING_REMINDER',
      data: { url: '/meetings', tag: `meeting-${m.id}` },
    });
    await this.notificationQueue.add('send', {
      brokerId: m.brokerId, channel: 'EMAIL', subject, body,
      eventType: 'MEETING_REMINDER',
    });
    await this.notificationQueue.add('send', {
      brokerId: m.brokerId, channel: 'SMS', body,
      eventType: 'MEETING_REMINDER',
    });
    if (m.broker.telegramChatId) {
      await this.notificationQueue.add('send', {
        brokerId: m.brokerId, channel: 'TELEGRAM',
        body: `📅 ${body}`,
        eventType: 'MEETING_REMINDER',
      });
    }
  }
  // Run daily at 02:00 — cleanup and stats
  @Cron('0 2 * * *')
  async handleDailyMaintenance() {
    this.logger.log('Running daily maintenance...');
    // Update broker funnel stages based on activity
    const brokersWithDeals = await this.prisma.broker.findMany({
      where: {
        funnelStage: { not: 'DEAL' },
        deals: { some: { status: { in: ['PAID', 'COMMISSION_PAID'] } } },
      },
    });
    for (const broker of brokersWithDeals) {
      await this.prisma.broker.update({
        where: { id: broker.id },
        data: { funnelStage: 'DEAL' },
      });
    }
    if (brokersWithDeals.length > 0) {
      this.logger.log(`Updated ${brokersWithDeals.length} broker funnel stages to DEAL`);
    }
    // Log daily stats
    const [totalBrokers, activeBrokers, totalClients, activeFixations, totalDeals] =
      await Promise.all([
        this.prisma.broker.count(),
        this.prisma.broker.count({ where: { status: 'ACTIVE' } }),
        this.prisma.client.count(),
        this.prisma.client.count({ where: { uniquenessStatus: 'CONDITIONALLY_UNIQUE' } }),
        this.prisma.deal.count(),
      ]);
    this.logger.log(
      `Daily stats: ${activeBrokers}/${totalBrokers} brokers, ${totalClients} clients, ${activeFixations} active fixations, ${totalDeals} deals`,
    );
  }
  // Run every 30 minutes — sync deals/clients from amoCRM for all linked brokers
  @Cron('*/30 * * * *')
  async handleAmoCrmSync() {
    if (!hasConfiguredAmoCredentials()) {
      await this.alertAmoTokenMissing();
      return;
    }
    this.logger.log('Starting amoCRM sync for all linked brokers...');
    const brokers = await this.prisma.broker.findMany({
      where: { amoContactId: { not: null }, status: 'ACTIVE' },
      select: { id: true, fullName: true, phone: true, amoContactId: true },
    });
    let totalDeals = 0;
    let totalClients = 0;
    for (const broker of brokers) {
      try {
        // Cleanup: удалить устаревшие Meeting/Deal/Client с fake-телефонами +70000XXX.
        // Сначала зависимые таблицы (Meeting, Deal), затем Client. Правка 2026-05-14.
        await this.prisma.meeting.deleteMany({
          where: { brokerId: broker.id, client: { phone: { startsWith: '+70000' } } },
        });
        await this.prisma.deal.deleteMany({
          where: { brokerId: broker.id, client: { phone: { startsWith: '+70000' } } },
        });
        await this.prisma.client.deleteMany({
          where: { brokerId: broker.id, phone: { startsWith: '+70000' } },
        });
        const amoContactId = Number(broker.amoContactId);
        // Re-check for correct broker contact (with Брокер=true flag)
        const brokerContact = await this.amo.findBrokerContactByPhone(broker.phone);
        if (brokerContact && brokerContact.id !== amoContactId) {
          await this.prisma.broker.update({
            where: { id: broker.id },
            data: { amoContactId: BigInt(brokerContact.id) },
          });
        }
        const contactId = brokerContact?.id || amoContactId;
        const fullContact = await this.amo.getContact(contactId);
        const linkedLeads = fullContact?._embedded?.leads || [];
        for (const leadRef of linkedLeads) {
          try {
            const lead: any = await this.amo.getLead(leadRef.id);
            if (!lead) continue;
            // Skip broker pipeline (это про самого брокера)
            if (lead.pipeline_id === BROKER_PIPELINE_ID) continue;
            // КЦ-карточки: status 142 = "встреча проведена", не "клиент купил".
            // Не создаём Deal, но meeting-sync проходит. Правка 2026-05-13.
            const isKcPipeline = lead.pipeline_id === AMO_PIPELINES.KC;
            const isDealLead = !isKcPipeline && lead.status_id !== 143 && isDealStage(lead.status_id);
            const project = leadToProject(lead);
            // Find client contact in lead
            const leadContacts = lead?._embedded?.contacts || [];
            const clientRef = leadContacts.find((c: any) => c.id !== contactId) || leadContacts[0];
            let fullName = cleanClientName(lead.name);
            let phone = `+70000${leadRef.id}`;
            let email: string | null = null;
            if (clientRef) {
              const cc: any = await this.amo.getContact(clientRef.id);
              if (cc) {
                const ccCleaned = cleanClientName(cc.name);
                if (ccCleaned !== 'Без имени') fullName = ccCleaned;
                const pf = (cc.custom_fields_values || []).find(
                  (f: any) => f.field_id === AMO_CONTACT_FIELDS.PHONE || f.field_code === 'PHONE',
                );
                let p = String(pf?.values?.[0]?.value || '').replace(/[\s\-()'"]/g, '');
                if (p.startsWith('8') && p.length === 11) p = '+7' + p.slice(1);
                if (p && !p.startsWith('+')) p = '+' + p;
                if (p) phone = p;
                const ef = (cc.custom_fields_values || []).find(
                  (f: any) => f.field_id === AMO_CONTACT_FIELDS.EMAIL || f.field_code === 'EMAIL',
                );
                email = ef?.values?.[0]?.value || null;
              }
            }
            // Skip if no real phone — раньше fake-телефон +70000<leadId>.
            // Правка 2026-05-14.
            if (phone.startsWith('+70000')) {
              const fakeClient = await this.prisma.client.findFirst({ where: { phone, brokerId: broker.id } });
              if (fakeClient) {
                await this.prisma.meeting.deleteMany({ where: { clientId: fakeClient.id } });
                await this.prisma.deal.deleteMany({ where: { clientId: fakeClient.id } });
                await this.prisma.client.delete({ where: { id: fakeClient.id } });
              }
              continue;
            }
            // Upsert client с реальной датой создания/изменения из amoCRM (правка 2026-05-14).
            const leadCreatedAt = lead.created_at ? new Date(lead.created_at * 1000) : null;
            const leadUpdatedAt = lead.updated_at ? new Date(lead.updated_at * 1000) : null;
            const brokerOwnership = {
              OR: [
                { responsibleBrokerId: broker.id },
                { responsibleBrokerId: null, brokerId: broker.id },
              ],
            };
            // Не склеиваем заявки разных брокеров по телефону. Синк может
            // переиспользовать только заявку того же фактического брокера.
            let client = await this.prisma.client.findFirst({
              where: { phone, amoLeadId: BigInt(leadRef.id), ...brokerOwnership },
              orderBy: { createdAt: 'desc' },
            });
            if (!client) {
              client = await this.prisma.client.findFirst({
                where: { phone, amoLeadId: null, ...brokerOwnership },
                orderBy: { createdAt: 'desc' },
              });
              if (client) {
                client = await this.prisma.client.update({
                  where: { id: client.id },
                  data: { amoLeadId: BigInt(leadRef.id), amoReconciliationStatus: 'STALE' } as any,
                });
              }
            }
            if (!client) {
              client = await (this.prisma.client.create as any)({
                data: {
                  brokerId: broker.id, fullName, phone, email,
                  source: 'AMO_IMPORT',
                  project: project as any,
                  amoLeadId: BigInt(lead.id),
                  uniquenessStatus: UniquenessStatus.CONDITIONALLY_UNIQUE,
                  // Уникальность = 30 дней от даты создания лида в amoCRM (правка 2026-05-14).
                  uniquenessExpiresAt: new Date((leadCreatedAt ? leadCreatedAt.getTime() : Date.now()) + 30 * 24 * 60 * 60 * 1000),
                  amoCreatedAt: leadCreatedAt,
                  amoUpdatedAt: leadUpdatedAt,
                },
              });
              totalClients++;
            } else if (leadCreatedAt || leadUpdatedAt) {
              // MIN amoCreatedAt + MAX amoUpdatedAt. Уникальность от MIN + 30 дней. Правка 2026-05-14.
              const updateData: any = {};
              if (leadCreatedAt) {
                if (!client.amoCreatedAt || leadCreatedAt < client.amoCreatedAt) {
                  updateData.amoCreatedAt = leadCreatedAt;
                  updateData.uniquenessExpiresAt = new Date(leadCreatedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
                }
              }
              if (leadUpdatedAt) {
                if (!client.amoUpdatedAt || leadUpdatedAt > client.amoUpdatedAt) {
                  updateData.amoUpdatedAt = leadUpdatedAt;
                }
              }
              if (Object.keys(updateData).length > 0) {
                await this.prisma.client.update({ where: { id: client.id }, data: updateData });
              }
            }
            // КЦ: cleanup существующего Deal + ранний переход к meeting-sync.
            // КЦ / 143 / не-deal-stage — удалить ошибочный Deal из БД (если был синкан раньше).
            // Правка 2026-05-13. Лена-style stale-записи теперь пропадают при первом же sync.
            if (!isDealLead) {
              const staleDeal = await this.prisma.deal.findFirst({ where: { amoDealId: BigInt(lead.id) } });
              if (staleDeal) {
                await this.prisma.deal.delete({ where: { id: staleDeal.id } });
              }
            }
            const status = isDealLead ? statusToDealStatus(lead.status_id) : null;
            // Извлекаем sqm/price из custom_fields. Правка 2026-05-12 — раньше sqm=0
            // и amount=lead.price (без учёта скидок). Теперь приоритет custom-полям.
            const sqm = getLeadCustomFieldNumber(lead, AMO_LEAD_FIELDS.SQM);
            const priceNoDiscount = getLeadCustomFieldNumber(lead, AMO_LEAD_FIELDS.PRICE_NO_DISCOUNT);
            const amount = priceNoDiscount > 0 ? priceNoDiscount : Number(lead.price || 0);
            const ccIdParent = getLeadCustomFieldValue(lead, AMO_LEAD_FIELDS.CC_ID_PARENT);
            // Комиссия — приоритет: значения из amoCRM (673171/673169).
            // Менеджер проставляет руками. Локальный расчёт только fallback. Правка 2026-05-14.
            const dealDate = lead.created_at ? new Date(lead.created_at * 1000) : new Date();
            const amoCommissionAmt = getLeadCustomFieldNumber(lead, AMO_LEAD_FIELDS.COMMISSION_AMOUNT);
            const amoCommissionRate = getLeadCustomFieldNumber(lead, AMO_LEAD_FIELDS.COMMISSION_RATE);
            let rate: number;
            let commAmt: number;
            if (amoCommissionAmt > 0 || amoCommissionRate > 0) {
              rate = amoCommissionRate > 0 ? amoCommissionRate : (amount > 0 ? (amoCommissionAmt / amount) * 100 : 0);
              commAmt = amoCommissionAmt > 0 ? Math.round(amoCommissionAmt) : Math.round(amount * rate / 100);
            } else {
              const ba = await this.prisma.brokerAgency.findFirst({
                where: { brokerId: broker.id, isPrimary: true },
                include: { agency: true },
              });
              const totalSqm = Number(ba?.agency?.totalSqmSold || 0);
              const policyResult = await rateForWithPolicy(this.prisma, project, totalSqm, dealDate);
              rate = policyResult.rate;
              commAmt = Math.round(amount * rate / 100);
            }
            // Upsert deal — двусторонний дедуп через cc_id_parent.
            let existing = await this.prisma.deal.findFirst({ where: { amoDealId: BigInt(lead.id) } });
            if (!existing && ccIdParent) {
              existing = await this.prisma.deal.findFirst({
                where: {
                  OR: [
                    { amoDealId: BigInt(ccIdParent) },
                    { amoParentDealId: BigInt(ccIdParent) },
                  ],
                },
              });
            }
            if (!existing) {
              existing = await this.prisma.deal.findFirst({ where: { amoParentDealId: BigInt(lead.id) } });
            }
            const dealData: any = {
              clientId: client.id, brokerId: broker.id,
              project: project as any,
              commissionRate: rate, commissionAmount: commAmt,
              status: status as any, amoDealId: BigInt(lead.id),
              amoParentDealId: ccIdParent ? BigInt(ccIdParent) : null,
            };
            // signedAt — дата создания сделки в amoCRM (правка 2026-05-13).
            if (lead.created_at) dealData.signedAt = new Date(lead.created_at * 1000);
            if (sqm > 0 || !existing) dealData.sqm = sqm;
            if (amount > 0 || !existing) dealData.amount = amount;
            if (isDealLead && existing) {
              await this.prisma.deal.update({ where: { id: existing.id }, data: dealData });
              // Post-fix дедуп: удалить дубликат parent/child из БД.
              if (ccIdParent) {
                const dupParent = await this.prisma.deal.findFirst({
                  where: { amoDealId: BigInt(ccIdParent), id: { not: existing.id } },
                });
                if (dupParent) await this.prisma.deal.delete({ where: { id: dupParent.id } });
              }
              const dupChild = await this.prisma.deal.findFirst({
                where: { amoParentDealId: BigInt(lead.id), id: { not: existing.id } },
              });
              if (dupChild) {
                if (Number(dupChild.sqm) > 0 && Number(existing.sqm || 0) === 0) {
                  await this.prisma.deal.delete({ where: { id: existing.id } });
                } else {
                  await this.prisma.deal.delete({ where: { id: dupChild.id } });
                }
              }
            } else if (isDealLead) {
              await this.prisma.deal.create({ data: dealData });
              totalDeals++;
            }
            // Sync meeting for this broker from lead custom fields
            try {
              const cfs = lead?.custom_fields_values || [];
              const dField = cfs.find((f: any) => f.field_name === 'Дата и время встречи');
              const tField = cfs.find((f: any) => f.field_name === 'Встреча');
              const rawDate = dField?.values?.[0]?.value;
              if (rawDate) {
                const mDate = new Date(Number(rawDate) * 1000);
                if (!isNaN(mDate.getTime())) {
                  const rawType = tField?.values?.[0]?.value || '';
                  const v = rawType.toLowerCase();
                  const mType = v.includes('онлайн') ? 'ONLINE' : v.includes('тур') ? 'BROKER_TOUR' : 'OFFICE_VISIT';
                  const mStatus = mapMeetingStatus(lead.status_id);
                  const existingMeeting = await this.prisma.meeting.findFirst({
                    where: { clientId: client.id, brokerId: broker.id, date: mDate },
                  });
                  if (existingMeeting) {
                    await this.prisma.meeting.update({
                      where: { id: existingMeeting.id },
                      data: { type: mType as any, status: mStatus as any },
                    });
                  } else {
                    // 2026-07-01: мини-детали клиента в комментарии.
                    const projectLabel = (client as any)?.project === 'ZORGE9' ? 'Зорге 9'
                      : (client as any)?.project === 'SILVER_BOR' ? 'Серебряный Бор'
                      : ((client as any)?.project || '');
                    const commentLines = [
                      `Клиент: ${client.fullName}`,
                      `Телефон: ${client.phone}`,
                      ...(projectLabel ? [`Проект: ${projectLabel}`] : []),
                    ];
                    await this.prisma.meeting.create({
                      data: {
                        brokerId: broker.id, clientId: client.id,
                        type: mType as any, status: mStatus as any,
                        date: mDate,
                        comment: commentLines.join('\n'),
                      },
                    });
                  }
                }
              }
            } catch {}
          } catch {}
        }
        // Пересчёт totalSqmSold у primary agency после синка всех сделок брокера.
        // Иначе level всегда = START. Правка 2026-05-12.
        try {
          const baFinal = await this.prisma.brokerAgency.findFirst({
            where: { brokerId: broker.id, isPrimary: true },
          });
          if (baFinal?.agencyId) {
            const agg = await this.prisma.deal.aggregate({
              where: { brokerId: broker.id, status: { in: ['PAID', 'COMMISSION_PAID'] } },
              _sum: { sqm: true },
            });
            await this.prisma.agency.update({
              where: { id: baFinal.agencyId },
              data: { totalSqmSold: Number(agg._sum.sqm || 0) },
            });
            // Second-pass recalc убран 2026-05-14: amoCRM теперь авторитет для комиссии.
          }
        } catch (e) {
          this.logger.error(`Recalc totalSqmSold failed for ${broker.fullName}: ${e}`);
        }
      } catch (e) {
        this.logger.error(`amoCRM sync failed for broker ${broker.fullName}: ${e}`);
      }
    }
    this.logger.log(`amoCRM sync complete: ${totalDeals} new deals, ${totalClients} new clients, ${brokers.length} brokers`);
  }

  // 2026-08-19: без этого флага зависший amoCRM (fetch без ответа) позволял
  // следующему прогону крона (через 5 минут) выбрать того же самого клиента
  // и параллельно отправить его ещё раз — в amoCRM создавался дубль лида
  // на одну фиксацию (см. code-review PR #288).
  private amoFailedRetryRunning = false;

  // 2026-05-27 ROBUST AMO #1: auto-retry для клиентов с amoSyncStatus=FAILED.
  // Каждые 5 минут берёт до 20 заявок которые не дошли в amoCRM, пытается
  // переотправить. Если amo живой — заявки появятся в amo автоматически.
  // Гасит счётчик попыток — если >10, не пытаемся больше (вечно сломанное).
  @Cron('*/5 * * * *')
  async handleAmoFailedRetry() {
    if (this.amoFailedRetryRunning) {
      this.logger.warn('amo auto-retry: предыдущий прогон ещё не завершился, пропускаем');
      return;
    }
    this.amoFailedRetryRunning = true;
    try {
      await this.runAmoFailedRetry();
    } finally {
      this.amoFailedRetryRunning = false;
    }
  }

  private async runAmoFailedRetry() {
    if (!hasConfiguredAmoCredentials()) {
      await this.alertAmoTokenMissing();
      return;
    }
    const candidates = await this.prisma.client.findMany({
      where: {
        amoSyncStatus: { in: ['FAILED', 'PENDING'] } as any,
        amoSyncAttempts: { lt: AMO_RETRY_MAX_ATTEMPTS },
        // If an amo id is already recorded, creating another lead is unsafe.
        // Such rows require reconciliation, not createFixationRequest.
        amoLeadId: null,
      },
      include: { broker: true, responsibleBroker: true },
      // Legacy rows can have no last-attempt timestamp. Put them first instead
      // of letting a continuously failing non-null queue starve them forever.
      orderBy: [
        { amoSyncLastAttemptAt: { sort: 'asc', nulls: 'first' } },
        { createdAt: 'asc' },
      ] as any,
      take: 20,
    });
    if (candidates.length === 0) return;
    this.logger.log(`amo auto-retry: ${candidates.length} клиентов в очереди`);

    let ok = 0;
    let failed = 0;
    for (const client of candidates) {
      const requiresUniquenessRecheck = String(client.amoSyncError || '')
        .startsWith(AMO_UNIQUENESS_RECHECK_MARKER);
      // Только ошибка вокруг самого createFixationRequest (POST, создающего
      // лид) неоднозначна — отваливающийся до него checkUniqueness ничего
      // не создаёт, ретраить его безопасно как обычно.
      let leadCreateAttempted = false;
      try {
        const retryBroker = client.responsibleBroker ?? client.broker;
        const clientId = String(client.id);
        const brokerId = retryBroker?.id ? String(retryBroker.id) : 'unknown';
        let retryVerdict: any = null;
        if (requiresUniquenessRecheck) {
          retryVerdict = await this.amo.checkUniqueness(client.phone);
          if (!retryVerdict?.rule) {
            throw new Error('amoCRM uniqueness check returned no decision');
          }

          if (await this.resolveRefixUniquenessDecision(client, retryVerdict)) {
            ok++;
            continue;
          }
          if (![
            'RULE_3',
            'NO_CONFLICT',
            'RULE_EXCEPTION_AFTER_SALES_MEETING',
          ].includes(retryVerdict.rule)) {
            throw new Error('amoCRM uniqueness check returned an unsupported decision');
          }
        }

        if (!client.fixationAgencyId) {
          await this.sendOpsAlert(
            `🔴 PROD: фиксацию нельзя повторить\nclientId: ${clientId}\nbrokerId: ${brokerId}\nПричина: не указана компания; требуется ручная проверка.`,
            `scheduler:amo-retry:missing-agency:${clientId}`,
          );
          throw new Error('Fixation agency is not configured; retry cannot continue');
        }
        const agency = await this.prisma.agency.findUnique({ where: { id: client.fixationAgencyId } });
        if (!agency) {
          await this.sendOpsAlert(
            `🔴 PROD: фиксацию нельзя повторить\nclientId: ${clientId}\nbrokerId: ${brokerId}\nПричина: привязанная компания не найдена; требуется ручная проверка.`,
            `scheduler:amo-retry:missing-agency:${clientId}`,
          );
          throw new Error('Fixation agency was not found; retry cannot continue');
        }

        if (!retryBroker?.amoContactId) {
          const nextAttempts = Number(client.amoSyncAttempts || 0) + 1;
          await this.prisma.client.update({
            where: { id: client.id },
            data: {
              amoSyncError: requiresUniquenessRecheck
                ? client.amoSyncError
                : 'Responsible broker is not linked to an amoCRM contact; retry deferred',
              amoSyncAttempts: { increment: 1 },
              amoSyncLastAttemptAt: new Date(),
              ...(nextAttempts >= AMO_RETRY_MAX_ATTEMPTS
                ? { amoSyncStatus: 'FAILED' as any }
                : {}),
            },
          });
          await this.sendOpsAlert(
            `🔴 PROD: retry фиксации отложен\nclientId: ${clientId}\nbrokerId: ${brokerId}\nПричина: у ответственного брокера нет связи с amoCRM.`,
            `scheduler:amo-retry:missing-broker-contact:${clientId}`,
          );
          if (nextAttempts >= AMO_RETRY_MAX_ATTEMPTS) {
            await this.sendOpsAlert(
              `🔴 PROD: фиксация не доставлена в amoCRM\nclientId: ${clientId}\nbrokerId: ${brokerId}\nАвтоматические повторы исчерпаны (${AMO_RETRY_MAX_ATTEMPTS} попыток); требуется ручная проверка.`,
              `scheduler:amo-retry:dead-letter:${clientId}`,
            );
          }
          failed++;
          continue;
        }

        leadCreateAttempted = true;
        const resultLead = await this.amo.createFixationRequest({
          clientPhone: client.phone,
          clientEmail: client.email || undefined,
          clientName: client.fullName,
          clientRegion: client.clientRegion || undefined,
          brokerPhone: retryBroker.phone,
          brokerAmoContactId: Number(retryBroker.amoContactId),
          agencyName: agency.name,
          agencyInn: agency.inn,
          comment: client.comment || '',
          project: client.project as any,
          propertyType: client.propertyType || undefined,
          roomsCount: client.roomsCount || undefined,
          amount: client.amount ? Number(client.amount) : undefined,
          sqm: client.sqm ? Number(client.sqm) : undefined,
          purchaseTiming: client.purchaseTiming || undefined,
          readinessLevel: client.readinessLevel || undefined,
          fromBroker: true,
        });
        const createdAmoLeadId = resultLead?.id ? Number(resultLead.id) : null;
        if (!createdAmoLeadId) throw new Error('amoCRM не вернула id созданной сделки');
        await this.prisma.client.update({
          where: { id: client.id },
          data: {
            amoSyncStatus: 'SYNCED' as any,
            amoSyncError: null,
            amoSyncAttempts: { increment: 1 },
            amoSyncLastAttemptAt: new Date(),
            // 2026-06-11: без этого retry успешно создавал лид в amoCRM,
            // но id не возвращался обратно в БД — UI продолжал показывать
            // «не передано в amoCRM», и retry-cron больше не запускался
            // (статус SYNCED). Webhook от amoCRM искал Client по amoLeadId
            // и не находил.
            amoLeadId: BigInt(createdAmoLeadId),
            amoReconciliationStatus: 'STALE' as any,
            ...(retryVerdict?.rule === 'RULE_EXCEPTION_AFTER_SALES_MEETING'
              ? {
                  uniquenessStatus: UniquenessStatus.UNDER_REVIEW,
                  uniquenessExpiresAt: null,
                  uniquenessReason: `EXCEPTION_AFTER_SALES_MEETING:${retryVerdict.triggerLeadId || ''}`,
                }
              : requiresUniquenessRecheck
                ? {
                    uniquenessStatus: UniquenessStatus.CONDITIONALLY_UNIQUE,
                    uniquenessExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                    uniquenessReason: null,
                  }
                : {}),
          } as any,
        });

        // 2026-06-11: первый createFixationRequest упал — значит
        // ClientFixationService Морикит НЕ уведомил. Лид в amoCRM теперь
        // существует, но без responsible_user_id висит на авторе OAuth
        // (= админ). Дёргаем Морикит здесь, чтобы он распределил менеджера
        // КЦ по своему графику смен. Fire-and-forget — ошибка Морикита не
        // должна перезапускать amo-retry.
        if (createdAmoLeadId) {
          const morekitUrl = await getSystemSetting(this.prisma, 'MOREKIT_WEBHOOK_URL');
          if (morekitUrl) {
            const amount = client.amount ? Number(client.amount) : 0;
            this.morekit.notifyFixation({
              id: String(createdAmoLeadId),
              agency: agency.name,
              broker_id: String(retryBroker.amoContactId),
              agent_name: retryBroker.fullName,
              agent_phone: morekitPhone(retryBroker.phone),
              agent_mail: retryBroker.email || '',
              budget: amount ? String(amount) : '0',
              clients: [{ name: client.fullName, phone: morekitPhone(client.phone) }],
              type: client.propertyType || 'Квартира',
              lead_date: morekitLeadDate(),
              project: morekitProjectName(String(client.project)),
            }, morekitUrl)
              .then((result) => {
                if (result?.ok !== false) return;
                return this.sendOpsAlert(
                  `🔴 PROD: MoreKIT не получил фиксацию\nclientId: ${clientId}\nbrokerId: ${brokerId}\ncategory: MOREKIT_DELIVERY_FAILED`,
                  `scheduler:amo-retry:morekit-delivery-failed:${clientId}`,
                );
              })
              .catch(() => {
                this.logger.error('[amo-retry] MoreKIT delivery failed');
                return this.sendOpsAlert(
                  `🔴 PROD: MoreKIT не получил фиксацию\nclientId: ${clientId}\nbrokerId: ${brokerId}\ncategory: MOREKIT_DELIVERY_FAILED`,
                  `scheduler:amo-retry:morekit-delivery-failed:${clientId}`,
                );
              });

            // 2026-06-16: убрали syncLeadResponsibleFromLatestTask.
            // Раньше синкали responsible_user_id с самой свежей задачи,
            // но при каждой новой ALARM-задаче ответственный лида
            // менялся (что нежелательно). Морикит сам ставит responsible
            // при создании лида/задачи — не перетираем.
          }
        }
        ok++;
      } catch (e: any) {
        const rawError = String(e?.message || e);
        const safeError = sanitizeAmoSyncError(e);
        // 2026-08-19: сетевая ошибка/5xx во время createFixationRequest не
        // говорит, дошёл ли POST до amoCRM — лид мог реально создаться, а мы
        // просто не увидели ответ. Автоматический повтор через 5 минут может
        // задвоить лид, поэтому для этой категории не даём крону тронуть
        // клиента снова (тот же принцип, что уже применён к дохлому токену
        // ниже) — attempts сразу выставляются в максимум, ручной «Повторить»
        // в /admin/broker-applications остаётся доступен после проверки
        // в самой amoCRM (см. code-review PR #288).
        const isAmbiguousPost = leadCreateAttempted
          && (safeError === 'AMO_NETWORK_ERROR' || safeError === 'AMO_TEMPORARY_UNAVAILABLE');
        const nextAttempts = isAmbiguousPost
          ? AMO_RETRY_MAX_ATTEMPTS
          : Number(client.amoSyncAttempts || 0) + 1;
        await this.prisma.client.update({
          where: { id: client.id },
          data: {
            amoSyncError: requiresUniquenessRecheck ? client.amoSyncError : safeError,
            amoSyncAttempts: isAmbiguousPost ? AMO_RETRY_MAX_ATTEMPTS : { increment: 1 },
            amoSyncLastAttemptAt: new Date(),
            ...(nextAttempts >= AMO_RETRY_MAX_ATTEMPTS
              ? { amoSyncStatus: 'FAILED' as any }
              : {}),
          },
        });
        failed++;
        if (isAmbiguousPost) {
          const retryBroker = client.responsibleBroker ?? client.broker;
          const clientId = String(client.id);
          const brokerId = retryBroker?.id ? String(retryBroker.id) : 'unknown';
          await this.sendOpsAlert(
            `🔴 PROD: неоднозначный ответ amoCRM при фиксации\nclientId: ${clientId}\nbrokerId: ${brokerId}\ncategory: ${safeError}\nЛид мог уже создаться — перед ручным «Повторить» проверьте amoCRM, иначе будет дубль.`,
            `scheduler:amo-retry:ambiguous-post:${clientId}`,
          );
        } else if (nextAttempts >= AMO_RETRY_MAX_ATTEMPTS) {
          const retryBroker = client.responsibleBroker ?? client.broker;
          const clientId = String(client.id);
          const brokerId = retryBroker?.id ? String(retryBroker.id) : 'unknown';
          await this.sendOpsAlert(
            `🔴 PROD: фиксация не доставлена в amoCRM\nclientId: ${clientId}\nbrokerId: ${brokerId}\nАвтоматические повторы исчерпаны (${AMO_RETRY_MAX_ATTEMPTS} попыток); требуется ручная проверка.`,
            `scheduler:amo-retry:dead-letter:${clientId}`,
          );
        }
        // Если 401 — токен умер, остальные ретраи бессмысленны до обновления токена.
        if (/\b(401|403)\b/.test(rawError) || /unauthoriz|forbidden/i.test(rawError)) {
          this.logger.error('amo authorization failed — прерываю auto-retry');
          await this.alertAmoTokenDead(safeError);
          break;
        }
      }
    }
    this.logger.log(`amo auto-retry: ${ok} success, ${failed} failed`);
  }

  /**
   * Resolves re-fix outcomes where creating another amo lead is forbidden.
   * Returns false only for verdicts that explicitly permit a new lead.
   */
  private async resolveRefixUniquenessDecision(client: any, verdict: any): Promise<boolean> {
    const rule = String(verdict?.rule || '');
    if (!['RULE_1', 'RULE_2', 'RULE_REJECT_SALES_DEAL'].includes(rule)) {
      return false;
    }

    const triggerLeadId = Number(verdict?.triggerLeadId);
    const hasTriggerLeadId = Number.isSafeInteger(triggerLeadId) && triggerLeadId > 0;
    const isRule1 = rule === 'RULE_1';
    const isRule2Kc = rule === 'RULE_2'
      && Array.isArray(verdict?.leads)
      && verdict.leads.some(
        (lead: any) => Number(lead?.id) === triggerLeadId
          && Number(lead?.pipeline_id) === 7600542
          && Number(lead?.status_id) === 62907286,
      );

    const uniquenessStatus = rule === 'RULE_REJECT_SALES_DEAL'
      ? UniquenessStatus.REJECTED
      : isRule1
        ? UniquenessStatus.CONDITIONALLY_UNIQUE
        : UniquenessStatus.UNDER_REVIEW;
    const uniquenessReason = rule === 'RULE_REJECT_SALES_DEAL'
      ? `AMO_RULE_REJECT_SALES_DEAL:${hasTriggerLeadId ? triggerLeadId : ''}`
      : isRule2Kc
        ? `RULE_2_KC_PENDING:${hasTriggerLeadId ? triggerLeadId : ''}`
        : `AMO_${rule}:${hasTriggerLeadId ? triggerLeadId : ''}`;

    await this.prisma.client.update({
      where: { id: client.id },
      data: {
        uniquenessStatus,
        uniquenessReason,
        uniquenessExpiresAt: isRule1
          ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
          : null,
        ...(hasTriggerLeadId ? { amoLeadId: BigInt(triggerLeadId) } : {}),
        amoSyncStatus: 'SYNCED' as any,
        amoSyncError: null,
        amoSyncAttempts: { increment: 1 },
        amoSyncLastAttemptAt: new Date(),
      } as any,
    });

    try {
      await this.prisma.auditLog.create({
        data: {
          userId: String(client.brokerId || client.broker?.id || 'system'),
          action: 'AMO_RETRY_UNIQUENESS_RESOLVED',
          entity: 'Client',
          entityId: String(client.id),
          payload: {
            scenario: 'REFIX_AMO_DOWN',
            rule,
            triggerLeadId: hasTriggerLeadId ? triggerLeadId : null,
            uniquenessStatus,
          },
        },
      });
    } catch {
      this.logger.error('[amo-retry] failed to audit uniqueness resolution');
    }

    return true;
  }

  // 2026-06-16: отключён. Раньше каждые 3 мин синкали responsible_user_id
  // лида с самой свежей задачи — но при каждой новой ALARM-задаче (от
  // повторных фиксаций / handleRule1Or2Alarm / прикрепления брокеров)
  // ответственный лида менялся, чего не хотелось. Морикит сам ставит
  // responsible при создании лида/задачи. Если кто-то меняет вручную в
  // amo — оставляем его выбор.

  // 2026-05-27 ROBUST AMO #2: periodic health-check. Каждые 5 минут дёргает
  // /account amocrm. Если упал — пишет в audit + один раз шлёт Telegram
  // менеджерам (защита от спама через AmoHealthState).
  private amoHealthState: { lastOk: boolean | null; lastErrorAt: number } = {
    lastOk: null,
    lastErrorAt: 0,
  };

  @Cron('*/5 * * * *')
  async handleAmoHealthCheck() {
    if (!hasConfiguredAmoCredentials()) {
      if (this.amoHealthState.lastOk !== false) {
        this.amoHealthState.lastOk = false;
        this.amoHealthState.lastErrorAt = Date.now();
      }
      await this.alertAmoTokenMissing();
      return;
    }
    try {
      await this.amo.getAccount();
      // On the first healthy check after deploy, and after an observed outage,
      // safely reopen auth-only dead letters that exhausted their attempts.
      if (this.amoHealthState.lastOk !== true) {
        const wasDown = this.amoHealthState.lastOk === false;
        const requeued = await requeueAmoAuthDeadLetters(
          this.prisma,
          wasDown ? 'health-recovery' : 'startup-health-check',
        );
        this.logger.log(
          `amo health: ${wasDown ? 'восстановился' : 'подключение подтверждено'}; requeued=${requeued}`,
        );
        this.amoHealthState.lastOk = true;
        if (wasDown) {
          await this.sendOpsAlert(
            '🟢 PROD: amoCRM снова доступен\nПроверка подключения прошла успешно; безопасные auth-ошибки возвращены в очередь.',
            'scheduler:amo:recovered',
          );
        }
      }
    } catch (e: any) {
      const error = String(e?.message || e).slice(0, 200);
      const errorCategory = this.safeOpsErrorCategory(error);
      if (this.amoHealthState.lastOk !== false) {
        // Был жив — стал мёртв. Первая фиксация падения.
        this.logger.error(`amo health: упал — ${errorCategory}`);
        this.amoHealthState.lastOk = false;
        this.amoHealthState.lastErrorAt = Date.now();
        await this.alertAmoDown(error);
      } else {
        // Уже падал — спамить не будем. Но раз в час напоминаем.
        if (Date.now() - this.amoHealthState.lastErrorAt > 60 * 60 * 1000) {
          await this.alertAmoDown(error);
          this.amoHealthState.lastErrorAt = Date.now();
        }
      }
    }
  }

  private async alertAmoTokenDead(error: string) {
    await this.sendOpsAlert(
      '🔴 PROD: токен amoCRM недействителен\namoCRM отклонил авторизацию; требуется обновить токен.',
      'scheduler:amo:token-dead',
    );
    // 2026-08-19: раньше здесь ещё рассылались персональные TELEGRAM-нотификации
    // всем MANAGER без проверки telegramChatId — sendOpsAlert выше уже покрывает
    // доставку, а у менеджеров без привязанного чата это создавало вечный retry
    // в очереди Bull (см. code-review PR #288).
    try {
      await this.prisma.auditLog.create({
        data: {
          action: 'AMO_TOKEN_DEAD',
          entity: 'System',
          entityId: 'amo',
          payload: { error: this.safeOpsErrorCategory(error), at: new Date().toISOString() },
        },
      });
    } catch {
      console.error('[alertAmoTokenDead] failed');
    }
  }

  private async alertAmoDown(error: string) {
    await this.sendOpsAlert(
      '🔴 PROD: amoCRM недоступен\nПроверка подключения завершилась ошибкой. Фиксации сохраняются локально и будут повторены автоматически.',
      'scheduler:amo:down',
    );
    try {
      await this.prisma.auditLog.create({
        data: {
          action: 'AMO_DOWN',
          entity: 'System',
          entityId: 'amo',
          payload: { error: this.safeOpsErrorCategory(error), at: new Date().toISOString() },
        },
      });
    } catch {
      console.error('[alertAmoDown] failed');
    }
  }

  // 2026-06-18: SMTP health-check каждые 5 мин (был кейс — auth провалился,
  // forgot-password и welcome-email тихо не уходили несколько часов).
  // nodemailer.verify() делает connect + EHLO + AUTH без отправки —
  // ловим и connection-fail, и auth-fail. Первый раз — лог-error + Telegram
  // менеджерам; повтор — раз в час.
  private smtpHealthState: { lastOk: boolean; lastErrorAt: number } = { lastOk: true, lastErrorAt: 0 };

  @Cron('*/5 * * * *')
  async handleSmtpHealthCheck() {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER) return;
    let nodemailer: any;
    try { nodemailer = require('nodemailer'); } catch { return; }
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: process.env.SMTP_SECURE !== 'false',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      tls: { rejectUnauthorized: false },
    });
    try {
      await transporter.verify();
      if (!this.smtpHealthState.lastOk) {
        this.logger.log('smtp health: восстановился ✓');
        this.smtpHealthState.lastOk = true;
        await this.sendOpsAlert(
          '🟢 PROD: SMTP снова доступен\nПроверка почтового транспорта прошла успешно.',
          'scheduler:smtp:recovered',
        );
      }
    } catch (e: any) {
      const error = String(e?.message || e).slice(0, 200);
      const errorCategory = this.safeOpsErrorCategory(error);
      if (this.smtpHealthState.lastOk) {
        this.logger.error(`smtp health: упал — ${errorCategory}`);
        this.smtpHealthState.lastOk = false;
        this.smtpHealthState.lastErrorAt = Date.now();
        await this.alertSmtpDown(error);
      } else if (Date.now() - this.smtpHealthState.lastErrorAt > 60 * 60 * 1000) {
        await this.alertSmtpDown(error);
        this.smtpHealthState.lastErrorAt = Date.now();
      }
    } finally {
      try { transporter.close?.(); } catch {}
    }
  }

  private async alertSmtpDown(error: string) {
    await this.sendOpsAlert(
      '🔴 PROD: SMTP недоступен\nПроверка почтового транспорта завершилась ошибкой. Системные письма временно не отправляются.',
      'scheduler:smtp:down',
    );
    try {
      await this.prisma.auditLog.create({
        data: {
          action: 'SMTP_DOWN',
          entity: 'System',
          entityId: 'smtp',
          payload: { error: this.safeOpsErrorCategory(error), at: new Date().toISOString() },
        },
      });
    } catch {
      console.error('[alertSmtpDown] failed');
    }
  }

  private async alertAmoTokenMissing(): Promise<void> {
    await this.sendOpsAlert(
      '🔴 PROD: amoCRM не настроен\nAMO_ACCESS_TOKEN отсутствует. Автосинхронизация и повторная отправка фиксаций остановлены.',
      'scheduler:amo:token-missing',
    );
  }

  private async sendOpsAlert(message: string, dedupKey: string): Promise<void> {
    try {
      await this.opsAlerts?.sendSafely(message, {
        dedupKey,
        cooldownMs: OPS_ALERT_COOLDOWN_MS,
      });
    } catch {
      // Operations alerting must never interrupt scheduler work.
      this.logger.error('[scheduler] direct operations alert delivery failed');
    }
  }

  private safeOpsErrorCategory(error: unknown): string {
    const message = String(error || '').toLowerCase();
    if (message.includes('401') || message.includes('unauthorized') || message.includes('auth')) {
      return 'authorization_failed';
    }
    if (message.includes('timeout') || message.includes('timed out') || message.includes('etimedout')) {
      return 'timeout';
    }
    if (message.includes('enotfound') || message.includes('dns')) return 'dns_failed';
    if (message.includes('econn') || message.includes('network') || message.includes('fetch')) {
      return 'connection_failed';
    }
    return 'unknown';
  }

  // 2026-08-12: ежедневный синк новостей с stmichael.ru → LandingNews.
  // Логика парсинга живёт в CmsService.syncNewsFromStm (единый источник правды).
  @Cron('0 8 * * *')
  async handleStmNewsSync() {
    this.logger.log('[stm-news] синкаю новости с stmichael.ru...');
    try {
      const result = await this.cms.syncNewsFromStm();
      this.logger.log(`[stm-news] done: created=${result.created} updated=${result.updated} total=${result.total}`);
    } catch (e: any) {
      this.logger.error(`[stm-news] failed: ${e?.message || e}`);
    }
  }
}
