import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import * as XLSX from 'xlsx';
import { AmocrmService } from '../amocrm/amocrm.service';
import {
  AmoCrmAdapter,
  MangoAdapter,
  AMO_CONTACT_FIELDS,
  BROKER_PIPELINE_ID,
  setAmoTokens,
  getAmoTokens,
  setMangoConfig,
  isSalesPipeline,
  normalizeMangoApiUrl,
  normalizeMangoCallbackUrl,
} from '@st-michael/integrations';
import {
  VALID_CATEGORIES,
  VALID_CALL_FLAGS,
  parseAndFilter,
  mapCoordRow,
  normalizePhone,
  buildPhoneSearchConditions,
  type BrokerCategoryCode,
  type Candidate,
} from './brokers-import.helper';
import { BrokerImportJobsService } from './broker-import-jobs.service';
import {
  DEFAULT_PAYMENT_TERMS,
  paymentTermsForPolicy,
} from '../commission/commission.service';
import { normalizeMangoEmployeeNum } from './mango-employee-num';
import { PUBLIC_CALL_SELECT } from '../common/public-call';
import { MangoCallSafetyService } from '../common/mango-call-safety.service';
import type { BrokerCallResultCode } from './admin-mango.dto';
import {
  AMO_UNIQUENESS_RECHECK_MARKER,
  publicAmoSyncError,
  requeueAmoAuthDeadLetters,
} from '../common/amo-sync-retry';

const SAFE_BROKER_MUTATION_SELECT = {
  id: true,
  fullName: true,
  phone: true,
  email: true,
  role: true,
  status: true,
  updatedAt: true,
} as const;

interface MailingFilters {
  project?: string;        // ZORGE9 / SILVER_BOR
  agencyId?: string;
  commissionLevel?: string;
  funnelStage?: string;
  status?: string;
  role?: string;
}

