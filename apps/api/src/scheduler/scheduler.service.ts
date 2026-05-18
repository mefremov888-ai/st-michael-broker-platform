import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaClient, UniquenessStatus } from '@st-michael/database';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { AmoCrmAdapter, AMO_CONTACT_FIELDS, AMO_LEAD_FIELDS, getLeadCustomFieldNumber, getLeadCustomFieldValue, pipelineToProject, leadToProject, statusToDealStatus, isDealStage, mapMeetingStatus, BROKER_PIPELINE_ID } from '@st-michael/integrations';
import { CatalogService } from '../catalog/catalog.service';
import { levelForSqm, rateFor, rateForWithPolicy } from '../commission/commission.service';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly amo = new AmoCrmAdapter();

  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    @InjectQueue('notifications') private notificationQueue: Queue,
    private readonly catalogService: CatalogService,
  ) {}

  // Yandex.Disk materials sync — каждые 12 часов (06:00 и 18:00).
  // Тянет публичную папку с материалами для брокеров и обновляет Document таблицу.
  @Cron('0 6,18 * * *')
  async handleYandexDiskSync() {
    const publicKey = process.env.YANDEX_DISK_PUBLIC_KEY;
    if (!publicKey) {
      this.logger.warn('YANDEX_DISK_PUBLIC_KEY не настроен — пропускаю синк материалов');
      return;
    }
    this.logger.log('Yandex.Disk materials sync started...');
    try {
      const { spawnSync } = require('child_process');
      const path = require('path');
      const scriptPath = path.resolve(__dirname, '../../../../scripts/sync-yandex-disk.js');
      const result = spawnSync('node', [scriptPath], {
        env: { ...process.env, YANDEX_DISK_PUBLIC_KEY: publicKey },
        encoding: 'utf-8',
        timeout: 5 * 60 * 1000,
      });
      if (result.stdout) this.logger.log(result.stdout.trim());
      if (result.stderr) this.logger.error(result.stderr.trim());
    } catch (e) {
      this.logger.error(`Yandex.Disk sync failed: ${e}`);
    }
  }

  // Daily catalog XML feed sync at 03:00
  @Cron('0 3 * * *')
  async handleCatalogSync() {
    this.logger.log('Starting daily Profitbase XML feed sync...');
    try {
      const result = await this.catalogService.syncFromFeed();
      this.logger.log(`Catalog sync complete: +${result.created}, ~${result.updated}, total ${result.total}`);
    } catch (e) {
      this.logger.error(`Catalog sync failed: ${e}`);
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
    if (!process.env.AMO_ACCESS_TOKEN) return;

    this.logger.log('Starting amoCRM sync for all linked brokers...');

    const brokers = await this.prisma.broker.findMany({
      where: { amoContactId: { not: null }, status: 'ACTIVE' },
      select: { id: true, fullName: true, phone: true, amoContactId: true },
    });

    let totalDeals = 0;
    let totalClients = 0;

    for (const broker of brokers) {
      try {
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
            if (lead.status_id === 143) continue;
            if (!isDealStage(lead.status_id)) continue;

            const project = leadToProject(lead);
            const status = statusToDealStatus(lead.status_id);

            // Find client contact in lead
            const leadContacts = lead?._embedded?.contacts || [];
            const clientRef = leadContacts.find((c: any) => c.id !== contactId) || leadContacts[0];

            let fullName = lead.name || 'Без имени';
            let phone = `+70000${leadRef.id}`;
            let email: string | null = null;

            if (clientRef) {
              const cc: any = await this.amo.getContact(clientRef.id);
              if (cc) {
                fullName = cc.name || fullName;
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

            // Upsert client
            let client = await this.prisma.client.findFirst({ where: { phone, brokerId: broker.id } });
            if (!client) {
              client = await this.prisma.client.create({
                data: {
                  brokerId: broker.id, fullName, phone, email,
                  project: project as any,
                  amoLeadId: BigInt(lead.id),
                  uniquenessStatus: UniquenessStatus.CONDITIONALLY_UNIQUE,
                  uniquenessExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                },
              });
              totalClients++;
            }

            // Извлекаем sqm/price из custom_fields. Правка 2026-05-12 — раньше sqm=0
            // и amount=lead.price (без учёта скидок). Теперь приоритет custom-полям.
            const sqm = getLeadCustomFieldNumber(lead, AMO_LEAD_FIELDS.SQM);
            const priceNoDiscount = getLeadCustomFieldNumber(lead, AMO_LEAD_FIELDS.PRICE_NO_DISCOUNT);
            const amount = priceNoDiscount > 0 ? priceNoDiscount : Number(lead.price || 0);
            const ccIdParent = getLeadCustomFieldValue(lead, AMO_LEAD_FIELDS.CC_ID_PARENT);

            const ba = await this.prisma.brokerAgency.findFirst({
              where: { brokerId: broker.id, isPrimary: true },
              include: { agency: true },
            });
            const totalSqm = Number(ba?.agency?.totalSqmSold || 0);
            // Правка 2026-05-13: ставка через активную политику комиссии.
            const dealDate = lead.created_at ? new Date(lead.created_at * 1000) : new Date();
            const policyResult = await rateForWithPolicy(this.prisma, project, totalSqm, dealDate);
            const rate = policyResult.rate;
            const lvl = policyResult.level || levelForSqm(project, totalSqm);
            const commAmt = Math.round(amount * rate / 100);

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
            if (existing) {
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
            } else {
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
                    await this.prisma.meeting.create({
                      data: {
                        brokerId: broker.id, clientId: client.id,
                        type: mType as any, status: mStatus as any,
                        date: mDate,
                        comment: rawType ? `Тип из amoCRM: ${rawType}` : null,
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
}