@Injectable()
export class AdminService {
  private amo = new AmoCrmAdapter();
  private mango = new MangoAdapter();

  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    private amocrmService: AmocrmService,
    @InjectQueue('notifications') private notificationQueue: Queue,
    private importJobs: BrokerImportJobsService,
    private mangoCallSafety: MangoCallSafetyService,
  ) {}

  getUniquenessControl(_query: any) {
    return { items: [], total: 0 };
  }

  recheckUniquenessControl(_clientId: string, _actorId: string) {
    return { ok: false, message: 'Not available' };
  }

  // ─── Mailings (broadcasts) ─────────────────────────────────

  private async resolveRecipients(filters: MailingFilters) {
    const where: any = {};

    if (filters.status) where.status = filters.status;
    else where.status = { not: 'BLOCKED' };

    if (filters.role) where.role = filters.role;
    if (filters.funnelStage) where.funnelStage = filters.funnelStage;

    // Agency / commissionLevel filters apply via brokerAgencies join
    if (filters.agencyId || filters.commissionLevel) {
      where.brokerAgencies = {
        some: {
          ...(filters.agencyId ? { agencyId: filters.agencyId } : {}),
          ...(filters.commissionLevel
            ? { agency: { commissionLevel: filters.commissionLevel as any } }
            : {}),
        },
      };
    }

    // Project filter — broker has at least one client/deal in that project
    if (filters.project) {
      where.OR = [
        { clients: { some: { project: filters.project as any } } },
        { deals: { some: { project: filters.project as any } } },
      ];
    }

    return this.prisma.broker.findMany({
      where,
      select: { id: true, fullName: true, phone: true, email: true, telegramChatId: true },
    });
  }

  async previewMailing(filters: MailingFilters) {
    const recipients = await this.resolveRecipients(filters);
    return {
      count: recipients.length,
      sample: recipients.slice(0, 10).map((r) => ({ id: r.id, fullName: r.fullName, phone: r.phone })),
    };
  }

  async sendMailing(
    createdById: string,
    data: { subject?: string; body: string; channels: string[]; filters: MailingFilters },
  ) {
    if (!data.body || !data.body.trim()) throw new BadRequestException('body required');
    if (!Array.isArray(data.channels) || data.channels.length === 0) {
      throw new BadRequestException('channels required');
    }

    // 2026-07-02: работают только Email + Push. SMS/Telegram убраны из UI.
    const validChannels = new Set(['EMAIL', 'PUSH']);
    const channels = data.channels.filter((c) => validChannels.has(c));
    if (channels.length === 0) throw new BadRequestException('No valid channels');

    const recipients = await this.resolveRecipients(data.filters || {});

    let queued = 0;
    for (const r of recipients) {
      for (const channel of channels) {
        await this.notificationQueue.add('send', {
          brokerId: r.id,
          channel,
          subject: data.subject,
          body: data.body,
          eventType: 'ANNOUNCEMENTS',
          data: channel === 'PUSH' ? { url: '/', tag: `mailing-${Date.now()}` } : undefined,
        });
        queued++;
      }
    }

    const mailing = await this.prisma.mailing.create({
      data: {
        createdById,
        subject: data.subject || null,
        body: data.body,
        channels: channels as any,
        filters: (data.filters || {}) as any,
        recipientsCount: recipients.length,
      },
    });

    return { mailing, queued, recipientsCount: recipients.length };
  }

  async listMailings(query: { page?: number; limit?: number }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      this.prisma.mailing.findMany({
        orderBy: { sentAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.mailing.count(),
    ]);

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ─── Meetings (admin-wide management) ───────────────────────

  async listAllMeetings(query: { page?: number; limit?: number; status?: string; from?: string; to?: string; brokerId?: string }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.status) where.status = query.status;
    if (query.brokerId) where.brokerId = query.brokerId;
    if (query.from || query.to) {
      where.date = {};
      if (query.from) where.date.gte = new Date(query.from);
      if (query.to) where.date.lte = new Date(query.to);
    }

    const [meetings, total] = await Promise.all([
      this.prisma.meeting.findMany({
        where,
        include: {
          client: { select: { id: true, fullName: true, phone: true } },
          broker: { select: { id: true, fullName: true, phone: true } },
        },
        orderBy: { date: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.meeting.count({ where }),
    ]);

    return { meetings, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async updateMeetingStatus(id: string, status: 'PENDING' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED', managerId: string) {
    const meeting = await this.prisma.meeting.findUnique({ where: { id } });
    if (!meeting) throw new NotFoundException('Meeting not found');

    const updated = await this.prisma.meeting.update({
      where: { id },
      data: { status: status as any, managerId },
    });

    // Notify broker about status change
    const subject = status === 'CONFIRMED' ? 'Встреча подтверждена'
      : status === 'CANCELLED' ? 'Встреча отменена'
      : 'Статус встречи обновлён';
    const dateStr = new Date(meeting.date).toLocaleString('ru-RU', {
      day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit',
    });
    const body = `${subject}: ${dateStr}.`;

    await this.notificationQueue.add('send', {
      brokerId: meeting.brokerId,
      channel: 'PUSH',
      subject,
      body,
      eventType: 'BOOKING_CONFIRMED',
      data: { url: '/meetings', tag: `meeting-${meeting.id}` },
    });
    await this.notificationQueue.add('send', {
      brokerId: meeting.brokerId,
      channel: 'EMAIL',
      subject,
      body,
      eventType: 'BOOKING_CONFIRMED',
    });

    return updated;
  }

  async listBrokers(query: { page?: number; limit?: number; search?: string; role?: string; status?: string; isCoordinator?: string; specialization?: 'COMM' | 'RESIDENTIAL' | 'BOTH' | 'REGIONAL' | 'UNSET' | string; category?: string; contact?: string }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const skip = (page - 1) * limit;

    // 2026-07-17: слитые дубли скрываем и из общего списка брокеров.
    const where: any = { mergedIntoId: null };
    if (query.search) {
      // 2026-06-29: phone-поиск теперь нормализует входной формат.
      // "8925..." и "+7925..." и "79255724188" — все находят брокера
      // с phone="+79255724188" в БД.
      where.OR = [
        { fullName: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
        ...buildPhoneSearchConditions(query.search),
      ];
    }
    if (query.role) where.role = query.role;
    if (query.status) where.status = query.status;
    // 2026-06-29: фильтр по координаторам — string 'true'/'false' из query.
    if (query.isCoordinator === 'true') where.isCoordinator = true;
    if (query.isCoordinator === 'false') where.isCoordinator = false;
    // 2026-07-06: фильтр по специализации (COMM/RESIDENTIAL/BOTH).
    // 'UNSET' — брокеры без указанной специализации (null).
    // 2026-07-09: 'REGIONAL' — региональный брокер (isRegional=true). Не
    // тип недвижимости, но живёт в том же селекте UI для удобства.
    if (query.specialization === 'REGIONAL') where.isRegional = true;
    else if (query.specialization === 'UNSET') where.specialization = null;
    else if (query.specialization && ['COMM', 'RESIDENTIAL', 'BOTH'].includes(query.specialization)) {
      where.specialization = query.specialization;
    }
    // 2026-07-06: фильтр по BrokerCategory (COLD/WARM/HOT/…) — используется
    // на странице колл-центра.
    if (query.category && ['COLD', 'WARM', 'HOT', 'CONVERTED', 'ON_BOT_REVIEW', 'BLACKLIST'].includes(query.category)) {
      where.category = query.category;
    }
    // 2026-07-23: контакты из TG-чатов без телефона хранятся с
    // phone='tg:<ник>' (телефон обязателен и уникален в схеме).
    // TG_ONLY — показать только их; WITH_PHONE — скрыть их из списка.
    if (query.contact === 'TG_ONLY') where.phone = { startsWith: 'tg:' };
    else if (query.contact === 'WITH_PHONE') where.phone = { not: { startsWith: 'tg:' } };

    const [brokers, total] = await Promise.all([
      this.prisma.broker.findMany({
        where,
        select: {
          id: true,
          fullName: true,
          phone: true,
          email: true,
          role: true,
          status: true,
          funnelStage: true,
          source: true,
          amoContactId: true,
          // 2026-06-29: возвращаем isCoordinator для отображения в списке.
          isCoordinator: true,
          // 2026-07-06: возвращаем specialization и category — колонка в UI.
          specialization: true,
          category: true,
          // 2026-07-09: региональный признак — покажется бейджем в списке.
          isRegional: true,
          createdAt: true,
          _count: { select: { clients: true, deals: true, meetings: true, offerAcceptances: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.broker.count({ where }),
    ]);

    return { brokers, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getBroker(id: string, includeMangoEmployeeNum = false) {
    const select: any = {
      id: true,
      amoContactId: true,
      fullName: true,
      phone: true,
      email: true,
      avatarUrl: true,
      role: true,
      status: true,
      funnelStage: true,
      source: true,
      closureReason: true,
      brokerTourVisited: true,
      brokerTourDate: true,
      doNotCall: true,
      bestCallTime: true,
      category: true,
      specialization: true,
      region: true,
      isRegional: true,
      isCoordinator: true,
      coordinatorAgency: true,
      lastCallAt: true,
      nextCallAt: true,
      isInBase: true,
      baseSource: true,
      assignedManagerId: true,
      assignedAt: true,
      createdAt: true,
      updatedAt: true,
      reactivatedAt: true,
      mergedIntoId: true,
      brokerAgencies: { include: { agency: true } },
      _count: { select: { clients: true, deals: true, meetings: true, callLogs: true } },
      callLogs: {
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true, result: true, comment: true, campaign: true,
          duration: true, createdAt: true, nextCallAt: true, operatorId: true,
        },
      },
      offerAcceptances: {
        orderBy: { acceptedAt: 'desc' },
        select: {
          id: true, offerVersion: true, acceptedAt: true, ip: true, signedPdfUrl: true,
        },
      },
    };
    if (includeMangoEmployeeNum) select.mangoEmployeeNum = true;
    const broker = await this.prisma.broker.findUnique({
      where: { id },
      select,
    });
    if (!broker) throw new NotFoundException('Broker not found');
    return broker;
  }

  async updateBroker(id: string, data: any) {
    const allowed: any = {};
    if (data.fullName !== undefined) allowed.fullName = data.fullName;
    if (data.email !== undefined) allowed.email = data.email || null;
    if (data.phone !== undefined) allowed.phone = data.phone;
    if (data.brokerTourVisited !== undefined) allowed.brokerTourVisited = data.brokerTourVisited;
    if (data.doNotCall !== undefined) allowed.doNotCall = data.doNotCall;
    if (data.bestCallTime !== undefined) allowed.bestCallTime = data.bestCallTime;

    const updated = await this.prisma.broker.update({
      where: { id },
      data: allowed,
      select: SAFE_BROKER_MUTATION_SELECT,
    });
    return updated;
  }

  async updateBrokerMangoEmployeeNum(
    id: string,
    value: unknown,
    actorId: string,
  ) {
    const mangoEmployeeNum = normalizeMangoEmployeeNum(value);
    const broker = await this.prisma.broker.findUnique({
      where: { id },
      select: { id: true, fullName: true, role: true, mangoEmployeeNum: true },
    });
    if (!broker) throw new NotFoundException('Broker not found');

    if (mangoEmployeeNum && !['MANAGER', 'ADMIN'].includes(String(broker.role))) {
      throw new BadRequestException(
        'Внутренний номер Mango можно назначить только сотруднику с ролью MANAGER или ADMIN',
      );
    }

    if (mangoEmployeeNum) {
      const conflict = await this.prisma.broker.findFirst({
        where: {
          mangoEmployeeNum,
          id: { not: id },
        },
        select: { id: true, fullName: true },
      });
      if (conflict) {
        throw new ConflictException(
          'Внутренний номер Mango уже назначен другому сотруднику',
        );
      }
    }

    if (broker.mangoEmployeeNum === mangoEmployeeNum) {
      return {
        id: broker.id,
        fullName: broker.fullName,
        mangoEmployeeNum: broker.mangoEmployeeNum,
      };
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.broker.update({
          where: { id },
          data: { mangoEmployeeNum },
          select: { id: true, fullName: true, mangoEmployeeNum: true },
        });
        await tx.auditLog.create({
          data: {
            userId: actorId,
            action: 'BROKER_MANGO_EMPLOYEE_NUM_UPDATED',
            entity: 'Broker',
            entityId: id,
            // Internal extensions are operational identifiers. The audit only
            // records the state transition, not the value itself.
            payload: { cleared: mangoEmployeeNum === null },
          },
        });
        return updated;
      });
    } catch (error: any) {
      const target = error?.meta?.target;
      const targets = Array.isArray(target) ? target.map(String) : [String(target || '')];
      if (
        error?.code === 'P2002'
        && targets.some((item) =>
          item === 'mangoEmployeeNum'
          || item === 'mango_employee_num'
          || item.includes('brokers_mango_employee_num_key'),
        )
      ) {
        // The database constraint is authoritative. The pre-check above only
        // improves UX and cannot prevent two concurrent assignments.
        throw new ConflictException(
          'Внутренний номер Mango уже назначен другому сотруднику',
        );
      }
      throw error;
    }
  }

  async changeRole(id: string, role: 'BROKER' | 'MANAGER' | 'ADMIN') {
    const broker = await this.prisma.broker.findUnique({
      where: { id },
      select: { status: true, passwordHash: true },
    });
    if (!broker) throw new NotFoundException('Broker not found');
    if (
      role !== 'BROKER'
      && (broker.status !== 'ACTIVE' || !broker.passwordHash)
    ) {
      throw new BadRequestException(
        'Сначала пользователь должен активировать аккаунт и установить пароль',
      );
    }
    return this.prisma.broker.update({
      where: { id },
      data: { role: role as any },
      select: SAFE_BROKER_MUTATION_SELECT,
    });
  }

  async changeStatus(id: string, status: 'ACTIVE' | 'BLOCKED' | 'PENDING') {
    // 2026-07-10: если возвращаем аккаунт в ACTIVE из закрытого/заблокированного,
    // ставим reactivatedAt — этот факт выводится на /admin/broker-applications,
    // вкладка «Заходы».
    const current = await this.prisma.broker.findUnique({
      where: { id },
      select: { status: true },
    });
    const wasClosed = current && current.status !== 'ACTIVE';
    const data: any = { status };
    if (status === 'ACTIVE' && wasClosed) data.reactivatedAt = new Date();
    return this.prisma.broker.update({
      where: { id },
      data,
      select: SAFE_BROKER_MUTATION_SELECT,
    });
  }

  async brokerDeals(brokerId: string, query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const skip = (page - 1) * limit;

    const [deals, total] = await Promise.all([
      this.prisma.deal.findMany({
        where: { brokerId },
        include: {
          client: { select: { fullName: true, phone: true } },
          lot: { select: { number: true, building: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.deal.count({ where: { brokerId } }),
    ]);

    return { deals, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async brokerClients(brokerId: string, query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const skip = (page - 1) * limit;

    const [clients, total] = await Promise.all([
      this.prisma.client.findMany({
        where: { brokerId },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.client.count({ where: { brokerId } }),
    ]);

    return { clients, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async brokerMeetings(brokerId: string, query: any) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const skip = (page - 1) * limit;

    const [meetings, total] = await Promise.all([
      this.prisma.meeting.findMany({
        where: { brokerId },
        include: { client: { select: { fullName: true, phone: true } } },
        skip,
        take: limit,
        orderBy: { date: 'desc' },
      }),
      this.prisma.meeting.count({ where: { brokerId } }),
    ]);

    return { meetings, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async syncBrokerAmo(brokerId: string) {
    return this.amocrmService.syncMyDealsAndClients(brokerId);
  }

  async deleteBroker(id: string) {
    const broker = await this.prisma.broker.findUnique({ where: { id } });
    if (!broker) throw new NotFoundException('Broker not found');

    // Cascade delete related data manually (Prisma does not cascade by default)
    await this.prisma.meeting.deleteMany({ where: { brokerId: id } });
    await this.prisma.deal.deleteMany({ where: { brokerId: id } });
    await this.prisma.client.deleteMany({ where: { brokerId: id } });
    await this.prisma.brokerAgency.deleteMany({ where: { brokerId: id } });
    await this.prisma.notification.deleteMany({ where: { brokerId: id } }).catch(() => {});
    await this.prisma.broker.delete({ where: { id } });

    return { deleted: true, broker: broker.fullName };
  }

  /**
   * Bulk import brokers from amoCRM "Воронка брокеров" (pipeline 10787390).
   * Each lead in this pipeline represents a broker. Their main contact = broker contact.
   */
  async importBrokersFromAmo() {
    if (!process.env.AMO_ACCESS_TOKEN) {
      throw new BadRequestException('AMO_ACCESS_TOKEN не настроен');
    }

    const leads = await this.amo.getLeadsByPipeline(BROKER_PIPELINE_ID, 250);
    if (leads.length === 0) {
      return { found: 0, created: 0, updated: 0, skipped: 0, message: 'Нет лидов в воронке брокеров' };
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];

    // Collect unique broker contact IDs from leads
    const brokerContactIds = new Set<number>();
    for (const lead of leads) {
      const contacts = (lead as any)?._embedded?.contacts || [];
      // Skip closed-not-realized leads
      if (lead.status_id === 143) continue;
      // Take main contact (or first if no main)
      const mainContact = contacts.find((c: any) => c.is_main) || contacts[0];
      if (mainContact?.id) brokerContactIds.add(Number(mainContact.id));
    }

    for (const contactId of brokerContactIds) {
      try {
        const contact: any = await this.amo.getContact(contactId);
        if (!contact) { skipped++; continue; }

        // Check if contact has Брокер flag = true
        const fields = contact.custom_fields_values || [];
        const brokerField = fields.find((f: any) => f.field_id === AMO_CONTACT_FIELDS.IS_BROKER);
        if (brokerField?.values?.[0]?.value !== true) { skipped++; continue; }

        // Extract phone
        const phoneField = fields.find((f: any) => f.field_id === AMO_CONTACT_FIELDS.PHONE);
        let phone = phoneField?.values?.[0]?.value || '';
        phone = String(phone).replace(/[\s\-()'"]/g, '');
        if (phone.startsWith('8') && phone.length === 11) phone = '+7' + phone.slice(1);
        if (phone && !phone.startsWith('+')) phone = '+' + phone;
        if (!phone) {
          errors.push(`Contact ${contactId} (${contact.name}) — нет телефона`);
          skipped++;
          continue;
        }

        // Extract email
        const emailField = fields.find((f: any) => f.field_id === AMO_CONTACT_FIELDS.EMAIL);
        const email = emailField?.values?.[0]?.value || null;

        // Extract INN and agency name
        const innField = fields.find((f: any) => f.field_id === AMO_CONTACT_FIELDS.INN);
        const inn = innField?.values?.[0]?.value || null;
        const agencyField = fields.find((f: any) => f.field_id === AMO_CONTACT_FIELDS.AGENCY_NAME);
        const agencyName = agencyField?.values?.[0]?.value || null;

        // Upsert broker by phone
        const existing = await this.prisma.broker.findUnique({ where: { phone } });
        if (existing) {
          // 2026-06-18: НЕ перетираем fullName и email брокера данными из amoCRM —
          // внутри amo администраторы любят дописывать к имени служебные пометки
          // («Савицкий Владимир (теперь Антон)»), которые брокеру в кабинете
          // показывать нельзя. Заполняем эти поля ТОЛЬКО если в нашей БД пусто.
          await this.prisma.broker.update({
            where: { id: existing.id },
            data: {
              ...(existing.fullName ? {} : { fullName: contact.name || 'Без имени' }),
              ...(existing.email ? {} : email ? { email } : {}),
              amoContactId: BigInt(contactId),
            },
          });
          updated++;
        } else {
          const newBroker = await this.prisma.broker.create({
            data: {
              phone,
              fullName: contact.name || 'Без имени',
              email,
              amoContactId: BigInt(contactId),
              role: 'BROKER',
              status: 'PENDING', // нет пароля — пусть установит через "Забыли пароль?"
              source: 'CRM_MANUAL' as any,
            },
          });
          created++;

          // Link to agency if INN present
          if (inn) {
            let agency = await this.prisma.agency.findUnique({ where: { inn } });
            if (!agency) {
              agency = await this.prisma.agency.create({
                data: { name: agencyName || `Агентство ${inn}`, inn },
              });
            }
            await this.prisma.brokerAgency.create({
              data: { brokerId: newBroker.id, agencyId: agency.id, isPrimary: true },
            });
          }
        }

        // 2026-07-06: если у брокера в amo есть ИНН — привязываем его
        // контакт к Компании в amoCRM (поле «Компания» в карточке контакта).
        // Ищем/создаём Company по ИНН, потом linkContactToCompany.
        // amo не любит повторный link, но кидает 400 — заворачиваем в catch.
        if (inn) {
          try {
            let amoCompanyId: number | null = null;
            const existingCompany = await this.amo.findCompanyByInn(inn);
            if (existingCompany?.id) {
              amoCompanyId = Number(existingCompany.id);
            } else {
              const createdCompany = await this.amo.createCompany({
                name: agencyName || `Агентство ${inn}`,
              });
              if (createdCompany?.id) amoCompanyId = Number(createdCompany.id);
            }
            if (amoCompanyId) {
              await this.amo
                .linkContactToCompany(Number(contactId), amoCompanyId)
                .catch(() => { /* уже связаны — не критично */ });
            }
          } catch (e: any) {
            errors.push(`Contact ${contactId} company link: ${e?.message || e}`);
          }
        }
      } catch (e: any) {
        errors.push(`Contact ${contactId}: ${e.message || e}`);
        skipped++;
      }
    }

    return {
      foundLeads: leads.length,
      uniqueContacts: brokerContactIds.size,
      created,
      updated,
      skipped,
      errors: errors.slice(0, 10),
    };
  }

  // ─── Commission Policies CRUD (правка 2026-05-13) ──────────────────

  async listCommissionPolicies(query: any) {
    const where: any = {};
    if (query.project) where.project = query.project;
    if (query.isActive !== undefined) where.isActive = query.isActive === 'true' || query.isActive === true;
    const [policies, commissionContent] = await Promise.all([
      this.prisma.commissionPolicy.findMany({
        where,
        orderBy: [{ project: 'asc' }, { startDate: 'desc' }],
      }),
      this.prisma.siteContent.findUnique({ where: { key: 'commission' } }),
    ]);
    const legacyCmsValue = (commissionContent?.value || {}) as any;
    return policies.map((policy) => ({
      ...policy,
      ...paymentTermsForPolicy(policy, policy.project, legacyCmsValue),
      paymentSettingsSource:
        policy.installmentEnabled != null
        && policy.installmentDiscount != null
        && policy.subsidizedMortgageEnabled != null
        && policy.subsidizedMortgageRate != null
          ? 'POLICY'
          : 'LEGACY_CMS',
    }));
  }

  async createCommissionPolicy(body: any) {
    const {
      project,
      mode,
      flatRate,
      levels,
      installmentEnabled,
      installmentDiscount,
      subsidizedMortgageEnabled,
      subsidizedMortgageRate,
      displayNote,
      startDate,
      endDate,
      isActive,
      notes,
    } = body;
    if (!project || !mode || !startDate || !endDate) {
      throw new BadRequestException('project, mode, startDate, endDate обязательны');
    }
    if (mode === 'FLAT' && (flatRate == null || isNaN(Number(flatRate)))) {
      throw new BadRequestException('Для mode=FLAT нужен flatRate');
    }
    if (mode === 'PROGRESSIVE' && (!Array.isArray(levels) || levels.length === 0)) {
      throw new BadRequestException('Для mode=PROGRESSIVE нужен массив levels');
    }
    this.validateCommissionPolicyValues({
      mode,
      flatRate,
      levels,
      installmentDiscount: installmentDiscount ?? DEFAULT_PAYMENT_TERMS.installmentDiscount,
      subsidizedMortgageRate: subsidizedMortgageRate ?? DEFAULT_PAYMENT_TERMS.subsidizedMortgageRate,
    });
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (start >= end) throw new BadRequestException('startDate должна быть раньше endDate');
    // Проверка пересечения с другими активными политиками этого же project.
    const overlap = isActive === false
      ? null
      : await this.prisma.commissionPolicy.findFirst({
          where: {
            project,
            isActive: true,
            startDate: { lte: end },
            endDate: { gte: start },
          },
        });
    if (overlap) {
      throw new BadRequestException(
        `Период пересекается с активной политикой ${overlap.id} (${overlap.startDate.toISOString().slice(0, 10)} — ${overlap.endDate.toISOString().slice(0, 10)})`,
      );
    }
    return this.prisma.commissionPolicy.create({
      data: {
        project,
        mode,
        flatRate: mode === 'FLAT' ? Number(flatRate) : null,
        levels: mode === 'PROGRESSIVE' ? levels : null,
        installmentEnabled: installmentEnabled !== false,
        installmentDiscount: Number(installmentDiscount ?? DEFAULT_PAYMENT_TERMS.installmentDiscount),
        subsidizedMortgageEnabled: subsidizedMortgageEnabled !== false,
        subsidizedMortgageRate: Number(subsidizedMortgageRate ?? DEFAULT_PAYMENT_TERMS.subsidizedMortgageRate),
        displayNote: displayNote?.trim() || null,
        startDate: start,
        endDate: end,
        isActive: isActive !== false,
        notes: notes || null,
      },
    });
  }

  async updateCommissionPolicy(id: string, body: any) {
    const existing = await this.prisma.commissionPolicy.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Policy not found');
    const newStart = body.startDate ? new Date(body.startDate) : existing.startDate;
    const newEnd = body.endDate ? new Date(body.endDate) : existing.endDate;
    if (newStart >= newEnd) throw new BadRequestException('startDate должна быть раньше endDate');
    const project = body.project || existing.project;
    const willBeActive = body.isActive ?? existing.isActive;
    const overlap = !willBeActive
      ? null
      : await this.prisma.commissionPolicy.findFirst({
          where: {
            id: { not: id },
            project,
            isActive: true,
            startDate: { lte: newEnd },
            endDate: { gte: newStart },
          },
        });
    if (overlap) {
      throw new BadRequestException(`Период пересекается с активной политикой ${overlap.id}`);
    }
    const effectiveMode = body.mode || existing.mode;
    this.validateCommissionPolicyValues({
      mode: effectiveMode,
      flatRate: body.flatRate !== undefined ? body.flatRate : existing.flatRate,
      levels: body.levels !== undefined ? body.levels : existing.levels,
      installmentDiscount: body.installmentDiscount !== undefined
        ? body.installmentDiscount
        : existing.installmentDiscount ?? DEFAULT_PAYMENT_TERMS.installmentDiscount,
      subsidizedMortgageRate: body.subsidizedMortgageRate !== undefined
        ? body.subsidizedMortgageRate
        : existing.subsidizedMortgageRate ?? DEFAULT_PAYMENT_TERMS.subsidizedMortgageRate,
    });
    const data: any = {};
    if (body.project) data.project = body.project;
    if (body.mode) data.mode = body.mode;
    if (body.flatRate !== undefined) data.flatRate = body.flatRate != null ? Number(body.flatRate) : null;
    if (body.levels !== undefined) data.levels = body.levels;
    if (body.installmentEnabled !== undefined) data.installmentEnabled = !!body.installmentEnabled;
    if (body.installmentDiscount !== undefined) data.installmentDiscount = Number(body.installmentDiscount);
    if (body.subsidizedMortgageEnabled !== undefined) data.subsidizedMortgageEnabled = !!body.subsidizedMortgageEnabled;
    if (body.subsidizedMortgageRate !== undefined) data.subsidizedMortgageRate = Number(body.subsidizedMortgageRate);
    if (body.displayNote !== undefined) data.displayNote = body.displayNote?.trim() || null;
    if (body.startDate) data.startDate = newStart;
    if (body.endDate) data.endDate = newEnd;
    if (body.isActive !== undefined) data.isActive = body.isActive;
    if (body.notes !== undefined) data.notes = body.notes;
    return this.prisma.commissionPolicy.update({ where: { id }, data });
  }

  private validateCommissionPolicyValues(values: {
    mode: string;
    flatRate: any;
    levels: any;
    installmentDiscount: any;
    subsidizedMortgageRate: any;
  }) {
    const percent = (value: any, label: string) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
        throw new BadRequestException(`${label} должен быть числом от 0 до 100`);
      }
    };

    if (values.mode === 'FLAT') percent(values.flatRate, 'Ставка');
    if (values.mode === 'PROGRESSIVE') {
      if (!Array.isArray(values.levels) || values.levels.length === 0) {
        throw new BadRequestException('Для mode=PROGRESSIVE нужен массив levels');
      }
      for (const level of values.levels) {
        const minSqm = Number(level?.minSqm);
        if (!level?.level || !Number.isFinite(minSqm) || minSqm < 0) {
          throw new BadRequestException('Каждый уровень должен содержать level и minSqm ≥ 0');
        }
        percent(level?.rate, `Ставка уровня ${level.level}`);
      }
    }
    percent(values.installmentDiscount, 'Скидка при рассрочке');
    percent(values.subsidizedMortgageRate, 'Ставка субсидированной ипотеки');
  }

  async deleteCommissionPolicy(id: string) {
    const existing = await this.prisma.commissionPolicy.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Policy not found');
    await this.prisma.commissionPolicy.delete({ where: { id } });
    return { deleted: true };
  }
  // ─── Reassign client to another broker (manager/admin) ────
  // Правка 2026-05-14: руководитель брокеров (Ксения) может перевыставить уникальность
  // клиента на другого брокера. Связанные Deal/Meeting тоже переезжают. В amoCRM меняется
  // responsible_user_id у лида. Обоим брокерам — уведомление.
  async reassignClient(
    clientId: string,
    newBrokerId: string,
    reason: string,
    executorId: string,
  ) {
    if (!reason || reason.trim().length < 3) {
      throw new BadRequestException('Reason required (min 3 chars)');
    }

    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      include: { broker: { select: { id: true, fullName: true, phone: true } } },
    });
    if (!client) throw new NotFoundException('Client not found');

    const newBroker = await this.prisma.broker.findUnique({
      where: { id: newBrokerId },
      select: { id: true, fullName: true, phone: true, status: true },
    });
    if (!newBroker) throw new NotFoundException('New broker not found');
    if (newBroker.status === 'BLOCKED') throw new BadRequestException('New broker is BLOCKED');
    if (newBroker.id === client.brokerId) throw new BadRequestException('Client is already with this broker');

    const oldBroker = client.broker;

    // Найти amoUserId нового брокера (по телефону среди amoCRM users).
    let newAmoUserId: number | null = null;
    if (client.amoLeadId) {
      try {
        const users = await this.amo.getUsers();
        const cleanPhone = newBroker.phone.replace(/\D/g, '').slice(-10);
        const matched = users.find((u: any) => {
          const uPhone = String(u.phone || '').replace(/\D/g, '');
          return uPhone && uPhone.endsWith(cleanPhone);
        });
        if (matched) newAmoUserId = matched.id;
      } catch {}
    }

    // Транзакция: меняем владельца Client + связанных Deal + Meeting.
    await this.prisma.$transaction(async (tx) => {
      await tx.client.update({
        where: { id: clientId },
        data: {
          brokerId: newBrokerId,
          uniquenessReason: `Передан от ${oldBroker.fullName} (${oldBroker.phone}). Причина: ${reason}`,
        },
      });
      await tx.deal.updateMany({
        where: { clientId },
        data: { brokerId: newBrokerId },
      });
      await tx.meeting.updateMany({
        where: { clientId },
        data: { brokerId: newBrokerId },
      });
    });

    // Обновление в amoCRM (если есть линк к лиду + нашли amoUserId).
    // 2026-06-15: воронки продаж broker-platform не трогает. Если лид
    // клиента уже в sales pipeline (Зорге9/Берзарина/Толбухина) — не
    // меняем ответственного, этим занимается админ продаж вручную.
    let amoUpdated = false;
    if (client.amoLeadId && newAmoUserId) {
      try {
        const fullLead = await this.amo.getLead(Number(client.amoLeadId)).catch(() => null);
        const pipelineId = Number((fullLead as any)?.pipeline_id || 0);
        if (pipelineId && isSalesPipeline(pipelineId)) {
          console.log(`[reassignClient] лид ${client.amoLeadId} в sales-pipeline ${pipelineId} — не трогаем responsible_user_id`);
        } else {
          await this.amo.updateLead(Number(client.amoLeadId), { responsible_user_id: newAmoUserId } as any);
          amoUpdated = true;
        }
      } catch (e) {
        // Логируем, но не валим всю операцию (в нашей БД уже передано).
      }
    }

    // Уведомления.
    const newBrokerMsg = `Вам передан клиент ${client.fullName} (${client.phone}). Уникальность подтверждена. Причина передачи: ${reason}`;
    const oldBrokerMsg = `Клиент ${client.fullName} (${client.phone}) передан брокеру ${newBroker.fullName} по решению руководителя. Причина: ${reason}`;

    // Каналы из database NotificationChannel — поддерживаются TELEGRAM/SMS/EMAIL/PUSH/IN_APP.
    // Шлём через очередь — она пишет в notifications table и пытается отправить через канал.
    await this.notificationQueue.add('send', {
      brokerId: newBrokerId,
      channel: 'PUSH',
      subject: 'Передан клиент',
      body: newBrokerMsg,
      eventType: 'CLIENT_REASSIGNED_TO',
    });
    await this.notificationQueue.add('send', {
      brokerId: oldBroker.id,
      channel: 'PUSH',
      subject: 'Передача клиента',
      body: oldBrokerMsg,
      eventType: 'CLIENT_REASSIGNED_FROM',
    });

    // Audit log.
    await this.prisma.auditLog.create({
      data: {
        userId: executorId,
        action: 'CLIENT_REASSIGNED',
        entity: 'Client',
        entityId: clientId,
        payload: {
          oldBrokerId: oldBroker.id,
          oldBrokerName: oldBroker.fullName,
          newBrokerId,
          newBrokerName: newBroker.fullName,
          reason,
          amoUpdated,
          amoLeadId: client.amoLeadId ? String(client.amoLeadId) : null,
        },
      },
    });

    return {
      success: true,
      amoUpdated,
      newBroker: { id: newBroker.id, fullName: newBroker.fullName },
      oldBroker: { id: oldBroker.id, fullName: oldBroker.fullName },
    };
  }

  // 2026-06-19: пометить/снять флаг координатора у брокера.
  async setBrokerCoordinator(brokerId: string, isCoordinator: boolean) {
    const exists = await this.prisma.broker.findUnique({ where: { id: brokerId } });
    if (!exists) throw new NotFoundException('Broker not found');
    return this.prisma.broker.update({
      where: { id: brokerId },
      data: { isCoordinator },
      select: { id: true, fullName: true, isCoordinator: true },
    });
  }

  // ─── Ручная смена uniquenessStatus клиента (admin only, критические случаи) ──
  // 2026-06-17: бывает что webhook / amoCRM-логика не довела клиента до правильного
  // статуса (баг, race condition, ручная правка в amo). Админ из кабинета может
  // выставить любой статус с обязательной причиной — она пишется в uniquenessReason
  // и в auditLog.
  async setClientUniquenessStatus(
    clientId: string,
    newStatus: 'CONDITIONALLY_UNIQUE' | 'UNDER_REVIEW' | 'REJECTED',
    reason: string,
    executorId: string,
  ) {
    if (!reason || reason.trim().length < 3) {
      throw new BadRequestException('Нужна причина (минимум 3 символа)');
    }
    if (!['CONDITIONALLY_UNIQUE', 'UNDER_REVIEW', 'REJECTED'].includes(newStatus)) {
      throw new BadRequestException(`Неверный статус: ${newStatus}`);
    }
    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      select: { id: true, uniquenessStatus: true, brokerId: true, fullName: true, phone: true },
    });
    if (!client) throw new NotFoundException('Client not found');

    const oldStatus = client.uniquenessStatus;
    const UNIQUENESS_DAYS = 30;
    const data: any = {
      uniquenessStatus: newStatus,
      uniquenessReason: `[Ручная правка админом] ${reason.trim()} (было: ${oldStatus})`,
    };
    if (newStatus === 'CONDITIONALLY_UNIQUE') {
      data.uniquenessExpiresAt = new Date(Date.now() + UNIQUENESS_DAYS * 86400 * 1000);
    } else if (newStatus === 'REJECTED') {
      data.uniquenessExpiresAt = null;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.client.update({ where: { id: clientId }, data });
      await tx.auditLog.create({
        data: {
          userId: executorId,
          action: 'CLIENT_UNIQUENESS_STATUS_MANUAL_CHANGE',
          entity: 'Client',
          entityId: clientId,
          payload: { oldStatus, newStatus, reason: reason.trim(), clientName: client.fullName, phone: client.phone },
        } as any,
      });
    });
    return { success: true, clientId, oldStatus, newStatus };
  }

  // ─── Аналитика покрытия: что в amoCRM, чего нет в нашей базе ────────
  // Dry-run: не пишет в БД, только сравнивает телефоны. Идёт в фоне,
  // потому что обход 5000+ контактов в амо по одному GET-запросу долгий.

  startAmoCoverageAnalysis() {
    if (!process.env.AMO_ACCESS_TOKEN) {
      throw new BadRequestException('AMO_ACCESS_TOKEN не настроен на сервере');
    }
    const job = this.importJobs.create();
    void this.runAmoCoverage(job.id);
    return { jobId: job.id, status: 'queued' };
  }

  private async runAmoCoverage(jobId: string) {
    try {
      this.importJobs.update(jobId, { status: 'running', step: 'parsing' });

      const leads = await this.amo.getLeadsByPipeline(BROKER_PIPELINE_ID, 250);

      // 1) Уникальные contactId из активных лидов (исключаем status_id=143 — closed-not-realized)
      const contactIds = new Set<number>();
      for (const lead of leads) {
        if (lead.status_id === 143) continue;
        const contacts = (lead as any)?._embedded?.contacts || [];
        const main = contacts.find((c: any) => c.is_main) || contacts[0];
        if (main?.id) contactIds.add(Number(main.id));
      }

      this.importJobs.setProgress(jobId, 0, contactIds.size, 'writing-brokers');

      // КБ6 fix #44 (2026-05-25): тянем контакты ПАЧКАМИ по 250
      // (раньше — по одному, что давало ~5000 запросов и сотни 429-ошибок).
      // С bulk-методом получается ~20 запросов и ноль (или близко) ошибок.
      const amoPhones = new Set<string>();
      const amoByPhone = new Map<string, { name: string; amoContactId: number }>();
      let notBrokerFlag = 0;
      let invalidPhone = 0;
      let amoErrors = 0;

      const idsList = Array.from(contactIds);
      const BATCH = 250;
      let processed = 0;
      for (let b = 0; b < idsList.length; b += BATCH) {
        const chunk = idsList.slice(b, b + BATCH);
        const got = await this.amo.getContactsByIds(chunk);
        for (const contactId of chunk) {
          const contact: any = got.get(Number(contactId));
          if (!contact) { amoErrors++; continue; }
          const fields = contact.custom_fields_values || [];
          const brokerField = fields.find((f: any) => f.field_id === AMO_CONTACT_FIELDS.IS_BROKER);
          if (brokerField?.values?.[0]?.value !== true) { notBrokerFlag++; continue; }
          const phoneField = fields.find((f: any) => f.field_id === AMO_CONTACT_FIELDS.PHONE);
          const raw = phoneField?.values?.[0]?.value || '';
          const norm = normalizePhone(raw);
          if (!norm.ok || !norm.phone) { invalidPhone++; continue; }
          amoPhones.add(norm.phone);
          if (!amoByPhone.has(norm.phone)) {
            amoByPhone.set(norm.phone, { name: contact.name || '—', amoContactId: contactId });
          }
        }
        processed += chunk.length;
        this.importJobs.setProgress(jobId, processed, contactIds.size, 'writing-brokers');
      }

      // 3) Все телефоны брокеров в БД
      const dbBrokers = await this.prisma.broker.findMany({
        select: { phone: true, fullName: true, isInBase: true, category: true },
      });
      const dbPhones = new Set(dbBrokers.map((b) => b.phone));

      // 4) Расчёт
      let inAmoNotInDb = 0;
      let inBoth = 0;
      const examplesAmoOnly: Array<{ name: string; phone: string; amoContactId: number }> = [];
      for (const phone of amoPhones) {
        if (dbPhones.has(phone)) {
          inBoth++;
        } else {
          inAmoNotInDb++;
          if (examplesAmoOnly.length < 50) {
            const info = amoByPhone.get(phone)!;
            examplesAmoOnly.push({ name: info.name, phone, amoContactId: info.amoContactId });
          }
        }
      }

      const dbBaseOnly = dbBrokers.filter((b) => b.isInBase && !amoPhones.has(b.phone));

      this.importJobs.finish(jobId, {
        totalLeadsInAmo: leads.length,
        uniqueContactsInAmo: contactIds.size,
        notBrokerFlag,
        invalidPhone,
        amoErrors,
        uniquePhonesInAmo: amoPhones.size,
        totalBrokersInDb: dbBrokers.length,
        brokersInDbBase: dbBrokers.filter((b) => b.isInBase).length,
        inAmoNotInDb,
        inBoth,
        inDbBaseNotInAmo: dbBaseOnly.length,
        examplesAmoOnly,
      });
    } catch (e: any) {
      this.importJobs.fail(jobId, e?.message || String(e));
    }
  }

  // ─── Колл-центр (TZ v3 §5) ──────────────────────────────────────────
  // Очередь обзвона: брокеры из базы КЦ (isInBase=true), которым можно звонить
  // (doNotCall=false), отсортированные по приоритету:
  //   1) сначала те у кого nextCallAt задан (от ближайшего к далёкому)
  //   2) потом те у кого nextCallAt=null — по дате добавления (новых наверх)

  async getCallCenterQueue(query: {
    page?: string | number;
    limit?: string | number;
    category?: string;
    search?: string;
    includeAll?: string | boolean;
    coordinators?: 'only' | 'exclude' | '' | string;
    // 2026-06-03: фильтр назначения. 'mine' — только мои (managerId=currentUserId),
    // 'unassigned' — без назначения, 'all' (или пусто) — все. Если 'mine' — нужен
    // currentUserId (передаётся через параметр).
    assignment?: 'mine' | 'unassigned' | 'all' | string;
    currentUserId?: string;
    currentUserRole?: string;
    // 2026-07-06: фильтр по специализации — чтобы КЦ мог собрать очередь
    // только коммерческих брокеров (или наоборот только жилой сегмент).
    specialization?: 'COMM' | 'RESIDENTIAL' | 'BOTH' | 'REGIONAL' | 'UNSET' | string;
  }) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Number(query.limit) || 30);
    const skip = (page - 1) * limit;

    // 2026-07-17: слитые дубли (mergedIntoId) в очередь не попадают никогда.
    const where: any = { isInBase: true, mergedIntoId: null };
    if (query.includeAll !== 'true' && query.includeAll !== true) {
      where.doNotCall = false;
    }
    if (query.category) {
      const cats = String(query.category).split(',').map((s) => s.trim()).filter(Boolean);
      if (cats.length > 0) where.category = { in: cats as any };
    }
    // A5 fix 2026-05-24: фильтр координаторов — 752 шт из импорта были
    // смешаны в общей очереди. Параметры:
    //   coordinators=only   → только координаторы (isCoordinator=true)
    //   coordinators=exclude → только обычные брокеры (isCoordinator=false)
    //   (пусто или any)     → все
    if (query.coordinators === 'only') {
      where.isCoordinator = true;
    } else if (query.coordinators === 'exclude') {
      where.isCoordinator = false;
    }
    // 2026-06-03: фильтр распределения по менеджерам КЦ.
    if (query.currentUserRole === 'MANAGER' && query.currentUserId) {
      // Server-side ownership is authoritative. A manager cannot widen the
      // queue with assignment=all/unassigned or by calling the API directly.
      where.assignedManagerId = query.currentUserId;
    } else if (query.assignment === 'mine' && query.currentUserId) {
      where.assignedManagerId = query.currentUserId;
    } else if (query.assignment === 'unassigned') {
      where.assignedManagerId = null;
    }
    // 'all' / пусто — никакого фильтра по assignedManagerId не накладываем.
    // 2026-07-06: специализация. UNSET — брокеры без указанной специализации.
    // 2026-07-09: REGIONAL — региональный признак, живёт в том же селекте.
    if (query.specialization === 'REGIONAL') where.isRegional = true;
    else if (query.specialization === 'UNSET') where.specialization = null;
    else if (query.specialization && ['COMM', 'RESIDENTIAL', 'BOTH'].includes(String(query.specialization))) {
      where.specialization = query.specialization;
    }
    // Bug fix 2026-05-22 (#3): не показывать оператору брокеров с
    // запланированным звонком в будущем (например +7 дней).
    // Условие OR: либо никогда не звонили (nextCallAt = null), либо
    // время подошло (nextCallAt <= now). Если search активен — он перепишет
    // where.OR, поэтому ставим nextCallFilter в where через AND.
    const nextCallFilter = { OR: [{ nextCallAt: null }, { nextCallAt: { lte: new Date() } }] };
    if (query.search) {
      const s = String(query.search).trim();
      where.AND = [
        nextCallFilter,
        { OR: [
          { fullName: { contains: s, mode: 'insensitive' } },
          { coordinatorAgency: { contains: s, mode: 'insensitive' } },
          // 2026-06-29: нормализация при поиске по телефону (как в /admin/brokers).
          ...buildPhoneSearchConditions(s),
        ] },
      ];
    } else {
      Object.assign(where, nextCallFilter);
    }

    const [brokers, total] = await Promise.all([
      this.prisma.broker.findMany({
        where,
        select: {
          id: true,
          fullName: true,
          phone: true,
          category: true,
          doNotCall: true,
          isCoordinator: true,
          coordinatorAgency: true,
          lastCallAt: true,
          nextCallAt: true,
          baseSource: true,
          createdAt: true,
          assignedManagerId: true,
          assignedAt: true,
          assignedManager: { select: { id: true, fullName: true } },
          callLogs: {
            select: { id: true, result: true, comment: true, campaign: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 3,
          },
        },
        orderBy: [{ nextCallAt: 'asc' }, { createdAt: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.broker.count({ where }),
    ]);

    return {
      brokers,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // 2026-06-03: распределение брокеров на менеджеров КЦ. Руководитель КЦ
  // выбирает чекбоксами несколько брокеров и батч-назначает на менеджера.
  // Менеджер КЦ дефолтным фильтром видит только своих в очереди обзвона.

  async listKcManagers() {
    const managers = await this.prisma.broker.findMany({
      where: { role: 'MANAGER' as any },
      select: {
        id: true,
        fullName: true,
        kcTeam: true,
        _count: { select: { assignedBrokers: true } },
      },
      // 2026-07-22: Штат выше Аутсорса, внутри группы — по алфавиту.
      orderBy: [{ kcTeam: 'asc' }, { fullName: 'asc' }],
    });
    return managers.map((m: any) => ({
      id: m.id,
      fullName: m.fullName,
      kcTeam: m.kcTeam || null,
      assignedCount: m._count?.assignedBrokers || 0,
    }));
  }

  // 2026-07: issue #2 — менеджер КЦ звонит брокеру одной кнопкой через Mango.
  // Mango callback: сначала звонит менеджеру на его внутренний номер
  // (mangoEmployeeNum), тот берёт трубку → Mango дозванивается до брокера и
  // соединяет. Запись Call создаётся сразу (status INITIATED, clientId=null —
  // клиента в этой паре нет). Итог допишет webhook /webhooks/mango/call-result.
  async mangoCallBroker(
    managerId: string,
    brokerId: string,
    actorRole: string,
    idempotencyKey?: string,
  ) {
    return this.mangoCallSafety.execute(
      { actorId: managerId, scope: 'broker', targetId: brokerId, idempotencyKey },
      async () => {
        const manager = await this.prisma.broker.findUnique({ where: { id: managerId } });
        if (!manager) throw new NotFoundException('Менеджер не найден');
        if (!manager.mangoEmployeeNum) {
          throw new BadRequestException(
            'У вас не заполнен внутренний номер Mango (mangoEmployeeNum) — обратитесь к администратору',
          );
        }

        const broker = await this.prisma.broker.findUnique({ where: { id: brokerId } });
        if (!broker) throw new NotFoundException('Брокер не найден');
        if (actorRole !== 'ADMIN' && broker.assignedManagerId !== managerId) {
          throw new ForbiddenException('Брокер не назначен текущему оператору');
        }
        if (broker.doNotCall) {
          throw new BadRequestException('Брокер в списке «не звонить» (doNotCall)');
        }
        if (!broker.phone) {
          throw new BadRequestException('У брокера не указан телефон');
        }

        const r = await this.mango.initiateCallbackFromExtension({
          extension: manager.mangoEmployeeNum,
          to: broker.phone,
        });

        const call = await this.prisma.call.create({
          data: {
            brokerId: broker.id,
            clientId: null,
            mangoCallId: r.callId,
            direction: 'OUTBOUND',
            status: 'INITIATED' as any,
            attemptNumber: 1,
            cycleDay: 0,
          },
        });

        return {
          callId: call.id,
          mangoCallId: r.callId,
          message: 'Mango сейчас позвонит вам на рабочий телефон — возьмите трубку, соединим с брокером.',
        };
      },
    );
  }
  async assignBrokersToManager(brokerIds: string[], managerId: string) {
    if (!brokerIds.length) throw new BadRequestException('Не выбрано ни одного брокера');
    const manager = await this.prisma.broker.findUnique({
      where: { id: managerId },
      select: { id: true, role: true, fullName: true },
    });
    if (!manager) throw new NotFoundException('Менеджер не найден');
    if (manager.role !== 'MANAGER' && manager.role !== 'ADMIN') {
      throw new BadRequestException('Можно назначать только на MANAGER или ADMIN');
    }
    const result = await this.prisma.broker.updateMany({
      where: { id: { in: brokerIds } },
      data: { assignedManagerId: managerId, assignedAt: new Date() },
    });
    return {
      assigned: result.count,
      managerId,
      managerName: manager.fullName,
    };
  }

  async unassignBrokers(brokerIds: string[]) {
    if (!brokerIds.length) throw new BadRequestException('Не выбрано ни одного брокера');
    const result = await this.prisma.broker.updateMany({
      where: { id: { in: brokerIds } },
      data: { assignedManagerId: null, assignedAt: null },
    });
    return { unassigned: result.count };
  }

  // Правила автообновления брокера по результату звонка.
  // Возвращает что менять; null означает «не трогать поле».
  private callResultEffects(result: string): {
    category: string | null;
    doNotCall: boolean | null;
    nextCallDays: number | null;
  } {
    switch (result) {
      case 'NDZ':                  return { category: 'COLD',          doNotCall: null,  nextCallDays: 3 };
      case 'HUNG_UP':              return { category: 'COLD',          doNotCall: null,  nextCallDays: 1 };
      case 'DOUBLE_NDZ':           return { category: 'ON_BOT_REVIEW', doNotCall: null,  nextCallDays: null };
      case 'IN_PROGRESS':          return { category: 'HOT',           doNotCall: null,  nextCallDays: 7 };
      case 'SCHEDULED_TOUR':       return { category: 'HOT',           doNotCall: null,  nextCallDays: null };
      case 'INFORMED':             return { category: 'WARM',          doNotCall: null,  nextCallDays: null };
      case 'ALREADY_KNOWS':        return { category: 'WARM',          doNotCall: null,  nextCallDays: null };
      case 'ONLY_SEND_INFO':       return { category: 'WARM',          doNotCall: null,  nextCallDays: null };
      case 'REFUSED_TOUR':         return { category: 'WARM',          doNotCall: null,  nextCallDays: null };
      case 'WRONG_NUMBER':         return { category: 'BLACKLIST',     doNotCall: true,  nextCallDays: null };
      case 'NOT_A_BROKER':         return { category: 'BLACKLIST',     doNotCall: true,  nextCallDays: null };
      case 'NOT_BROKER_ANYMORE':   return { category: 'BLACKLIST',     doNotCall: true,  nextCallDays: null };
      case 'REFUSED_COMMUNICATION':return { category: 'ON_BOT_REVIEW', doNotCall: true,  nextCallDays: null };
      case 'ASKED_NOT_TO_CALL':    return { category: 'ON_BOT_REVIEW', doNotCall: true,  nextCallDays: null };
      case 'NEGATIVE':             return { category: 'ON_BOT_REVIEW', doNotCall: true,  nextCallDays: null };
      case 'NOT_RELEVANT':         return { category: 'ON_BOT_REVIEW', doNotCall: null,  nextCallDays: null };
      default:                     return { category: null,            doNotCall: null,  nextCallDays: null };
    }
  }

  async logCall(
    operatorId: string,
    data: {
      brokerId: string;
      result: BrokerCallResultCode;
      comment?: string | null;
      campaign?: string | null;
      duration?: number | null;
      nextCallAtOverride?: string | null;
      doNotCallOverride?: boolean | null;
      // A4 fix 2026-05-24: дата брокер-тура когда result=SCHEDULED_TOUR
      brokerTourDate?: string | null;
    },
    operatorRole: string,
  ) {
    const broker = await this.prisma.broker.findUnique({ where: { id: data.brokerId } });
    if (!broker) throw new NotFoundException('Брокер не найден');
    if (operatorRole !== 'ADMIN' && broker.assignedManagerId !== operatorId) {
      throw new ForbiddenException('Брокер не назначен текущему оператору');
    }

    const effects = this.callResultEffects(data.result);

    // Расчёт nextCallAt: override > rule > null
    let nextCallAt: Date | null = null;
    if (data.nextCallAtOverride) {
      const d = new Date(data.nextCallAtOverride);
      if (!isNaN(d.getTime())) nextCallAt = d;
    } else if (effects.nextCallDays !== null) {
      nextCallAt = new Date(Date.now() + effects.nextCallDays * 24 * 60 * 60 * 1000);
    }

    // CONVERTED не сбрасываем — это факт встречи/сделки, выше любой категории.
    const categoryUpdate =
      broker.category === 'CONVERTED' || !effects.category
        ? undefined
        : (effects.category as any);

    // doNotCall: явный override > правило > не трогаем
    let doNotCallUpdate: boolean | undefined;
    if (data.doNotCallOverride !== null && data.doNotCallOverride !== undefined) {
      doNotCallUpdate = data.doNotCallOverride;
    } else if (effects.doNotCall === true) {
      doNotCallUpdate = true;
    }

    const callLog = await this.prisma.callLog.create({
      data: {
        brokerId: data.brokerId,
        operatorId,
        result: data.result as any,
        comment: data.comment || null,
        campaign: data.campaign || null,
        duration: data.duration ?? null,
        nextCallAt,
      },
    });

    // A4 fix 2026-05-24: при «Запись на БТ» обновляем broker.brokerTourDate
    // (раньше только category становилась HOT, дата терялась). Если оператор
    // передал brokerTourDate — записываем; иначе ставим now+7д как дефолт
    // (чтобы менеджер видел что брокер записан и нужно перенастроить).
    let brokerTourDate: Date | null | undefined;
    let brokerTourVisited: boolean | undefined;
    if (data.result === 'SCHEDULED_TOUR') {
      if (data.brokerTourDate) {
        const d = new Date(data.brokerTourDate);
        if (!isNaN(d.getTime())) brokerTourDate = d;
      } else {
        brokerTourDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      }
      brokerTourVisited = false; // записан, но не пришёл
    }

    const updated = await this.prisma.broker.update({
      where: { id: data.brokerId },
      data: {
        lastCallAt: new Date(),
        nextCallAt,
        ...(categoryUpdate ? { category: categoryUpdate } : {}),
        ...(doNotCallUpdate !== undefined ? { doNotCall: doNotCallUpdate } : {}),
        ...(brokerTourDate !== undefined ? { brokerTourDate } : {}),
        ...(brokerTourVisited !== undefined ? { brokerTourVisited } : {}),
      },
      select: { id: true, fullName: true, category: true, doNotCall: true, lastCallAt: true, nextCallAt: true, brokerTourDate: true, brokerTourVisited: true },
    });

    // Sync результата звонка в amoCRM (правка #5 аудита 2026-05-22):
    // если у брокера есть amoContactId — записываем note в его карточку
    // в amo. Менеджеры в amoCRM видят что КЦ работает с этим контактом.
    if (broker.amoContactId) {
      const resultLabel = data.result;
      const noteText = `Звонок КЦ: ${resultLabel}\n${data.campaign ? `Кампания: ${data.campaign}\n` : ''}${data.comment ? `Комментарий: ${data.comment}\n` : ''}Категория после звонка: ${categoryUpdate || broker.category}${doNotCallUpdate ? ' · Не звонить' : ''}${nextCallAt ? ` · Перезвонить: ${nextCallAt.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}` : ''}`;
      this.amo.addNoteToContact(Number(broker.amoContactId), noteText).catch((e) => {
        console.error('amoCRM addNoteToContact (logCall) failed:', e?.message || e);
      });
    }

    return { callLog, broker: updated };
  }

  // 2026-07-09: единая страница «Все заявки от брокеров».
  // Заменяет /admin/amo-failed (там был только Client с FAILED).
  // Показывает: Client (фиксации) + Meeting (встречи) + Call (звонки клиенту)
  // + OfferAcceptance (акцепты договоров) — по всем брокерам.
  // Доступ: MANAGER + ADMIN.
  //
  // Стратегия: 4 отдельных запроса (top-500 каждый), мержим в JS,
  // сортируем по дате, пагинируем в памяти. При росте числа заявок
  // (>10K в периоде) можно перейти на UNION в raw SQL или отдельный
  // индекс/view — сейчас достаточно.
  async getBrokerApplications(query: {
    page?: number;
    limit?: number;
    // Мультиселект: строки-CSV ("CLIENT,MEETING") или строки-массивы.
    // ALL / пусто = все типы (эквивалентно передаче всех).
    type?: string;
    amoStatus?: string;
    search?: string;
    startDate?: string;
    endDate?: string;
  }) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(200, Number(query.limit) || 50);
    const ALL_TYPES = ['CLIENT', 'MEETING', 'CALL', 'OFFER', 'LOGIN'] as const;
    const ALL_STATUSES = ['SYNCED', 'FAILED', 'PENDING'] as const;
    // Парсим CSV или одиночную строку. Пусто/ALL — берём все.
    const parseSet = (raw: string | undefined, fallback: readonly string[]): Set<string> => {
      if (!raw) return new Set(fallback);
      const parts = String(raw)
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      if (!parts.length || parts.includes('ALL')) return new Set(fallback);
      return new Set(parts);
    };
    const types = parseSet(query.type, ALL_TYPES);
    const amoStatuses = parseSet(query.amoStatus, ALL_STATUSES);
    // Если пользователь оставил все статусы — считаем, что фильтр «выключен»
    // (показываем и заявки без amo-статуса: встречи/звонки/акцепты/логины).
    const amoStatusFilterOn = amoStatuses.size < ALL_STATUSES.length;
    const search = (query.search || '').trim();
    const dateFilter: any = {};
    if (query.startDate) dateFilter.gte = new Date(query.startDate);
    if (query.endDate) dateFilter.lte = new Date(query.endDate);
    const hasDate = Object.keys(dateFilter).length > 0;

    const TOP_PER_TYPE = 500; // top-N по каждому типу до мержа

    // 1) Client (фиксации) — только тут есть amoSync
    const clientWhere: any = {};
    // 2026-07-17: дата заявки = amoCreatedAt (реальная дата лида в amo) для
    // клиентов, приехавших синком, иначе createdAt. Кейс Нины Карвосенои:
    // синк подтянул её лиды 2021-2023 гг, страница показала «сегодня 14:31»
    // на всех — менеджер продаж решил, что свалилась пачка новых заявок.
    if (hasDate) {
      clientWhere.AND = [
        { OR: [{ amoCreatedAt: dateFilter }, { amoCreatedAt: null, createdAt: dateFilter }] },
      ];
    }
    if (amoStatusFilterOn) clientWhere.amoSyncStatus = { in: Array.from(amoStatuses) };
    if (search) {
      clientWhere.OR = [
        { fullName: { contains: search, mode: 'insensitive' } },
        ...buildPhoneSearchConditions(search),
      ];
    }
    const wantClient = types.has('CLIENT');

    // 2) Meeting (встречи) — amoSync-статуса нет
    const meetingWhere: any = {};
    if (hasDate) meetingWhere.createdAt = dateFilter;
    if (search) {
      meetingWhere.client = { fullName: { contains: search, mode: 'insensitive' } };
    }
    const wantMeeting = types.has('MEETING');
    // Если включён фильтр по amoStatus — встречи не показываем (у них статуса нет).
    const showMeeting = wantMeeting && !amoStatusFilterOn;

    // 3) Call (звонки через Mango брокер→клиент) — amoSync-статуса нет
    const callWhere: any = { clientId: { not: null } }; // только звонки с клиентом
    if (hasDate) callWhere.createdAt = dateFilter;
    if (search) {
      callWhere.client = { fullName: { contains: search, mode: 'insensitive' } };
    }
    const wantCall = types.has('CALL');
    const showCall = wantCall && !amoStatusFilterOn;

    // 4) OfferAcceptance — акцепты договоров брокером (не клиентом)
    const offerWhere: any = {};
    if (hasDate) offerWhere.acceptedAt = dateFilter;
    if (search) {
      offerWhere.broker = { fullName: { contains: search, mode: 'insensitive' } };
    }
    const wantOffer = types.has('OFFER');
    const showOffer = wantOffer && !amoStatusFilterOn;

    // 5) Login — регистрации / реактивации аккаунтов брокеров. Одна строка на
    //    брокера: либо REGISTERED (createdAt), либо REACTIVATED (reactivatedAt)
    //    — что позже, то и берём. Бэйдж «без оферты» ставим отдельно.
    //
    // 2026-07-10: исключаем брокеров, попавших в БД через импорт.
    // 2026-07-17: фильтр baseSource==null дырявый в обе стороны — часть
    //    импортных записей имеет baseSource=null (показывались как ложные
    //    «Регистрации»), а импортный брокер, который ПОТОМ реально
    //    зарегистрировался, наоборот скрывался. Правильный признак
    //    регистрации — наличие пароля: аккаунт создал сам человек.
    const loginWhereOr: any[] = [];
    if (hasDate) {
      loginWhereOr.push({ createdAt: dateFilter });
      loginWhereOr.push({ reactivatedAt: dateFilter });
    }
    const loginWhere: any = { passwordHash: { not: null } };
    if (loginWhereOr.length) loginWhere.OR = loginWhereOr;
    if (search) {
      loginWhere.AND = [
        {
          OR: [
            { fullName: { contains: search, mode: 'insensitive' } },
            ...buildPhoneSearchConditions(search),
          ],
        },
      ];
    }
    const wantLogin = types.has('LOGIN');
    const showLogin = wantLogin && !amoStatusFilterOn;

    const [clients, meetings, calls, offers, logins] = await Promise.all([
      wantClient
        ? this.prisma.client.findMany({
            where: clientWhere,
            include: {
              broker: { select: { id: true, fullName: true, phone: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: TOP_PER_TYPE,
          })
        : Promise.resolve([]),
      showMeeting
        ? this.prisma.meeting.findMany({
            where: meetingWhere,
            include: {
              client: { select: { fullName: true, phone: true } },
              broker: { select: { id: true, fullName: true, phone: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: TOP_PER_TYPE,
          })
        : Promise.resolve([]),
      showCall
        ? this.prisma.call.findMany({
            where: callWhere,
            select: {
              ...PUBLIC_CALL_SELECT,
              client: { select: { fullName: true, phone: true } },
              broker: { select: { id: true, fullName: true, phone: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: TOP_PER_TYPE,
          })
        : Promise.resolve([]),
      showOffer
        ? this.prisma.offerAcceptance.findMany({
            where: offerWhere,
            include: {
              broker: { select: { id: true, fullName: true, phone: true } },
            },
            orderBy: { acceptedAt: 'desc' },
            take: TOP_PER_TYPE,
          })
        : Promise.resolve([]),
      showLogin
        ? this.prisma.broker.findMany({
            where: loginWhere,
            select: {
              id: true,
              fullName: true,
              phone: true,
              createdAt: true,
              reactivatedAt: true,
              baseSource: true,
              source: true,
              _count: { select: { offerAcceptances: true } },
              // Для импортных, зарегистрировавшихся позже: дата регистрации =
              // момент акцепта оферты (createdAt у них — дата импорта).
              offerAcceptances: {
                select: { acceptedAt: true },
                orderBy: { acceptedAt: 'desc' },
                take: 1,
              },
            },
            orderBy: { createdAt: 'desc' },
            take: TOP_PER_TYPE,
          })
        : Promise.resolve([]),
    ]);

    // Нормализуем к общей форме {type, id, personName, personPhone, date, broker, amoStatus, extra}
    type App = {
      type: 'CLIENT' | 'MEETING' | 'CALL' | 'OFFER' | 'LOGIN';
      id: string;
      personName: string;
      personPhone: string;
      date: Date;
      broker: { id: string; fullName: string; phone: string } | null;
      amoStatus: string | null;
      amoLeadId?: string | null;
      amoSyncError?: string | null;
      // Для LOGIN.subType: 'REGISTERED' | 'REACTIVATED', badges: ['NO_OFFER'] и т.п.
      extra?: any;
    };
    const items: App[] = [];
    for (const c of clients as any[]) {
      // Синк из amo создаёт Client пачкой — настоящая дата заявки в amoCreatedAt.
      const fromAmoSync = !!c.amoCreatedAt
        && new Date(c.createdAt).getTime() - new Date(c.amoCreatedAt).getTime() > 60 * 60 * 1000;
      items.push({
        type: 'CLIENT',
        id: c.id,
        personName: c.fullName || '—',
        personPhone: c.phone || '',
        date: c.amoCreatedAt || c.createdAt,
        broker: c.broker,
        amoStatus: c.amoSyncStatus || null,
        amoLeadId: c.amoLeadId ? String(c.amoLeadId) : null,
        // Never return a raw amo/WAF response. Legacy rows can contain HTML
        // and the original request URL may include the client's phone number.
        amoSyncError: publicAmoSyncError(c.amoSyncError),
        extra: { project: c.project, uniquenessStatus: c.uniquenessStatus, fromAmoSync },
      });
    }
    for (const m of meetings as any[]) {
      items.push({
        type: 'MEETING',
        id: m.id,
        personName: m.client?.fullName || '—',
        personPhone: m.client?.phone || '',
        date: m.createdAt,
        broker: m.broker,
        amoStatus: null,
        extra: { meetingType: m.type, meetingStatus: m.status, meetingDate: m.date },
      });
    }
    for (const cl of calls as any[]) {
      items.push({
        type: 'CALL',
        id: cl.id,
        personName: cl.client?.fullName || '—',
        personPhone: cl.client?.phone || '',
        date: cl.createdAt,
        broker: cl.broker,
        amoStatus: null,
        extra: { callStatus: cl.status, callResult: cl.result, durationSec: cl.durationSec },
      });
    }
    for (const o of offers as any[]) {
      items.push({
        type: 'OFFER',
        id: o.id,
        personName: o.broker?.fullName || '—', // акцепт — это про брокера, не клиента
        personPhone: o.broker?.phone || '',
        date: o.acceptedAt,
        broker: o.broker,
        amoStatus: null,
        extra: { offerVersion: o.offerVersion, ip: o.ip },
      });
    }
    for (const b of logins as any[]) {
      // Если у брокера есть reactivatedAt — это реактивация, дата = reactivatedAt.
      // Иначе — регистрация: createdAt, а для импортных (baseSource задан) —
      // дата акцепта оферты, потому что createdAt у них = дата импорта.
      const isReactivation = !!b.reactivatedAt;
      const noOffer = (b._count?.offerAcceptances || 0) === 0;
      const regDate = b.baseSource && b.offerAcceptances?.[0]?.acceptedAt
        ? b.offerAcceptances[0].acceptedAt
        : b.createdAt;
      items.push({
        type: 'LOGIN',
        id: b.id,
        personName: b.fullName || '—',
        personPhone: b.phone || '',
        date: isReactivation ? b.reactivatedAt : regDate,
        broker: { id: b.id, fullName: b.fullName, phone: b.phone },
        amoStatus: null,
        extra: {
          subType: isReactivation ? 'REACTIVATED' : 'REGISTERED',
          noOffer,
          source: (b as any).source || null,
          baseSource: (b as any).baseSource || null,
        },
      });
    }

    // Сортируем по дате (свежие сверху) и пагинируем.
    items.sort((a, b) => b.date.getTime() - a.date.getTime());
    const total = items.length;
    const skip = (page - 1) * limit;
    const pageItems = items.slice(skip, skip + limit);

    return {
      items: pageItems,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      // Служебная инфа для KPI-бара.
      countsByType: {
        CLIENT: items.filter((i) => i.type === 'CLIENT').length,
        MEETING: items.filter((i) => i.type === 'MEETING').length,
        CALL: items.filter((i) => i.type === 'CALL').length,
        OFFER: items.filter((i) => i.type === 'OFFER').length,
        LOGIN: items.filter((i) => i.type === 'LOGIN').length,
      },
      countsByAmoStatus: {
        SYNCED: items.filter((i) => i.amoStatus === 'SYNCED').length,
        FAILED: items.filter((i) => i.amoStatus === 'FAILED').length,
        PENDING: items.filter((i) => i.amoStatus === 'PENDING').length,
      },
    };
  }

  // Manual action only requeues the row. The scheduler owns the actual amo
  // state machine (uniqueness recheck, responsible broker, max attempts and
  // MoreKIT delivery). The old implementation duplicated only half of that
  // logic and returned HTTP 200 {ok:false}; the UI ignored the body and falsely
  // reported success.
  async retryAmoSync(clientId: string) {
    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      select: {
        id: true,
        amoLeadId: true,
        amoSyncStatus: true,
        amoSyncError: true,
      },
    });
    if (!client) throw new NotFoundException('Заявка не найдена');
    if (client.amoSyncStatus === 'SYNCED') {
      return { ok: true, queued: false, message: 'Заявка уже синхронизирована' };
    }
    if (client.amoSyncStatus === 'PENDING') {
      return { ok: true, queued: false, message: 'Заявка уже находится в очереди' };
    }
    if (client.amoLeadId) {
      throw new ConflictException(
        'У заявки уже записан идентификатор amoCRM; вместо повтора нужна сверка',
      );
    }

    const preserveUniquenessMarker = String(client.amoSyncError || '').startsWith(
      AMO_UNIQUENESS_RECHECK_MARKER,
    );
    const updated = await this.prisma.client.updateMany({
      where: {
        id: clientId,
        amoLeadId: null,
        amoSyncStatus: 'FAILED',
      },
      data: {
        amoSyncStatus: 'PENDING',
        amoSyncAttempts: 0,
        // Epoch is deterministic and sorts ahead of ordinary retry rows.
        amoSyncLastAttemptAt: new Date(0),
        amoSyncError: preserveUniquenessMarker ? client.amoSyncError : null,
      },
    });
    if (!updated.count) {
      return { ok: true, queued: false, message: 'Статус заявки уже изменился' };
    }
    return {
      ok: true,
      queued: true,
      message: 'Заявка возвращена в очередь amoCRM',
    };
  }

  // Bug fix 2026-05-25: диагностика статуса amoCRM.
  // Возвращает { ok, accountName?, error?, tokenConfigured }.
  // Используется UI чтобы быстро понять — отвалился токен/таймаут/rate-limit.
  // 2026-05-29: ручной триггер синка Я.Диска
  async triggerYandexSync() {
    const publicKey = process.env.YANDEX_DISK_PUBLIC_KEY;
    if (!publicKey) {
      return { ok: false, message: 'YANDEX_DISK_PUBLIC_KEY не настроен в .env' };
    }
    // Запускаем в фоне, сразу возвращаем "started"
    const { spawn } = require('child_process');
    const path = require('path');
    const scriptPath = path.resolve(__dirname, '../../../../scripts/sync-yandex-files.js');
    const child = spawn('node', [scriptPath], {
      env: { ...process.env, YANDEX_DISK_PUBLIC_KEY: publicKey },
      detached: true,
      stdio: 'inherit',
    });
    child.unref();
    return { ok: true, message: 'Синхронизация запущена в фоне. Лог в server stdout. Может занять 10-30 минут на первый прогон.' };
  }

  async checkAmoHealth() {
    const tokenConfigured = !!(getAmoTokens().access || process.env.AMO_ACCESS_TOKEN);
    if (!tokenConfigured) {
      return { ok: false, tokenConfigured: false, error: 'AMO_ACCESS_TOKEN не настроен' };
    }
    const started = Date.now();
    try {
      const acc = await this.amo.getAccount();
      return {
        ok: true,
        tokenConfigured: true,
        accountName: acc?.name || acc?.subdomain || null,
        accountId: acc?.id || null,
        latencyMs: Date.now() - started,
      };
    } catch (e: any) {
      return {
        ok: false,
        tokenConfigured: true,
        error: String(e?.message || e),
        latencyMs: Date.now() - started,
      };
    }
  }

  // A3 fix 2026-05-24: список клиентов с UNDER_REVIEW для UI менеджера.
  // Для каждого находим конкурирующего брокера по phone (старая запись)
  // и брокера-инициатора (текущий client.brokerId).
  async getUniquenessConflicts() {
    const conflicts = await this.prisma.client.findMany({
      where: { uniquenessStatus: 'UNDER_REVIEW' },
      include: {
        broker: { select: { id: true, fullName: true, phone: true } },
        deals: { select: { id: true, status: true, amount: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const enriched = await Promise.all(
      conflicts.map(async (c) => {
        // Конкурирующая запись клиента (другой брокер с тем же телефоном)
        const others = await this.prisma.client.findMany({
          where: { phone: c.phone, id: { not: c.id } },
          include: {
            broker: { select: { id: true, fullName: true, phone: true } },
            meetings: { select: { id: true, status: true, date: true } },
            deals: { select: { id: true, status: true, amount: true } },
          },
          orderBy: { createdAt: 'asc' },
        });
        return {
          conflictingClient: {
            id: c.id,
            fullName: c.fullName,
            phone: c.phone,
            project: c.project,
            uniquenessReason: c.uniquenessReason,
            createdAt: c.createdAt,
            broker: c.broker,
            dealsCount: c.deals.length,
          },
          existingClaims: others.map((o) => ({
            id: o.id,
            broker: o.broker,
            uniquenessStatus: o.uniquenessStatus,
            uniquenessExpiresAt: o.uniquenessExpiresAt,
            fixationStatus: o.fixationStatus,
            project: o.project,
            createdAt: o.createdAt,
            meetingsCount: o.meetings.length,
            dealsCount: o.deals.length,
            hasActiveDeal: o.deals.some((d) => ['PENDING', 'SIGNED', 'PAID'].includes(d.status as any)),
          })),
        };
      })
    );

    return enriched;
  }

  async getCallCenterStats(operatorId: string) {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [today, week, month, todayAll, queueWaiting, totalInBase] = await Promise.all([
      this.prisma.callLog.count({ where: { operatorId, createdAt: { gte: startOfDay } } }),
      this.prisma.callLog.count({ where: { operatorId, createdAt: { gte: startOfWeek } } }),
      this.prisma.callLog.count({ where: { operatorId, createdAt: { gte: startOfMonth } } }),
      this.prisma.callLog.count({ where: { createdAt: { gte: startOfDay } } }),
      this.prisma.broker.count({
        where: { isInBase: true, doNotCall: false, OR: [{ nextCallAt: null }, { nextCallAt: { lte: now } }] },
      }),
      this.prisma.broker.count({ where: { isInBase: true } }),
    ]);

    return {
      operator: { today, week, month },
      team: { today: todayAll },
      queueWaiting,
      totalInBase,
    };
  }

  // ─── Импорт брокеров из XLSX (admin) ──────────────────────────────────
  // TZ v3 §3 — Михаил сам загружает свежий снэпшот Google-таблицы через UI.
  // Логика парсинга вынесена в brokers-import.helper.ts.

  async importBrokersFromXlsx(
    file: Express.Multer.File | undefined,
    opts: {
      filter?: string;
      callFlag?: string;
      dryRun?: string | boolean;
      limit?: string | number;
      includeCoords?: string | boolean;
    },
  ) {
    if (!file || !file.buffer) {
      throw new BadRequestException('Файл не загружен');
    }

    // 1) Распарсить параметры
    const filterRaw = (opts.filter || 'ALL').toString().toUpperCase();
    const filter =
      filterRaw === 'ALL'
        ? new Set<BrokerCategoryCode>(VALID_CATEGORIES)
        : new Set<BrokerCategoryCode>(
            filterRaw.split(',').map((s) => s.trim()) as BrokerCategoryCode[],
          );
    for (const c of filter) {
      if (!VALID_CATEGORIES.includes(c)) {
        throw new BadRequestException(`Неизвестная категория в filter: ${c}`);
      }
    }

    let callFlagFilter: Set<string> | null = null;
    if (opts.callFlag && String(opts.callFlag).trim()) {
      callFlagFilter = new Set(
        String(opts.callFlag).split(',').map((s) => s.trim().toLowerCase()),
      );
      for (const f of callFlagFilter) {
        if (!(VALID_CALL_FLAGS as readonly string[]).includes(f)) {
          throw new BadRequestException(`Неизвестное значение call-flag: ${f}`);
        }
      }
    }

    const isDryRun = opts.dryRun === true || opts.dryRun === 'true' || opts.dryRun === '1';
    const includeCoords =
      opts.includeCoords === true || opts.includeCoords === 'true' || opts.includeCoords === '1';
    const limit = opts.limit ? parseInt(String(opts.limit), 10) : null;

    // 2) Прочитать xlsx из буфера
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(file.buffer, { type: 'buffer' });
    } catch (e: any) {
      throw new BadRequestException(`Не получилось распарсить xlsx: ${e?.message || e}`);
    }
    if (workbook.SheetNames.length === 0) {
      throw new BadRequestException('Файл не содержит листов');
    }
    const mainSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(mainSheet, { defval: null });

    const coordRows: Record<string, unknown>[] = includeCoords && workbook.SheetNames.length >= 2
      ? XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[workbook.SheetNames[1]], { defval: null })
      : [];

    // 3) Фильтрация + нормализация
    const { candidates, stats } = parseAndFilter(rows, { filter, callFlagFilter, limit });

    // 4) DRY-RUN — проверить сколько уже есть в БД
    if (isDryRun) {
      const existing = await this.prisma.broker.findMany({
        where: { phone: { in: candidates.map((c) => c.phone) } },
        select: { phone: true },
      });
      const existSet = new Set(existing.map((b) => b.phone));
      const wouldUpdate = candidates.filter((c) => existSet.has(c.phone)).length;
      const wouldCreate = candidates.length - wouldUpdate;
      return {
        dryRun: true,
        stats: {
          ...stats,
          afterFilter: candidates.length,
          wouldCreate,
          wouldUpdate,
          wouldCreateCallLogs: candidates.filter((c) => c.callResult).length +
            candidates.filter((c) => c.zorgeResult).length,
          coordRows: coordRows.length,
        },
        preview: candidates.slice(0, 10).map((c) => ({
          phone: c.phone,
          name: c.name || '(без имени)',
          category: c.category,
          resultStr: c.resultStr,
          zorgeStr: c.zorgeStr,
        })),
      };
    }

    // 5) Реальный импорт — запускаем в фоне (job), возвращаем jobId сразу.
    //    Это нужно потому что 5500 брокеров × ~3-4 SQL/брокер = ~5 минут;
    //    HTTP-таймаут (nginx/браузер) убьёт коннект, пользователь подумает
    //    что не сработало и нажмёт повторно — а это удвоит CallLog.
    const job = this.importJobs.create();
    const baseSource = 'xlsx_upload';

    void this.runRealImport(job.id, candidates, coordRows, includeCoords, baseSource, stats);

    return {
      dryRun: false,
      jobId: job.id,
      status: 'queued',
      message: 'Импорт запущен в фоне. Опрашивай GET /admin/brokers/import-jobs/:id для прогресса.',
    };
  }

  // Фоновая запись импорта в БД с прогрессом и идемпотентностью CallLog.
  // Вызывается через `void` из importBrokersFromXlsx — НЕ ждём её, ошибки
  // НЕ должны утечь как unhandled rejection (всё в try/catch).
  private async runRealImport(
    jobId: string,
    candidates: Candidate[],
    coordRows: Record<string, unknown>[],
    includeCoords: boolean,
    baseSource: string,
    parseStats: any,
  ) {
    const dbStats = {
      created: 0,
      updated: 0,
      callLogsCreated: 0,
      callLogsSkipped: 0,
      errors: 0,
      coordCreated: 0,
      coordUpdated: 0,
    };
    const errors: Array<{ phone: string; error: string }> = [];

    try {
      this.importJobs.update(jobId, { status: 'running', step: 'writing-brokers' });
      this.importJobs.setProgress(jobId, 0, candidates.length, 'writing-brokers');

      let i = 0;
      for (const c of candidates) {
        i++;
        try {
          const existing = await this.prisma.broker.findUnique({ where: { phone: c.phone } });
          let brokerId: string;
          if (existing) {
            await this.prisma.broker.update({
              where: { id: existing.id },
              data: {
                category: c.category as any,
                isInBase: true,
                baseSource,
                doNotCall: existing.doNotCall || c.doNotCall,
                fullName: existing.fullName || c.name || '(без имени)',
              },
            });
            brokerId = existing.id;
            dbStats.updated++;
          } else {
            const created = await this.prisma.broker.create({
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
            brokerId = created.id;
            dbStats.created++;
          }

          // Идемпотентность CallLog: НЕ создаём дубликат если у брокера уже
          // есть запись с теми же (result, campaign, comment). Это защищает
          // от удвоения истории при повторном запуске импорта того же xlsx.
          if (c.callResult) {
            const exists = await this.prisma.callLog.findFirst({
              where: { brokerId, result: c.callResult as any, campaign: null, comment: c.comment },
              select: { id: true },
            });
            if (!exists) {
              await this.prisma.callLog.create({
                data: { brokerId, result: c.callResult as any, comment: c.comment, campaign: null },
              });
              dbStats.callLogsCreated++;
            } else {
              dbStats.callLogsSkipped++;
            }
          }
          if (c.zorgeResult) {
            const exists = await this.prisma.callLog.findFirst({
              where: { brokerId, result: c.zorgeResult as any, campaign: 'Зорге 9', comment: c.comment },
              select: { id: true },
            });
            if (!exists) {
              await this.prisma.callLog.create({
                data: { brokerId, result: c.zorgeResult as any, comment: c.comment, campaign: 'Зорге 9' },
              });
              dbStats.callLogsCreated++;
            } else {
              dbStats.callLogsSkipped++;
            }
          }
        } catch (e: any) {
          dbStats.errors++;
          if (errors.length < 20) errors.push({ phone: c.phone, error: e?.message || String(e) });
        }

        if (i % 25 === 0 || i === candidates.length) {
          this.importJobs.setProgress(jobId, i, candidates.length, 'writing-brokers');
        }
      }

      if (includeCoords && coordRows.length > 0) {
        this.importJobs.setProgress(jobId, 0, coordRows.length, 'writing-coords');
        let ci = 0;
        for (const row of coordRows) {
          ci++;
          const m = mapCoordRow(row);
          const norm = normalizePhone(m.phoneRaw);
          if (!norm.ok) continue;
          try {
            const existing = await this.prisma.broker.findUnique({ where: { phone: norm.phone! } });
            if (existing) {
              await this.prisma.broker.update({
                where: { id: existing.id },
                data: { isCoordinator: true, coordinatorAgency: m.agency, isInBase: true, baseSource },
              });
              dbStats.coordUpdated++;
            } else {
              await this.prisma.broker.create({
                data: {
                  fullName: m.name,
                  phone: norm.phone!,
                  role: 'BROKER',
                  status: 'PENDING',
                  category: 'COLD' as any,
                  isCoordinator: true,
                  coordinatorAgency: m.agency,
                  isInBase: true,
                  baseSource,
                },
              });
              dbStats.coordCreated++;
            }
          } catch (_) {
            // координаторы — не критично, не валим общий импорт
          }
          if (ci % 25 === 0 || ci === coordRows.length) {
            this.importJobs.setProgress(jobId, ci, coordRows.length, 'writing-coords');
          }
        }
      }

      this.importJobs.finish(jobId, {
        stats: { ...parseStats, afterFilter: candidates.length, coordRows: coordRows.length },
        dbStats,
        errors,
      });
    } catch (e: any) {
      this.importJobs.fail(jobId, e?.message || String(e));
    }
  }

  getImportJob(id: string) {
    return this.importJobs.get(id);
  }

  // ─── Integration settings ────────────────────────────────
  // 2026-06-04: whitelist ключей, которые админ может править из UI.
  // Любое значение не из списка → 400. Защита: иначе админ мог бы
  // подсунуть нагрузочный KV-стор.
  // 2026-06-05: добавлены AMO_ACCESS_TOKEN и AMO_REFRESH_TOKEN —
  // токены для подключения к amoCRM. При сохранении автоматически
  // обновляются в памяти процесса (setAmoTokens), чтобы адаптер
  // подхватил новое значение без рестарта.
  private static readonly INTEGRATION_KEYS = [
    'MOREKIT_WEBHOOK_URL',
    'AMO_ACCESS_TOKEN',
    'AMO_REFRESH_TOKEN',
    // 2026-06-08: Mango VPBX — для исходящих звонков КЦ.
    'MANGO_API_KEY',
    'MANGO_API_SALT',
    'MANGO_API_URL',
    // 2026-06-09: Mango integration-webhook URL — click-to-call через
    // готовый GET-шаблон без подписи. Альтернатива VPBX API.
    'MANGO_CALLBACK_URL',
    'MANGO_OUTBOUND_LINE',
    // 2026-06-09: Google Sheets — URL CSV-экспорта таблицы с базой брокеров.
    'GSHEETS_BROKERS_URL',
  ];

  // Ключи, значение которых не возвращаем в UI «как есть» (длинные JWT-токены / API keys).
  // Возвращаем только метаданные: длина, последние 6 символов для верификации.
  private static readonly INTEGRATION_SECRET_KEYS = new Set([
    'AMO_ACCESS_TOKEN',
    'AMO_REFRESH_TOKEN',
    'MANGO_API_KEY',
    'MANGO_API_SALT',
    // The integration-webhook URL may embed code/API_key query parameters.
    'MANGO_CALLBACK_URL',
  ]);

  async getIntegrationSettings() {
    const rows = await this.prisma.systemSetting.findMany({
      where: { key: { in: AdminService.INTEGRATION_KEYS } },
      select: { key: true, value: true, updatedAt: true, updatedBy: true },
    });
    const byKey = new Map(rows.map((r) => [r.key, r] as const));
    // Для каждой настройки отдаём currentValue (БД если есть, иначе env),
    // dbValue (только если есть запись), envValue (что лежит в окружении).
    return AdminService.INTEGRATION_KEYS.map((key) => {
      const row = byKey.get(key);
      const envValue = process.env[key] || '';
      const isSecret = AdminService.INTEGRATION_SECRET_KEYS.has(key);
      const dbValue = row?.value ?? null;
      // Для секретов отдаём только метаданные — длину и последние 6 символов
      // для верификации, что значение действительно установлено и какое
      // именно (без раскрытия полного содержимого в UI).
      const maskValue = (v: string | null) => {
        if (!v) return null;
        return `…${v.slice(-6)} (${v.length} симв.)`;
      };
      return {
        key,
        dbValue: isSecret ? maskValue(dbValue) : dbValue,
        envValue: isSecret ? maskValue(envValue) : envValue,
        currentValue: isSecret ? maskValue(dbValue || envValue) : (dbValue ?? envValue),
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy ?? null,
        isSecret,
      };
    });
  }

  async updateIntegrationSetting(key: string, value: string, updatedBy: string) {
    if (!AdminService.INTEGRATION_KEYS.includes(key)) {
      throw new BadRequestException(`Ключ ${key} не разрешён к редактированию`);
    }
    let trimmed = value.trim();
    if (key === 'MANGO_OUTBOUND_LINE' && trimmed) {
      const digits = trimmed.replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 15) {
        throw new BadRequestException(
          'MANGO_OUTBOUND_LINE должен содержать от 10 до 15 цифр',
        );
      }
      trimmed = digits;
    }
    if (key === 'MANGO_API_URL') {
      const effectiveValue = trimmed || process.env.MANGO_API_URL || '';
      try {
        // Keep an empty DB value as the env-fallback sentinel, but validate the
        // effective runtime value before persisting anything.
        const normalized = normalizeMangoApiUrl(effectiveValue);
        if (trimmed) trimmed = normalized;
      } catch {
        throw new BadRequestException(
          'MANGO_API_URL должен быть официальным HTTPS URL Mango VPBX',
        );
      }
    }
    if (key === 'MANGO_CALLBACK_URL') {
      const effectiveValue = trimmed || process.env.MANGO_CALLBACK_URL || '';
      try {
        normalizeMangoCallbackUrl(effectiveValue);
      } catch {
        throw new BadRequestException(
          'MANGO_CALLBACK_URL должен быть официальным HTTPS webhook-шаблоном Mango',
        );
      }
    }
    await this.prisma.systemSetting.upsert({
      where: { key },
      update: { value: trimmed, updatedBy },
      create: { key, value: trimmed, updatedBy },
    });
    await this.prisma.auditLog.create({
      data: {
        userId: updatedBy,
        action: 'INTEGRATION_SETTING_UPDATED',
        entity: 'SystemSetting',
        entityId: key,
        payload: { key, valueLength: trimmed.length },
      },
    });
    // 2026-06-05: если обновили amoCRM-токены — обновляем in-memory state
    // адаптера, чтобы следующий же request пошёл с новым значением,
    // без рестарта контейнера.
    let requeuedAmoApplications = 0;
    if (key === 'AMO_ACCESS_TOKEN' || key === 'AMO_REFRESH_TOKEN') {
      const current = getAmoTokens();
      const access = key === 'AMO_ACCESS_TOKEN' ? trimmed : current.access;
      const refresh = key === 'AMO_REFRESH_TOKEN' ? trimmed : current.refresh;
      setAmoTokens(access, refresh);
      // Re-open exhausted 401/403 rows only after the new credentials pass a
      // real account request. Ambiguous network/5xx failures are intentionally
      // excluded to avoid duplicate leads.
      if (access || refresh) {
        try {
          await this.amo.getAccount();
          requeuedAmoApplications = await requeueAmoAuthDeadLetters(
            this.prisma,
            'integration-setting-update',
            updatedBy,
          );
        } catch {
          // Saving the setting remains successful; amo-health reports whether
          // the pair is valid without exposing the raw upstream response.
        }
      }
    }
    // 2026-06-08: то же для Mango — конфиг подхватывается без рестарта.
    // An empty DB value means "use env fallback", both at bootstrap and
    // immediately after this hot update. Keeping these paths identical avoids
    // a temporary unconfigured state that would otherwise last until restart.
    if (key === 'MANGO_API_KEY') {
      setMangoConfig({ apiKey: trimmed || process.env.MANGO_API_KEY || '' });
    }
    if (key === 'MANGO_API_SALT') {
      setMangoConfig({ apiSalt: trimmed || process.env.MANGO_API_SALT || '' });
    }
    if (key === 'MANGO_API_URL') {
      setMangoConfig({ apiUrl: trimmed || process.env.MANGO_API_URL || '' });
    }
    if (key === 'MANGO_CALLBACK_URL') {
      setMangoConfig({ callbackUrl: trimmed || process.env.MANGO_CALLBACK_URL || '' });
    }
    if (key === 'MANGO_OUTBOUND_LINE') {
      setMangoConfig({ outboundLine: trimmed || process.env.MANGO_OUTBOUND_LINE || '' });
    }
    return { ok: true, key, requeuedAmoApplications };
  }

  // ─── Дубли брокеров: ручное слияние (/admin/broker-dedup) ─────────────
  // 2026-07-17: аудит нашёл 839 групп совпадающих ФИО (4562 записи).
  // Решение пользователя: никакого автослияния — только вручную со страницы.
  // Слитые карточки НЕ удаляются: mergedIntoId + isInBase=false скрывают их
  // из очереди КЦ и списков, история и телефоны переезжают в основную.

  async getDedupGroups(query: { page?: string | number; limit?: string | number; search?: string }) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(50, Number(query.limit) || 20);
    const offset = (page - 1) * limit;
    const search = String(query.search || '').trim().toLowerCase();
    const searchLike = `%${search}%`;

    // Группы: одинаковое нормализованное ФИО среди неслитых BROKER-записей.
    // «(без имени)», пустые и телефоны-вместо-имени в дубли не попадают —
    // это не совпадение личности, ими займётся обогащение из amo.
    const groups = await this.prisma.$queryRaw<Array<{ name_key: string; cnt: bigint }>>`
      SELECT lower(btrim(full_name)) AS name_key, count(*) AS cnt
      FROM brokers
      WHERE role = 'BROKER'
        AND merged_into_id IS NULL
        AND btrim(coalesce(full_name, '')) <> ''
        AND lower(btrim(full_name)) <> '(без имени)'
        AND full_name !~ '^[-+0-9() ]+$'
        AND (${search} = '' OR lower(btrim(full_name)) LIKE ${searchLike})
        AND lower(btrim(full_name)) NOT IN (SELECT name_key FROM broker_dedup_dismissals)
      GROUP BY 1
      HAVING count(*) > 1
      ORDER BY count(*) DESC, 1
      LIMIT ${limit} OFFSET ${offset}
    `;
    const totalRows = await this.prisma.$queryRaw<Array<{ total: bigint }>>`
      SELECT count(*) AS total FROM (
        SELECT 1
        FROM brokers
        WHERE role = 'BROKER'
          AND merged_into_id IS NULL
          AND btrim(coalesce(full_name, '')) <> ''
          AND lower(btrim(full_name)) <> '(без имени)'
          AND full_name !~ '^[-+0-9() ]+$'
          AND (${search} = '' OR lower(btrim(full_name)) LIKE ${searchLike})
          AND lower(btrim(full_name)) NOT IN (SELECT name_key FROM broker_dedup_dismissals)
        GROUP BY lower(btrim(full_name))
        HAVING count(*) > 1
      ) g
    `;
    const total = Number(totalRows[0]?.total || 0);

    const keys = groups.map((g) => g.name_key);
    let brokers: any[] = [];
    if (keys.length > 0) {
      brokers = await this.prisma.$queryRaw<any[]>`
        SELECT id, full_name, phone, email, category, status, password_hash IS NOT NULL AS has_cabinet,
               amo_contact_id IS NOT NULL AS has_amo, is_coordinator, coordinator_agency,
               specialization, do_not_call, base_source, created_at, last_call_at,
               lower(btrim(full_name)) AS name_key,
               (SELECT count(*) FROM call_logs cl WHERE cl.broker_id = brokers.id) AS call_count,
               (SELECT count(*) FROM clients c WHERE c.broker_id = brokers.id) AS client_count,
               (SELECT count(*) FROM deals d WHERE d.broker_id = brokers.id) AS deal_count
        FROM brokers
        WHERE role = 'BROKER' AND merged_into_id IS NULL
          AND lower(btrim(full_name)) = ANY(${keys})
        ORDER BY created_at ASC
      `;
    }

    const byKey = new Map<string, any[]>();
    for (const b of brokers) {
      const list = byKey.get(b.name_key) || [];
      list.push({
        id: b.id,
        fullName: b.full_name,
        phone: b.phone,
        email: b.email,
        category: b.category,
        status: b.status,
        hasCabinet: b.has_cabinet,
        hasAmo: b.has_amo,
        isCoordinator: b.is_coordinator,
        coordinatorAgency: b.coordinator_agency,
        specialization: b.specialization,
        doNotCall: b.do_not_call,
        baseSource: b.base_source,
        createdAt: b.created_at,
        lastCallAt: b.last_call_at,
        callCount: Number(b.call_count),
        clientCount: Number(b.client_count),
        dealCount: Number(b.deal_count),
      });
      byKey.set(b.name_key, list);
    }

    return {
      groups: groups.map((g) => ({
        nameKey: g.name_key,
        count: Number(g.cnt),
        brokers: byKey.get(g.name_key) || [],
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async dismissDedupGroup(nameKey: string, userId: string) {
    const key = String(nameKey || '').trim().toLowerCase();
    if (!key) throw new BadRequestException('nameKey обязателен');
    await this.prisma.brokerDedupDismissal.upsert({
      where: { nameKey: key },
      update: {},
      create: { nameKey: key, createdById: userId },
    });
    return { ok: true };
  }

  async mergeBrokers(userId: string, body: { primaryId: string; duplicateIds: string[] }) {
    const { primaryId } = body;
    const duplicateIds = (body.duplicateIds || []).filter((id) => id && id !== primaryId);
    if (!primaryId || duplicateIds.length === 0) {
      throw new BadRequestException('Нужны primaryId и хотя бы один duplicateId');
    }

    const all = await this.prisma.broker.findMany({
      where: { id: { in: [primaryId, ...duplicateIds] } },
    });
    const primary = all.find((b) => b.id === primaryId);
    const dups = all.filter((b) => duplicateIds.includes(b.id));
    if (!primary) throw new NotFoundException('Основная карточка не найдена');
    if (dups.length !== duplicateIds.length) throw new NotFoundException('Часть дублей не найдена');
    if (primary.mergedIntoId) throw new BadRequestException('Основная карточка сама уже слита');
    for (const d of dups) {
      if (d.mergedIntoId) throw new BadRequestException(`Карточка ${d.fullName} уже слита`);
      if ((d as any).role !== 'BROKER') throw new BadRequestException('Сливать можно только брокеров');
      // Защита: зарегистрированный в кабинете (есть пароль) не может быть
      // дублем — иначе у человека умрёт логин. Его делают основной карточкой.
      if (d.passwordHash && !primary.passwordHash) {
        throw new BadRequestException(
          `«${d.fullName}» зарегистрирован в кабинете — выберите его основной карточкой`,
        );
      }
      if (d.passwordHash && primary.passwordHash) {
        throw new BadRequestException(
          'Обе карточки зарегистрированы в кабинете — такое слияние делаем только руками через поддержку',
        );
      }
    }

    // Ранги категорий: при слиянии берём «самую тёплую».
    const catRank: Record<string, number> = {
      CONVERTED: 5, HOT: 4, WARM: 3, COLD: 2, ON_BOT_REVIEW: 1, BLACKLIST: 0,
    };

    await this.prisma.$transaction(async (tx) => {
      for (const dup of dups) {
        // 1. Телефон дубля и его доп.номера → BrokerPhone основной карточки.
        //    skipDuplicates покрывает конфликт unique(phone).
        const dupPhones = await tx.brokerPhone.findMany({ where: { brokerId: dup.id } });
        await tx.brokerPhone.createMany({
          data: [
            { brokerId: primaryId, phone: dup.phone },
            ...dupPhones.map((p) => ({ brokerId: primaryId, phone: p.phone })),
          ],
          skipDuplicates: true,
        });
        await tx.brokerPhone.deleteMany({ where: { brokerId: dup.id } });

        // 2. История и связи → на основную.
        await tx.callLog.updateMany({ where: { brokerId: dup.id }, data: { brokerId: primaryId } });
        await tx.client.updateMany({ where: { brokerId: dup.id }, data: { brokerId: primaryId } });
        await tx.client.updateMany({ where: { responsibleBrokerId: dup.id }, data: { responsibleBrokerId: primaryId } });
        await tx.deal.updateMany({ where: { brokerId: dup.id }, data: { brokerId: primaryId } });
        await tx.meeting.updateMany({ where: { brokerId: dup.id }, data: { brokerId: primaryId } });
        await tx.call.updateMany({ where: { brokerId: dup.id }, data: { brokerId: primaryId } });

        // Связи с агентствами: переносим только отсутствующие у основной.
        const dupAgencies = await tx.brokerAgency.findMany({ where: { brokerId: dup.id } });
        for (const ba of dupAgencies) {
          const exists = await tx.brokerAgency.findUnique({
            where: { brokerId_agencyId: { brokerId: primaryId, agencyId: ba.agencyId } },
          });
          if (!exists) {
            await tx.brokerAgency.update({ where: { id: ba.id }, data: { brokerId: primaryId, isPrimary: false } });
          } else {
            await tx.brokerAgency.delete({ where: { id: ba.id } });
          }
        }

        // 3. Обогащение основной карточки пустых полей из дубля.
        //    Unique-поля (amoContactId, telegramChatId) сначала освобождаем.
        const patch: any = {};
        if (!primary.email && dup.email) patch.email = dup.email;
        if (!primary.position && dup.position) patch.position = dup.position;
        if (!primary.telegramUsername && dup.telegramUsername) patch.telegramUsername = dup.telegramUsername;
        if (!primary.whatsappUsername && dup.whatsappUsername) patch.whatsappUsername = dup.whatsappUsername;
        if (!primary.specialization && dup.specialization) patch.specialization = dup.specialization;
        if (!primary.region && dup.region) patch.region = dup.region;
        if (dup.isRegional && !primary.isRegional) patch.isRegional = true;
        if (dup.isCoordinator && !primary.isCoordinator) patch.isCoordinator = true;
        if (!primary.coordinatorAgency && dup.coordinatorAgency) patch.coordinatorAgency = dup.coordinatorAgency;
        if (dup.doNotCall && !primary.doNotCall) patch.doNotCall = true;
        if ((catRank[dup.category] ?? 0) > (catRank[primary.category] ?? 0)) patch.category = dup.category;
        if (dup.lastCallAt && (!primary.lastCallAt || dup.lastCallAt > primary.lastCallAt)) patch.lastCallAt = dup.lastCallAt;
        if (!primary.amoContactId && dup.amoContactId) {
          const moved = dup.amoContactId;
          await tx.broker.update({ where: { id: dup.id }, data: { amoContactId: null } });
          patch.amoContactId = moved;
        }
        if (!primary.telegramChatId && dup.telegramChatId) {
          const moved = dup.telegramChatId;
          await tx.broker.update({ where: { id: dup.id }, data: { telegramChatId: null } });
          patch.telegramChatId = moved;
        }
        if (Object.keys(patch).length > 0) {
          await tx.broker.update({ where: { id: primaryId }, data: patch });
          Object.assign(primary, patch); // чтобы следующий дубль видел уже обогащённую основную
        }

        // 4. Помечаем дубль слитым (не удаляем!). isInBase=false страхует от
        //    возврата в очередь, если ночной sheet-sync снова тронет запись.
        await tx.broker.update({
          where: { id: dup.id },
          data: { mergedIntoId: primaryId, mergedAt: new Date(), isInBase: false, doNotCall: true },
        });
      }

      await tx.auditLog.create({
        data: {
          userId,
          action: 'BROKER_DEDUP_MERGE',
          entity: 'Broker',
          entityId: primaryId,
          payload: { primaryId, duplicateIds, mergedCount: duplicateIds.length },
        },
      });
    });

    return { ok: true, primaryId, merged: duplicateIds.length };
  }

}
