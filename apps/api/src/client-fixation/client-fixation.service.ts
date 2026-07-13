import { Injectable, Inject, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaClient, UniquenessStatus } from '@st-michael/database';
import { Project } from '@st-michael/shared';
import { AmoCrmAdapter, MorekitAdapter, morekitPhone, morekitProjectName, morekitLeadDate, AMO_CONTACT_FIELDS, brokerToAmoContactFields } from '@st-michael/integrations';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import * as XLSX from 'xlsx';
import { getSystemSetting } from '../common/system-setting';
import { buildPhoneSearchConditions } from '../admin/brokers-import.helper';

const UNIQUENESS_DAYS = 30;
const msInDays = (days: number) => days * 24 * 60 * 60 * 1000;

@Injectable()
export class ClientFixationService {
  // 2026-06-04: прямой webhook в Morekit (без посредничества Salesbot).
  private readonly morekit = new MorekitAdapter();

  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    private amoCrmAdapter: AmoCrmAdapter,
    @InjectQueue('notifications') private notificationQueue: Queue,
  ) {}

  async fixClient(
    brokerId: string,
    data: {
      phone: string;
      fullName: string;
      email?: string;        // правка 2026-05-15: необязательное
      comment?: string;
      project: Project;
      agencyInn: string;
      // Новые поля 2026-05-14: для авто-заполнения custom-полей в amoCRM.
      propertyType?: string;
      roomsCount?: string;
      amount?: number;
      sqm?: number;
      participants?: { firstName?: string; lastName?: string; phone?: string }[];
      // Правка 2026-05-22: дополнительные поля для лида и контакта клиента
      clientRegion?: string;       // регион клиента → REGION 589265
      presentationSent?: boolean;  // отправлена презентация → PRESENTATION_SENT 835955
      purchaseTiming?: string;     // «Планирует покупку» (от 1 до 3 месяцев и т.д.)
      readinessLevel?: string;     // «Готовность к сделке» (Холодный/Тёплый/Горячий)
      // 2026-05-26: брокер подтвердил что хочет создать дубль своего клиента
      confirmDuplicate?: boolean;
      // 2026-06-19: для координаторов — реальный брокер, ведущий клиента.
      responsibleBrokerId?: string;
    },
  ) {
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
      include: { brokerAgencies: { select: { agencyId: true } } },
    });
    if (!broker) throw new BadRequestException('Broker not found');

    // 2026-07-01 (refactor): роль координатора убрана. Любой брокер может
    // фиксировать клиента на другого — новый брокер создаётся через
    // /create-new-broker перед fixClient, его id прилетает как
    // responsibleBrokerId. Если responsibleBrokerId прислан — проверяем что
    // этот брокер существует и активен. Если не прислан — responsibleBroker =
    // сам вызывающий (фиксация на себя).
    let responsibleBroker = broker as any;
    if (data.responsibleBrokerId && data.responsibleBrokerId !== broker.id) {
      const candidate = await this.prisma.broker.findUnique({
        where: { id: data.responsibleBrokerId },
      });
      if (!candidate) {
        throw new BadRequestException('Указанный ответственный брокер не найден');
      }
      responsibleBroker = candidate;
    }

    // 2026-06-09: блок полей формы фиксации, общий для всех 4 веток create.
    // Раньше эти данные склеивались в comment; теперь храним структурированно
    // и показываем в карточке клиента у брокера. Prisma сама приведёт
    // number → Decimal для amount/sqm.
    const fixationFormFields = {
      propertyType: data.propertyType || null,
      roomsCount: data.roomsCount || null,
      amount: data.amount != null ? data.amount : null,
      sqm: data.sqm != null ? data.sqm : null,
      clientRegion: data.clientRegion || null,
      purchaseTiming: data.purchaseTiming || null,
      readinessLevel: data.readinessLevel || null,
    } as any;

    // Find or create agency
    let agency = await this.prisma.agency.findUnique({
      where: { inn: data.agencyInn },
    });

    if (!agency) {
      // Bug fix 2026-05-25: если amo лежит/токен истёк — НЕ валим фиксацию.
      // Создаём агентство в нашей БД с минимальными данными, amo-sync
      // подберёт позже через scheduler/manual sync.
      let agencyName = `Агентство ${data.agencyInn}`;
      try {
        const amoCompany = await this.amoCrmAdapter.findCompanyByInn(data.agencyInn);
        if (amoCompany) {
          agencyName = amoCompany.name;
        } else {
          const newAmoCompany = await this.amoCrmAdapter.createCompany({
            name: agencyName,
          });
          if (newAmoCompany?.name) agencyName = newAmoCompany.name;
        }
      } catch (e: any) {
        console.error('[fixClient] amo agency lookup failed, продолжаем без amo:', e?.message || e);
      }
      agency = await this.prisma.agency.create({
        data: { name: agencyName, inn: data.agencyInn },
      });
    }

    // 2026-06-11: ПРОВЕРКА УНИКАЛЬНОСТИ В amoCRM ВСЕГДА И ПЕРВОЙ.
    // Раньше эта проверка была ВНУТРИ `if (!existingClient)` — то есть при
    // повторной фиксации того же клиента тем же брокером (existingClient
    // найден в нашей БД) логика RULE_1/RULE_2/RULE_3 НЕ срабатывала, и
    // создавался дубль amoCRM-лида через duplicate-confirmation flow.
    // Тест 2026-06-11 (Efremov Mikhail 32209267 + Тест47 32209273):
    // лид 1 уже был в КЦ «Классифицировали» (62907282 = RULE_1) → должны
    // были только повесить alarm-задачу, но создали лид 2.
    let amoVerdict: {
      rule: 'RULE_1' | 'RULE_2' | 'RULE_3' | 'NO_CONFLICT' | 'RULE_EXCEPTION_AFTER_SALES_MEETING' | 'RULE_REJECT_SALES_DEAL';
      verdict: 'UNIQUE' | 'ALARM';
      reason: string;
      contactId?: number;
      leads?: any[];
      triggerType?: 'DEFERRED_DEMAND' | 'NEW_REQUEST_NO_BROKER' | 'ACTIVE_SALES';
      triggerLeadId?: number;
    } | null = null;
    try {
      amoVerdict = await this.amoCrmAdapter.checkUniqueness(data.phone);
      console.log(`[fixClient] amo uniqueness rule=${amoVerdict.rule} — ${amoVerdict.reason}${amoVerdict.triggerLeadId ? ` — triggerLeadId=${amoVerdict.triggerLeadId}` : ''}`);
    } catch (e: any) {
      console.error('[fixClient] amo checkUniqueness failed, fallback to local DB only:', e?.message || e);
    }

    // Проверяем сначала запись ЭТОГО брокера — если он уже фиксировал, обновляем её.
    const existingClient = await this.prisma.client.findFirst({
      where: { phone: data.phone, brokerId },
      include: { deals: true, broker: true },
    });

    // 2026-06-11: RULE_1/RULE_2 — alarm-flow, не создаём новый amoCRM лид,
    // не выпускаем duplicate-confirmation. Срабатывает независимо от того,
    // есть ли existingClient. Если есть — оставляем как есть (НЕ меняем
    // его статус: брокер не должен видеть «На проверке» если просто
    // переподал свою же фиксацию). Если нет — создаём новый Client UNDER_REVIEW.
    if (amoVerdict && (amoVerdict.rule === 'RULE_1' || amoVerdict.rule === 'RULE_2')) {
      return await this.handleRule1Or2Alarm({
        amoVerdict,
        data,
        broker,
        responsibleBroker,
        agency,
        brokerId,
        existingClient,
        fixationFormFields,
      });
    }

    // 2026-06-16: RULE_REJECT_SALES_DEAL — клиент уже в стадии сделки
    // (Платная бронь / Подготовка / Сделка / Зарегистрирована / Контроль
    // оплаты) у брокера A. Брокер B даже не пытается — REJECTED сразу,
    // новой карточки не создаём.
    if (amoVerdict && amoVerdict.rule === 'RULE_REJECT_SALES_DEAL') {
      const client = await this.prisma.client.create({
        data: {
          brokerId,
          responsibleBrokerId: responsibleBroker.id,
          phone: data.phone,
          fullName: data.fullName,
          email: data.email || null,
          comment: data.comment,
          project: data.project as any,
          fixationAgencyId: agency?.id,
          uniquenessStatus: UniquenessStatus.REJECTED,
          uniquenessReason: `Клиент уже в стадии сделки (lead=${amoVerdict.triggerLeadId}). Уникальность отклонена.`,
          ...fixationFormFields,
        },
      });
      try {
        await this.logAudit(brokerId, 'CLIENT_FIXATION_CONFLICT', 'Client', client.id, {
          scenario: 'SALES_DEAL_REJECT',
          amoReason: amoVerdict.reason,
          amoLeadId: amoVerdict.triggerLeadId,
        });
      } catch (e: any) {
        console.error('[fixClient sales-deal-reject] audit failed:', e?.message || e);
      }
      return {
        client,
        status: 'REJECTED',
        message: 'Клиент уже на стадии сделки у другого брокера. Уникальность невозможна.',
      };
    }

    if (!existingClient) {
      // 2026-06-11: amoVerdict + RULE_1/RULE_2 теперь обрабатываются ВЫШЕ
      // через handleRule1Or2Alarm — сюда попадаем только при RULE_3 или
      // NO_CONFLICT (либо если amoCRM упал и amoVerdict=null).

      // 2026-06-14: пока встреча у другого брокера не ПРОВЕДЕНА — несколько
      // брокеров могут одновременно быть условно уникальными. Блокируем
      // только если у другого брокера встреча COMPLETED или статус FIXED
      // (акт осмотра подписан — клиент окончательно за ним).
      //
      // Раньше блокировали также любое активное CONDITIONALLY_UNIQUE и любую
      // CONFIRMED-встречу (запланированную, но ещё не проведённую) — это
      // давало преждевременное «На проверке» при первой же параллельной
      // фиксации, ещё до встречи.
      const conflictingClient = await this.prisma.client.findFirst({
        where: {
          phone: data.phone,
          NOT: { brokerId },
          OR: [
            { fixationStatus: 'FIXED' as any },
            { meetings: { some: { status: 'COMPLETED' as any } } },
          ],
        },
        include: { broker: true, meetings: true },
      });

      if (conflictingClient) {
        // Создаём запись в UNDER_REVIEW у НОВОГО брокера и уведомляем менеджеров.
        const client = await this.prisma.client.create({
          data: {
            brokerId,
            responsibleBrokerId: responsibleBroker.id,
            phone: data.phone,
            fullName: data.fullName,
            email: data.email || null,
            comment: data.comment,
            project: data.project as any,
            fixationAgencyId: agency.id,
            uniquenessStatus: UniquenessStatus.UNDER_REVIEW,
            uniquenessReason: `Конфликт: клиент уже на уникальности у брокера ${conflictingClient.broker.fullName} (${conflictingClient.broker.phone}). Менеджер проверит.`,
            ...fixationFormFields,
          },
        });

        // 2026-05-26: TG менеджерам / SMS брокеру отключены — note + task
        // в amoCRM на лиде того клиента достаточно, КЦ возьмёт в работу.
        // Двойное оповещение раздражало.

        try {
          await this.logAudit(brokerId, 'CLIENT_FIXATION_CONFLICT', 'Client', client.id, {
            scenario: 'CROSS_BROKER_CONFLICT',
            existingBrokerId: conflictingClient.brokerId,
            existingBrokerName: conflictingClient.broker.fullName,
          });
        } catch (e: any) {
          console.error('[fixClient conflict] audit failed:', e?.message || e);
        }

        // 2026-05-26: добавляем примечание в существующий amoCRM-лид
        // того клиента — менеджер увидит «попытка повторной фиксации».
        if (conflictingClient.amoLeadId) {
          try {
            await this.amoCrmAdapter.addRefixationAttemptNote(
              Number(conflictingClient.amoLeadId),
              {
                requestingBrokerName: broker.fullName,
                requestingBrokerPhone: broker.phone,
                clientPhone: data.phone,
              },
            );
          } catch (e: any) {
            console.error('[fixClient conflict] amo refixation note failed:', e?.message || e);
          }
        }

        return {
          client,
          status: 'UNDER_REVIEW',
          message: `Клиент уже на уникальности у брокера ${conflictingClient.broker.fullName}. Менеджер уведомлён и проверит фиксацию.`,
        };
      }

      // 2026-06-16: RULE_EXCEPTION_AFTER_SALES_MEETING — клиент уже в
      // средней стадии sales-pipeline у брокера A (думают/отложенный/
      // устная/снята бронь). Создаём L2 и прикрепляем B как обычно, но
      // в кабинете B статус UNDER_REVIEW. Снимется когда L2 дойдёт до
      // 62907282 «Квалифицировали» (webhook) или старая sales-карточка
      // закроется 143. Маркер для webhook: префикс в uniquenessReason.
      const isExceptionAfterSalesMeeting = amoVerdict?.rule === 'RULE_EXCEPTION_AFTER_SALES_MEETING';
      // Scenario 1: New client
      const client = await this.prisma.client.create({
        data: {
          brokerId,
          responsibleBrokerId: responsibleBroker.id,
          phone: data.phone,
          fullName: data.fullName,
          email: data.email || null,
          comment: data.comment,
          project: data.project as any,
          fixationAgencyId: agency.id,
          uniquenessStatus: isExceptionAfterSalesMeeting
            ? UniquenessStatus.UNDER_REVIEW
            : UniquenessStatus.CONDITIONALLY_UNIQUE,
          uniquenessExpiresAt: isExceptionAfterSalesMeeting
            ? null
            : new Date(Date.now() + msInDays(UNIQUENESS_DAYS)),
          uniquenessReason: isExceptionAfterSalesMeeting
            ? `EXCEPTION_AFTER_SALES_MEETING:${amoVerdict?.triggerLeadId || ''} ${amoVerdict?.reason || ''}`
            : null,
          ...fixationFormFields,
        },
      });

      // Сформировать комментарий из структурированных полей. Правка 2026-05-14.
      const commentParts: string[] = [];
      if (data.propertyType) commentParts.push(`Тип: ${data.propertyType}`);
      if (data.roomsCount) commentParts.push(`Комнат: ${data.roomsCount}`);
      if (data.sqm) commentParts.push(`Метраж: ${data.sqm} м²`);
      if (data.amount) commentParts.push(`Бюджет: ${data.amount.toLocaleString('ru-RU')} ₽`);
      if (data.participants?.length) {
        const ps = data.participants.map((p, i) =>
          `${i + 1}) ${[p.lastName, p.firstName, p.phone].filter(Boolean).join(' ').trim()}`,
        ).filter((x) => x.length > 3);
        if (ps.length) commentParts.push(`Участники: ${ps.join('; ')}`);
      }
      if (data.comment) commentParts.unshift(data.comment);
      const fullComment = commentParts.join('. ');

      // Bug fix 2026-05-25: amo-вызов изолируем — клиент уже в БД,
      // фиксация состоялась. Если amo упал (401/таймаут/5xx) —
      // логируем в audit + помечаем amoSyncStatus=FAILED + шлём уведомление
      // менеджерам и координаторам. Брокеру возвращаем контакты менеджеров.
      let amoSyncOk = true;
      let amoSyncError: string | null = null;
      let createdAmoLeadId: number | null = null;
      try {
        // 2026-06-19: используем responsibleBroker (для координатора — выбранный
        // реальный брокер, для обычного брокера — он сам).
        const resultLead = await this.amoCrmAdapter.createFixationRequest({
          clientPhone: data.phone,
          clientEmail: data.email,
          clientName: data.fullName,
          clientRegion: data.clientRegion,
          presentationSent: data.presentationSent,
          brokerPhone: responsibleBroker.phone,
          brokerAmoContactId: responsibleBroker.amoContactId ? Number(responsibleBroker.amoContactId) : undefined,
          agencyName: agency.name,
          agencyInn: agency.inn,
          comment: fullComment,
          project: data.project as Project,
          propertyType: data.propertyType,
          roomsCount: data.roomsCount,
          amount: data.amount,
          sqm: data.sqm,
          purchaseTiming: data.purchaseTiming,
          readinessLevel: data.readinessLevel,
          fromBroker: true, // фиксация ВСЕГДА от брокера
          // 2026-06-11: reuseLeadId больше не используется — логика
          // «конкурирующие брокеры» перенесена в Правило 1 (handled выше
          // в ALARM-ветке: брокер прикрепляется контактом, нового лида нет).
          // Сюда попадаем только при RULE_3 / NO_CONFLICT → всегда новый лид.
        });
        createdAmoLeadId = resultLead?.id ? Number(resultLead.id) : null;
      } catch (e: any) {
        amoSyncOk = false;
        amoSyncError = String(e?.message || e).slice(0, 500);
        console.error('[fixClient] amo createFixationRequest failed:', amoSyncError);
      }

      // 2026-06-04: прямой webhook в Morekit (без Salesbot в amo).
      // Fire-and-forget: ошибка Morekit'а не валит фиксацию у брокера.
      // URL берём из админ-настроек (SystemSetting) с env-fallback.
      if (amoSyncOk && createdAmoLeadId) {
        const morekitUrl = await getSystemSetting(this.prisma, 'MOREKIT_WEBHOOK_URL');
        if (morekitUrl) {
          this.morekit.notifyFixation({
            id: String(createdAmoLeadId),
            agency: agency.name,
            broker_id: responsibleBroker.amoContactId ? String(responsibleBroker.amoContactId) : '',
            agent_name: responsibleBroker.fullName,
            agent_phone: morekitPhone(responsibleBroker.phone),
            agent_mail: responsibleBroker.email || '',
            budget: data.amount ? String(data.amount) : '0',
            clients: [{ name: data.fullName, phone: morekitPhone(data.phone) }],
            type: data.propertyType || 'Квартира',
            lead_date: morekitLeadDate(),
            project: morekitProjectName(String(data.project)),
          }, morekitUrl).catch((e) => console.error('[fixClient] morekit notify error:', e?.message || e));

          // 2026-06-16: первичная фиксация (новый лид) — синкаем
          // responsible_user_id с Морикит-задачи на сам лид. Это
          // ОДНОКРАТНО, при создании. Повторные ALARM-задачи
          // (handleRule1Or2Alarm) ответственного лида НЕ меняют.
          this.amoCrmAdapter
            .syncLeadResponsibleFromLatestTask(createdAmoLeadId)
            .catch((e) => console.error('[fixClient] sync lead responsible error:', e?.message || e));
        }
      }

      // Помечаем статус amo-синка на клиенте.
      // Bug fix 2026-05-26: если на проде ещё не применена миграция и
      // полей amoSyncStatus/amoSyncError/amoSyncAttempts/amoSyncLastAttemptAt
      // в БД нет — Prisma выбросит ошибку Unknown arg. Заворачиваем в
      // try/catch чтобы это не валило фиксацию: клиент УЖЕ в БД, статус
      // amo-синка — второстепенно.
      try {
        await this.prisma.client.update({
          where: { id: client.id },
          data: {
            amoSyncStatus: amoSyncOk ? 'SYNCED' : 'FAILED',
            amoSyncError: amoSyncOk ? null : amoSyncError,
            amoSyncAttempts: { increment: 1 },
            amoSyncLastAttemptAt: new Date(),
            // 2026-06-04: критично сохранять lead id, иначе webhook от amoCRM
            // на этот лид не сможет найти Client (искал по amoLeadId).
            ...(createdAmoLeadId ? { amoLeadId: BigInt(createdAmoLeadId) } : {}),
          } as any,
        });
      } catch (e: any) {
        console.error('[fixClient] failed to update amoSyncStatus (миграция не применена?):', e?.message || e);
      }

      if (!amoSyncOk) {
        try {
          await this.logAudit(brokerId, 'AMO_SYNC_FAILED', 'Client', client.id, {
            step: 'createFixationRequest',
            error: amoSyncError,
          });
        } catch (e: any) {
          console.error('[fixClient] audit log failed:', e?.message || e);
        }
        try {
          await this.notifyAmoSyncFailed(client.id, broker, data.phone, amoSyncError || '');
        } catch (e: any) {
          console.error('[fixClient] notifyAmoSyncFailed failed:', e?.message || e);
        }
      }

      // Update broker funnel stage if needed
      if (broker.funnelStage === 'NEW_BROKER' || broker.funnelStage === 'BROKER_TOUR') {
        await this.prisma.broker.update({
          where: { id: brokerId },
          data: { funnelStage: 'FIXATION' },
        });
      }

      try {
        await this.logAudit(brokerId, 'CLIENT_FIXATION', 'Client', client.id, {
          scenario: 'NEW_CLIENT',
          phone: data.phone,
        });
      } catch (e: any) {
        console.error('[fixClient new] audit failed:', e?.message || e);
      }

      // Если amo упал — отдаём контакты менеджеров, чтобы брокер мог позвонить.
      let managerContacts: any = undefined;
      if (!amoSyncOk) {
        try { managerContacts = await this.getManagerContacts(); }
        catch (e: any) { console.error('[fixClient new] getManagerContacts failed:', e?.message || e); }
      }

      return {
        client,
        status: 'CONDITIONALLY_UNIQUE',
        amoSyncStatus: amoSyncOk ? 'SYNCED' : 'FAILED',
        message: amoSyncOk
          ? 'Client conditionally fixed. Expires in 30 days.'
          : 'Клиент зафиксирован в кабинете, но не передан в amoCRM из-за технической ошибки. Менеджеры уведомлены. При срочности — свяжитесь напрямую.',
        managerContacts,
      };
    }

    // 2026-06-14: единое правило для повторной фиксации того же брокера.
    // К этой точке мы попадаем когда:
    //   - existingClient есть (этот брокер уже фиксировал клиента)
    //   - amoVerdict НЕ RULE_1/RULE_2 (старый лид НЕ активный — обработали бы выше
    //     в handleRule1Or2Alarm с тихим мержем без нового лида)
    // То есть amoVerdict здесь либо RULE_3 / NO_CONFLICT (старый лид закрыт
    // или контакта в amo нет), либо null (amo упал).
    //
    // Правило пользователя 2026-06-14:
    //   • Если старая фиксация ещё активна — merge (просто отдаём existingClient).
    //   • Если старая закрыта (любая причина: 142/143/CANCELLED/EXPIRED) —
    //     создаём НОВЫЙ Client + НОВЫЙ amo лид со ссылкой на старую карточку.
    //
    // amoVerdict = null → не можем проверить, fallback на локальный статус:
    //   CONDITIONALLY_UNIQUE + uniquenessExpiresAt > now → считаем активной.
    const localActive =
      existingClient.uniquenessStatus === UniquenessStatus.CONDITIONALLY_UNIQUE &&
      !!existingClient.uniquenessExpiresAt &&
      new Date(existingClient.uniquenessExpiresAt) > new Date();
    const amoSaysOldClosed =
      !!amoVerdict && (amoVerdict.rule === 'RULE_3' || amoVerdict.rule === 'NO_CONFLICT');

    if (!amoSaysOldClosed && localActive) {
      // amo упал, но локально фиксация активна. Создаём отдельный Client
      // на повторную фиксацию (без amoLeadId — amo сам не доступен), чтобы
      // брокер видел свою заявку в кабинете. Никаких диалогов «всё равно
      // создать?». 2026-06-14: раньше тут был тихий merge (return existingClient),
      // но брокер не видел повторную попытку в списке.
      const refixClient = await this.prisma.client.create({
        data: {
          brokerId,
          responsibleBrokerId: responsibleBroker.id,
          phone: data.phone,
          fullName: data.fullName,
          email: data.email || null,
          comment: data.comment,
          project: data.project as any,
          fixationAgencyId: agency.id,
          uniquenessStatus: UniquenessStatus.CONDITIONALLY_UNIQUE,
          uniquenessExpiresAt: new Date(Date.now() + msInDays(UNIQUENESS_DAYS)),
          uniquenessReason: 'Повторная фиксация (amoCRM недоступен, синхронизируется позже)',
          ...fixationFormFields,
        },
      });
      try {
        await this.logAudit(brokerId, 'CLIENT_FIXATION', 'Client', refixClient.id, {
          scenario: 'REFIX_AMO_DOWN',
          phone: data.phone,
          previousClientId: existingClient.id,
        });
      } catch (e: any) {
        console.error('[fixClient refix-merge] audit failed:', e?.message || e);
      }
      return {
        client: refixClient,
        status: 'CONDITIONALLY_UNIQUE',
        message: 'Клиент зафиксирован повторно. Синхронизация с amoCRM произойдёт автоматически.',
      };
    }

    // Старая закрыта (или не активна локально + amo не подтверждает активность).
    // Создаём НОВЫЙ Client + НОВЫЙ amo лид с ссылкой на старую карточку.
    const previousLeadId = existingClient.amoLeadId ? Number(existingClient.amoLeadId) : undefined;
    const previousFixDate = existingClient.createdAt
      ? new Date(existingClient.createdAt).toLocaleDateString('ru-RU')
      : '';
    const previousLeadInfoParts: string[] = [];
    if (previousFixDate) previousLeadInfoParts.push(`фиксация от ${previousFixDate}`);
    if (amoVerdict?.rule === 'RULE_3') {
      previousLeadInfoParts.push('закрыт в amoCRM');
    } else if (existingClient.uniquenessStatus !== UniquenessStatus.CONDITIONALLY_UNIQUE) {
      previousLeadInfoParts.push(`статус ${existingClient.uniquenessStatus}`);
    }
    const previousLeadInfo = previousLeadInfoParts.join(', ') || undefined;

    const newClient = await this.prisma.client.create({
      data: {
        brokerId,
        responsibleBrokerId: responsibleBroker.id,
        phone: data.phone,
        fullName: data.fullName,
        email: data.email || null,
        comment: data.comment,
        project: data.project as any,
        fixationAgencyId: agency.id,
        uniquenessStatus: UniquenessStatus.CONDITIONALLY_UNIQUE,
        uniquenessExpiresAt: new Date(Date.now() + msInDays(UNIQUENESS_DAYS)),
        uniquenessReason: previousLeadId
          ? `Повторная фиксация. Предыдущий лид #${previousLeadId} (${previousLeadInfo || 'закрыт'})`
          : 'Повторная фиксация после закрытой',
        ...fixationFormFields,
      },
    });

    const refixCommentParts: string[] = [];
    if (data.propertyType) refixCommentParts.push(`Тип: ${data.propertyType}`);
    if (data.roomsCount) refixCommentParts.push(`Комнат: ${data.roomsCount}`);
    if (data.sqm) refixCommentParts.push(`Метраж: ${data.sqm} м²`);
    if (data.amount) refixCommentParts.push(`Бюджет: ${data.amount.toLocaleString('ru-RU')} ₽`);
    if (data.comment) refixCommentParts.unshift(data.comment);
    const refixFullComment = refixCommentParts.join('. ');

    let amoSyncOk = true;
    let amoSyncError: string | null = null;
    let createdAmoLeadId: number | null = null;
    try {
      // 2026-06-19: responsibleBroker — для координатора выбранный реальный,
      // для обычного брокера = он сам.
      const resultLead = await this.amoCrmAdapter.createFixationRequest({
        clientPhone: data.phone,
        clientEmail: data.email,
        clientName: data.fullName,
        clientRegion: data.clientRegion,
        presentationSent: data.presentationSent,
        brokerPhone: responsibleBroker.phone,
        brokerAmoContactId: responsibleBroker.amoContactId ? Number(responsibleBroker.amoContactId) : undefined,
        agencyName: agency.name,
        agencyInn: agency.inn,
        comment: refixFullComment,
        project: data.project as Project,
        propertyType: data.propertyType,
        roomsCount: data.roomsCount,
        amount: data.amount,
        sqm: data.sqm,
        purchaseTiming: data.purchaseTiming,
        readinessLevel: data.readinessLevel,
        fromBroker: true,
        previousLeadId,
        previousLeadInfo,
      });
      createdAmoLeadId = resultLead?.id ? Number(resultLead.id) : null;
    } catch (e: any) {
      amoSyncOk = false;
      amoSyncError = String(e?.message || e).slice(0, 500);
      console.error('[fixClient refix] amo createFixationRequest failed:', amoSyncError);
    }

    try {
      await this.prisma.client.update({
        where: { id: newClient.id },
        data: {
          amoSyncStatus: amoSyncOk ? 'SYNCED' : 'FAILED',
          amoSyncError: amoSyncOk ? null : amoSyncError,
          amoSyncAttempts: { increment: 1 },
          amoSyncLastAttemptAt: new Date(),
          ...(createdAmoLeadId ? { amoLeadId: BigInt(createdAmoLeadId) } : {}),
        } as any,
      });
    } catch (e: any) {
      console.error('[fixClient refix] failed to update amoSyncStatus:', e?.message || e);
    }

    if (amoSyncOk && createdAmoLeadId) {
      const morekitUrl = await getSystemSetting(this.prisma, 'MOREKIT_WEBHOOK_URL');
      if (morekitUrl) {
        this.morekit.notifyFixation({
          id: String(createdAmoLeadId),
          agency: agency.name,
          broker_id: responsibleBroker.amoContactId ? String(responsibleBroker.amoContactId) : '',
          agent_name: responsibleBroker.fullName,
          agent_phone: morekitPhone(responsibleBroker.phone),
          agent_mail: responsibleBroker.email || '',
          budget: data.amount ? String(data.amount) : '0',
          clients: [{ name: data.fullName, phone: morekitPhone(data.phone) }],
          type: data.propertyType || 'Квартира',
          lead_date: morekitLeadDate(),
          project: morekitProjectName(String(data.project)),
        }, morekitUrl).catch((e) => console.error('[fixClient refix] morekit notify error:', e?.message || e));
        // 2026-06-16: refix-after-closed создаёт НОВЫЙ лид — синкаем
        // responsible как и при первичной фиксации.
        this.amoCrmAdapter
          .syncLeadResponsibleFromLatestTask(createdAmoLeadId)
          .catch((e) => console.error('[fixClient refix] sync lead responsible error:', e?.message || e));
      }
    }

    try {
      await this.logAudit(brokerId, 'CLIENT_FIXATION', 'Client', newClient.id, {
        scenario: 'REFIX_AFTER_CLOSED',
        phone: data.phone,
        previousClientId: existingClient.id,
        previousLeadId,
        amoLeadId: createdAmoLeadId,
        amoSyncOk,
      });
    } catch (e: any) {
      console.error('[fixClient refix] audit failed:', e?.message || e);
    }

    let managerContacts: any = undefined;
    if (!amoSyncOk) {
      try { managerContacts = await this.getManagerContacts(); }
      catch (e: any) { console.error('[fixClient refix] getManagerContacts failed:', e?.message || e); }
    }

    return {
      client: newClient,
      status: 'CONDITIONALLY_UNIQUE',
      amoSyncStatus: amoSyncOk ? 'SYNCED' : 'FAILED',
      message: amoSyncOk
        ? `Создана новая фиксация со ссылкой на предыдущую (${previousFixDate || 'закрыта'}). Истекает через 30 дней.`
        : 'Создана новая фиксация, но не передана в amoCRM. Менеджеры уведомлены.',
      managerContacts,
    };
  }

  /**
   * 2026-06-11: Обработка RULE_1 / RULE_2 — выделено из fixClient чтобы
   * срабатывать и для путей с existingClient (повторная фиксация того же
   * брокера) и без него (новая фиксация). Раньше эта логика была вшита
   * внутрь `if (!existingClient) {...}` — в результате при повторной
   * фиксации того же клиента тем же брокером duplicate-confirmation flow
   * создавал дубль amoCRM-лида минуя проверку amoVerdict.
   *
   * Что делает:
   *   - existingClient есть → возвращаем его БЕЗ изменения статуса (брокер
   *     не должен видеть «На проверке» если просто переподал свою же фиксацию).
   *   - existingClient нет → создаём новый Client UNDER_REVIEW.
   *   - На стороне amoCRM (target = trigger lead):
   *     • RULE_1: прикрепить нового брокера контактом (POST /leads/{id}/link)
   *     • Обоим правилам: длинная нота с заявкой + alarm-задача на ответственного триггер-лида
   */
  private async handleRule1Or2Alarm(params: {
    amoVerdict: {
      rule: 'RULE_1' | 'RULE_2' | 'RULE_3' | 'NO_CONFLICT' | 'RULE_EXCEPTION_AFTER_SALES_MEETING' | 'RULE_REJECT_SALES_DEAL';
      reason: string;
      contactId?: number;
      leads?: any[];
      triggerLeadId?: number;
    };
    data: any;
    broker: any;
    responsibleBroker: any;
    agency: any;
    brokerId: string;
    existingClient: any | null;
    fixationFormFields: any;
  }): Promise<any> {
    const { amoVerdict, data, broker, responsibleBroker, agency, brokerId, existingClient, fixationFormFields } = params;

    // 2026-06-14: для RULE_1 (старый лид в КЦ до «Встреча проведена») новый
    // брокер видит в кабинете «Уникален» — оба брокера могут параллельно
    // фиксировать клиента, пока встреча не проведена. КЦ всё равно получает
    // прикрепление контактом + ALARM-задачу. Для RULE_2 поведение прежнее
    // («На проверке»).
    //
    // 2026-06-14 fix-2: КАЖДАЯ попытка фиксации создаёт отдельную запись
    // Client — даже повторная от того же брокера. Раньше при существующем
    // existingClient мы возвращали его как есть, и брокер не видел вторую
    // попытку в списке кабинета (хотя в amoCRM прилетал второй ALARM).
    //
    // 2026-06-15 fix-3: повторным Client ОБЯЗАТЕЛЬНО ставим amoLeadId =
    // triggerLeadId.
    //
    // 2026-06-17: для RULE_2 (КЦ 62907286 «Встреча назначена») вводим
    // маркер RULE_2_KC_PENDING — он защищает Client от лифта в webhook
    // PR #148 (attached → CONDITIONALLY_UNIQUE). Лифт сработает только
    // когда КЦ продвинет лид к 142 «Встреча проведена» (и брокер всё
    // ещё прикреплён). Это даёт КЦ время разобраться: проигравшего
    // отдетачить (тогда он → REJECTED), победителя оставить.
    const isRule1 = amoVerdict.rule === 'RULE_1';
    const isRule2Kc =
      amoVerdict.rule === 'RULE_2' &&
      Array.isArray(amoVerdict.leads) &&
      amoVerdict.leads.some(
        (l: any) => l.id === amoVerdict.triggerLeadId && l.pipeline_id === 7600542 && l.status_id === 62907286,
      );
    const triggerLeadIdNum = amoVerdict.triggerLeadId ? Number(amoVerdict.triggerLeadId) : null;
    const baseReason = existingClient
      ? `Повторная фиксация. ${amoVerdict.reason}`
      : `АЛАРМ из amoCRM: ${amoVerdict.reason}`;
    const reasonWithMarker = isRule2Kc
      ? `RULE_2_KC_PENDING:${triggerLeadIdNum || ''} ${baseReason}`
      : baseReason;
    const client = await this.prisma.client.create({
      data: {
        brokerId,
        responsibleBrokerId: responsibleBroker.id,
        phone: data.phone,
        fullName: data.fullName,
        email: data.email || null,
        comment: data.comment,
        project: data.project as any,
        fixationAgencyId: agency?.id,
        uniquenessStatus: isRule1
          ? UniquenessStatus.CONDITIONALLY_UNIQUE
          : UniquenessStatus.UNDER_REVIEW,
        ...(isRule1 && {
          uniquenessExpiresAt: new Date(Date.now() + msInDays(UNIQUENESS_DAYS)),
        }),
        ...(triggerLeadIdNum && { amoLeadId: BigInt(triggerLeadIdNum) }),
        uniquenessReason: reasonWithMarker,
        ...fixationFormFields,
      },
    });

    try {
      await this.logAudit(brokerId, 'CLIENT_FIXATION_CONFLICT', 'Client', client.id, {
        scenario: 'AMO_UNIQUENESS_ALARM',
        amoReason: amoVerdict.reason,
        amoContactId: amoVerdict.contactId,
        amoLeads: amoVerdict.leads,
        isDuplicateFixation: !!existingClient,
      });
    } catch (e: any) {
      console.error('[handleRule1Or2Alarm] audit failed:', e?.message || e);
    }

    if (amoVerdict.leads && amoVerdict.leads.length > 0) {
      const targetLead =
        amoVerdict.leads.find((l: any) => l.id === amoVerdict?.triggerLeadId) ||
        amoVerdict.leads[0];
      const projectName = ({ ZORGE9: 'Зорге 9', SILVER_BOR: 'Берзарина 37' } as Record<string, string>)[String(data.project)] || String(data.project);

      // 2026-06-17: если триггер-лид в воронке продаж (например, sales
      // «Встреча назначена» 62907158) — не пишем туда ничего. Правило
      // от 15.06 «воронку продаж не трогаем» + уточнение 17.06: аларм
      // создаётся только в КЦ-карточках 62907286. Client всё равно
      // получит UNDER_REVIEW (уже создан выше).
      const targetIsSalesPipeline = (
        targetLead.pipeline_id === 7600546 ||  // Берзарина
        targetLead.pipeline_id === 7600550 ||  // Зорге9
        targetLead.pipeline_id === 7600554     // Толбухина
      );
      if (targetIsSalesPipeline) {
        console.log(`[handleRule1Or2Alarm] targetLead ${targetLead.id} в sales-pipeline ${targetLead.pipeline_id} — пропускаем amo-записи (note/task/link)`);
        return {
          client,
          status: isRule1 ? 'CONDITIONALLY_UNIQUE' : 'UNDER_REVIEW',
          message: isRule1
            ? `Клиент зафиксирован. КЦ уведомлены о параллельной фиксации.`
            : `Клиент требует ручной проверки КЦ. ${amoVerdict.reason}`,
        };
      }

      // Повторная фиксация ТЕМ ЖЕ брокером — он уже на лиде, не делаем
      // повторный POST /leads/{id}/link (amo всё равно идемпотентно вернёт
      // успех, но семантически бессмысленно).
      //
      // 2026-06-17: для RULE_2 КЦ MEETING_SCHEDULED (62907286) тоже
      // прикрепляем брокера B контактом — чтобы КЦ-менеджер сразу видел
      // в карточке всех претендентов. Маркер RULE_2_KC_PENDING защищает
      // от автолифта в webhook.
      // 2026-06-19: к лиду цепляем РЕАЛЬНОГО брокера (responsibleBroker),
      // а не координатора. Для обычного брокера responsibleBroker = он сам.
      const isSameBrokerRefix = !!(existingClient && existingClient.brokerId === brokerId);
      const shouldAttach = (isRule1 || isRule2Kc) && responsibleBroker.amoContactId && !isSameBrokerRefix;
      if (shouldAttach) {
        try {
          await this.amoCrmAdapter.linkContactToLead(
            targetLead.id,
            Number(responsibleBroker.amoContactId),
          );
          console.log(`[handleRule1Or2Alarm] брокер ${responsibleBroker.amoContactId} прикреплён к лиду ${targetLead.id} (rule=${amoVerdict.rule})`);
        } catch (e: any) {
          console.error(`[handleRule1Or2Alarm] linkContactToLead failed для лида ${targetLead.id}:`, e?.message || e);
        }
      }

      // 2026-06-14: заголовок ноты зависит от того, кто фиксирует —
      // ДРУГОЙ брокер пришёл на чужого клиента (новый контакт на лиде)
      // ИЛИ тот же брокер заново подал заявку (нужно КЦ уведомление,
      // но это не «новый брокер» — текст другой).
      // 2026-07-03: отдельная ветка для «Фиксирую на другого брокера» —
      // creator (А, broker) и executor (Б, responsibleBroker) разные, но
      // с точки зрения brokerId у клиента это тот же А. Раньше это
      // попадало в isSameBrokerRefix и в ноте писалось «повторная
      // фиксация тем же брокером», что вводило КЦ в заблуждение.
      const isDelegatedRefix = isSameBrokerRefix && responsibleBroker.id !== broker.id;
      const lines: string[] = [];
      if (isDelegatedRefix) {
        lines.push(`⚠️ АЛАРМ — брокер ${broker.fullName} фиксирует уникальность на клиента через брокера ${responsibleBroker.fullName} (делегирование).`);
      } else if (isSameBrokerRefix) {
        lines.push(`⚠️ АЛАРМ — повторная фиксация ТЕМ ЖЕ брокером на этого клиента.`);
      } else if (isRule1) {
        lines.push(`⚠️ АЛАРМ — новый брокер на этом клиенте. Прикреплён к лиду контактом.`);
      } else {
        lines.push(`⚠️ ПОДТВЕРДИТЬ УНИКАЛЬНОСТЬ — клиент уже активен в этом или другом лиде`);
      }
      lines.push(`Причина: ${amoVerdict.reason}`);
      lines.push(``);
      lines.push(`Клиент: ${data.fullName}`);
      lines.push(`Телефон: ${data.phone}`);
      if (data.email) lines.push(`Email: ${data.email}`);
      lines.push(``);
      lines.push(`Проект: ${projectName}`);
      if (data.propertyType) lines.push(`Тип: ${data.propertyType}`);
      if (data.roomsCount) lines.push(`Комнат: ${data.roomsCount}`);
      if (data.sqm) lines.push(`Метраж: ${data.sqm} м²`);
      if (data.amount) lines.push(`Бюджет: ${data.amount.toLocaleString('ru-RU')} ₽`);
      if (data.purchaseTiming) lines.push(`Планирует покупку: ${data.purchaseTiming}`);
      if (data.readinessLevel) lines.push(`Готовность к сделке: ${data.readinessLevel}`);
      lines.push(``);
      // 2026-06-19: для координатора пишем РЕАЛЬНОГО брокера, плюс кто
      // фактически нажал submit (если это разные люди).
      lines.push(`Брокер-агент: ${responsibleBroker.fullName} (${responsibleBroker.phone})`);
      if (broker.id !== responsibleBroker.id) {
        lines.push(`Подал координатор: ${broker.fullName} (${broker.phone})`);
      }
      lines.push(`Агентство: ${agency.name} (ИНН ${agency.inn})`);
      if (data.comment) {
        lines.push(``);
        lines.push(`Комментарий брокера: ${data.comment}`);
      }
      console.log(`[handleRule1Or2Alarm] пишу alarm-нота + задача в КЦ-лид ${targetLead.id} (pipeline=${targetLead.pipeline_id} status=${targetLead.status_id})`);
      try {
        await this.amoCrmAdapter.addNoteToLead(targetLead.id, lines.join('\n'));
        console.log(`[handleRule1Or2Alarm] note записана в лид ${targetLead.id}`);
      } catch (e: any) {
        console.error(`[handleRule1Or2Alarm] note failed для лида ${targetLead.id}:`, e?.message || e);
      }

      // 2026-07-06: КЦ попросил обычную зелёную задачу «Звонок» (taskTypeId=1)
      // вместо кастомного розового «Аларм» (2393839) — читается легче,
      // не пугает. Env AMO_ALARM_TASK_TYPE_ID оставлен как override, если
      // понадобится вернуть красный вид.
      const ALARM_TASK_TYPE_ID = Number(process.env.AMO_ALARM_TASK_TYPE_ID || 1);
      const taskText = isDelegatedRefix
        ? `Делегированная фиксация: ${broker.fullName} (${broker.phone}) оформил уникальность на клиента ${data.fullName} (${data.phone}) на брокера ${responsibleBroker.fullName} (${responsibleBroker.phone}). Проверить, нужно ли вмешательство КЦ.`
        : isSameBrokerRefix
          ? `Повторная фиксация тем же брокером — ${responsibleBroker.fullName} (${responsibleBroker.phone}) ещё раз подал клиента ${data.fullName} (${data.phone}). Проверить, нужно ли вмешательство КЦ.`
          : isRule1
            ? `Новый брокер на клиенте ${data.fullName} (${data.phone}). Брокер ${responsibleBroker.fullName} (${responsibleBroker.phone}) прикреплён к лиду контактом.`
            : `Подтвердить уникальность — клиент ${data.fullName} (${data.phone}) уже в активной стадии, новый брокер ${responsibleBroker.fullName} (${responsibleBroker.phone}) пытается зафиксировать.`;
      try {
        let leadResponsibleUserId: number | undefined;
        try {
          const fullLead = await this.amoCrmAdapter.getLead(targetLead.id);
          leadResponsibleUserId = (fullLead as any)?.responsible_user_id;
        } catch (e: any) {
          console.warn('[handleRule1Or2Alarm] getLead failed, fallback:', e?.message || e);
        }
        const envFallback = process.env.AMO_DEFAULT_RESPONSIBLE_USER_ID;
        const taskResponsibleUserId = leadResponsibleUserId
          || (envFallback ? Number(envFallback) : undefined);
        await this.amoCrmAdapter.createTask({
          text: taskText,
          entityType: 'leads',
          entityId: targetLead.id,
          taskTypeId: ALARM_TASK_TYPE_ID,
          completeTillSec: Math.floor(Date.now() / 1000) + 30 * 60,
          responsibleUserId: taskResponsibleUserId,
        });
      } catch (e: any) {
        console.error('[handleRule1Or2Alarm] task failed:', e?.message || e);
      }
    }

    return {
      client,
      status: isRule1 ? 'CONDITIONALLY_UNIQUE' : 'UNDER_REVIEW',
      message: existingClient
        ? `Клиент зафиксирован повторно. КЦ уведомлены о вашем запросе.`
        : (isRule1
          ? `Клиент зафиксирован. КЦ уведомлены о параллельной фиксации.`
          : `Клиент требует ручной проверки КЦ. ${amoVerdict.reason}`),
    };
  }

  async getClients(
    brokerId: string,
    query: {
      page?: number;
      limit?: number;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      status?: string;
      project?: string;
      search?: string;
    },
  ) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const skip = (page - 1) * limit;

    // 2026-06-29: брокер видит свои клиенты (brokerId == свой) И клиенты,
    // которых ему назначили координатором (responsibleBrokerId == свой,
    // brokerId != свой). До этой правки responsibleBroker не видел клиентов
    // которые ему назначил координатор — это был баг.
    const ownershipFilter: any = {
      OR: [
        { brokerId },
        { responsibleBrokerId: brokerId },
      ],
    };
    const where: any = { ...ownershipFilter };
    if (query.status) where.uniquenessStatus = query.status;
    if (query.project) where.project = query.project;
    if (query.search) {
      // 2026-06-29: phone-поиск через нормализацию (см. brokers-import.helper).
      // "8925" и "+7925" дают одинаковый результат.
      // Search OR должен идти ВНУТРИ AND с ownership-фильтром, иначе нарушим
      // ownership (брокер увидит чужих клиентов с похожим телефоном).
      where.AND = [
        ownershipFilter,
        { OR: [
          { fullName: { contains: query.search, mode: 'insensitive' } },
          ...buildPhoneSearchConditions(query.search),
        ]},
      ];
      delete where.OR;
    }

    const orderBy: any = {};
    orderBy[query.sortBy || 'createdAt'] = query.sortOrder || 'desc';

    const [clients, total] = await Promise.all([
      this.prisma.client.findMany({
        where,
        include: {
          deals: { select: { id: true, status: true, amount: true } },
          // 2026-06-29: тянем broker и responsibleBroker — нужны для
          // подписи «Завёл координатор X» / «Зафиксировано на Y» в UI.
          broker: { select: { id: true, fullName: true, phone: true, isCoordinator: true } },
          responsibleBroker: { select: { id: true, fullName: true, phone: true } },
        },
        skip,
        take: limit,
        orderBy,
      }),
      this.prisma.client.count({ where }),
    ]);

    return {
      clients,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // 2026-06-19: список брокеров для выбора «реального ответственного» в
  // форме фиксации у координатора.
  // 2026-06-29 (правка): координатор может выбирать брокера из ЛЮБОГО
  // агентства, не только своего. Плюс поиск по телефону теперь работает
  // через нормализацию: «8925…», «+7925…», «79255724188» — все одинаково
  // находят брокера с phone='+79255724188' в БД.
  async getAgencyColleagues(currentBrokerId: string, search: string) {
    const me = await this.prisma.broker.findUnique({
      where: { id: currentBrokerId },
      select: { id: true },
    });
    if (!me) return { brokers: [] };

    const searchTrim = (search || '').trim();
    const where: any = {
      status: 'ACTIVE',
      // Сам себя в списке тоже показываем — координатор может зафиксировать
      // и на себя через тот же интерфейс. Фронт сам помечает «это вы».
    };
    if (searchTrim.length >= 2) {
      where.OR = [
        { fullName: { contains: searchTrim, mode: 'insensitive' } },
        // 2026-06-29: используем единый helper (см. brokers-import.helper).
        ...buildPhoneSearchConditions(searchTrim),
      ];
    }
    const brokers = await this.prisma.broker.findMany({
      where,
      select: { id: true, fullName: true, phone: true, isCoordinator: true },
      orderBy: { fullName: 'asc' },
      take: 50,
    });
    return { brokers };
  }

  // 2026-06-29 (refactor): список агентств брокера для формы «создать
  // нового брокера» при фиксации. Доступно любому брокеру — флаг
  // координатора убран по решению заказчика.
  async getMyAgencies(currentBrokerId: string) {
    const me = await this.prisma.broker.findUnique({
      where: { id: currentBrokerId },
      select: {
        brokerAgencies: {
          select: {
            isPrimary: true,
            agency: { select: { id: true, name: true, inn: true } },
          },
        },
      },
    });
    if (!me) return { agencies: [] };
    const agencies = me.brokerAgencies.map((ba) => ({
      id: ba.agency.id,
      name: ba.agency.name,
      inn: ba.agency.inn,
      isPrimary: ba.isPrimary,
    }));
    return { agencies };
  }

  // 2026-06-29 (refactor): любой брокер может создать нового брокера
  // прямо из формы фиксации (раздел «Брокер» с вариантом «на другого»).
  // Новый привязывается к выбранному агентству создателя. Если брокер
  // с этим номером уже существует — молча возвращаем его (вариант
  // согласованный с заказчиком).
  async createBrokerByCreator(
    creatorId: string,
    data: { fullName: string; phone: string; email?: string },
  ) {
    // 2026-07-01: agencyId и customInn убраны — новый брокер автоматически
    // привязывается к PRIMARY агентству того кто фиксирует.
    const creator = await this.prisma.broker.findUnique({
      where: { id: creatorId },
      select: {
        id: true,
        fullName: true,
        brokerAgencies: {
          include: { agency: { select: { id: true, name: true, inn: true } } },
          orderBy: { isPrimary: 'desc' },
        },
      },
    });
    if (!creator) throw new NotFoundException('Creator not found');

    // 2026-07-02: дубль по телефону ИЛИ по email → молча возвращаем existing.
    // Раньше email давал 400 → блокировало фиксацию. Теперь одинаково с телефоном:
    // если брокер уже есть в системе, просто используем его как ответственного
    // (как и написано в подсказке под формой — «Если брокер с этим номером уже
    // зарегистрирован — заявка автоматически уйдёт на него»).
    const existingByPhone = await this.prisma.broker.findUnique({
      where: { phone: data.phone },
      select: { id: true, fullName: true, phone: true, email: true, isCoordinator: true },
    });
    if (existingByPhone) {
      return { broker: existingByPhone, created: false };
    }
    if (data.email) {
      const existingByEmail = await this.prisma.broker.findFirst({
        where: { email: data.email },
        select: { id: true, fullName: true, phone: true, email: true, isCoordinator: true },
      });
      if (existingByEmail) {
        return { broker: existingByEmail, created: false };
      }
    }

    // Primary агентство creator — сначала isPrimary=true, потом первое.
    const primaryLink = creator.brokerAgencies.find((ba) => ba.isPrimary) || creator.brokerAgencies[0];
    if (!primaryLink) {
      throw new BadRequestException({
        message: 'У вас не привязано агентство — сначала укажите ИНН агентства в профиле',
      });
    }
    const agency = primaryLink.agency;
    if (!agency) throw new NotFoundException('Primary agency not found');

    // 2026-07-01: сначала создаём Broker в БД + BrokerAgency, потом
    // единый amo-синк через brokerToAmoContactFields (все 13 полей,
    // без дублей контакта по phone), потом отдельно лид в воронке.
    const broker = await this.prisma.broker.create({
      data: {
        phone: data.phone,
        fullName: data.fullName,
        email: data.email || null,
        status: 'PENDING' as any,
        source: 'BROKER_CABINET',
      },
    });
    await this.prisma.brokerAgency.create({
      data: { brokerId: broker.id, agencyId: agency.id, isPrimary: true },
    });

    // Синк контакта в amoCRM. Ищем по phone → если есть, обновляем; если
    // нет, создаём. Дубля контакта не будет. Все 13 полей передаются
    // через brokerToAmoContactFields.
    let amoContactId: number | undefined;
    try {
      const brokerWithAgency = await this.prisma.broker.findUnique({
        where: { id: broker.id },
        include: {
          brokerAgencies: { where: { isPrimary: true }, include: { agency: true }, take: 1 },
        },
      });
      if (brokerWithAgency) {
        const primaryAgency = brokerWithAgency.brokerAgencies[0]?.agency || null;
        const customFields = brokerToAmoContactFields(brokerWithAgency, primaryAgency);
        const payload = { name: brokerWithAgency.fullName, custom_fields_values: customFields } as any;

        const existingAmo = await this.amoCrmAdapter.findBrokerContactByPhone(data.phone);
        if (existingAmo) {
          amoContactId = existingAmo.id;
          await this.amoCrmAdapter.updateContact(existingAmo.id, payload);
        } else {
          const created = await this.amoCrmAdapter.createContact(payload);
          if (created?.id) amoContactId = created.id;
        }

        if (amoContactId) {
          await this.prisma.broker.update({
            where: { id: broker.id },
            data: { amoContactId: BigInt(amoContactId) },
          });
        }
      }
    } catch (e: any) {
      console.error('[createBrokerByCreator] amo contact sync failed:', e?.message || e);
    }

    // Отдельно: лид в воронке брокеров + note + задача КЦ.
    // Название лида — «{новый брокер} (завёл {creator})» — чтобы КЦ
    // сразу видел откуда лид. Задача КЦ создаётся ВСЕГДА, даже если
    // контакт уже был в amoCRM.
    try {
      await this.amoCrmAdapter.createBrokerLeadFromLanding({
        brokerName: data.fullName,
        brokerPhone: data.phone,
        brokerEmail: data.email || null,
        source: 'FIXATION_BY_OTHER_BROKER',
        note: `Брокера зарегистрировал партнёр ${creator.fullName}. Агентство: ${agency.name} (ИНН ${agency.inn}).`,
        existingContactId: amoContactId,
        leadName: `${data.fullName} (завёл ${creator.fullName})`,
      });
    } catch (e: any) {
      console.error('[createBrokerByCreator] amo lead+task failed:', e?.message || e);
    }

    // Аудит: брокер завёл другого брокера.
    try {
      await this.logAudit(creatorId, 'BROKER_CREATE_BROKER', 'Broker', broker.id, {
        creatorName: creator.fullName,
        agencyId: agency.id,
        agencyName: agency.name,
        phone: data.phone,
      });
    } catch (e: any) {
      console.error('[createBrokerByCreator] audit failed:', e?.message || e);
    }

    // Welcome-email с приглашением через очередь нотификаций (если email есть).
    if (data.email) {
      try {
        await this.notificationQueue.add('email', {
          to: data.email,
          subject: 'Вас зарегистрировали в St Michael',
          body: `Здравствуйте, ${data.fullName}!\n\n`
            + `Вас зарегистрировал партнёр агентства "${agency.name}" — ${creator.fullName}.\n\n`
            + `Чтобы войти в личный кабинет:\n`
            + `1. Перейдите на https://broker.stmichael.ru/forgot-password\n`
            + `2. Введите ваш телефон ${data.phone}\n`
            + `3. На этот email придёт ссылка для установки пароля\n`
            + `4. После установки пароля войдите на https://broker.stmichael.ru/login\n\n`
            + `Если возникнут вопросы — горячая линия отдела партнёров: +7 (499) 226-22-49 (ежедневно с 9:00 до 21:00).\n\n`
            + `С уважением,\nкоманда St Michael`,
        });
      } catch (e: any) {
        console.error('[createBrokerByCreator] welcome email enqueue failed:', e?.message || e);
      }
    }

    return {
      broker: {
        id: broker.id,
        fullName: broker.fullName,
        phone: broker.phone,
        email: broker.email,
      },
      created: true,
    };
  }

  // 2026-06-29 (refactor): методы getMyCreatedBrokers /
  // resendCoordinatorWelcomeEmail / deleteCreatedBroker удалены вместе
  // со страницей /my-brokers. История доступна в git: PR #194 / #197.

  async getClient(id: string, brokerId: string) {
    const client = await this.prisma.client.findUnique({
      where: { id },
      include: {
        deals: { include: { lot: true, agency: true } },
        meetings: true,
        // 2026-06-29: broker — это тот кто создал заявку (как правило
        // координатор), а responsibleBroker — фактический ответственный
        // (тот, на кого фиксируем). Нужны оба чтобы показать «Завёл я» /
        // «Завёл координатор X» в карточке клиента.
        broker: { select: { id: true, fullName: true, phone: true, isCoordinator: true } },
        responsibleBroker: { select: { id: true, fullName: true, phone: true } },
      },
    });

    if (!client) {
      throw new NotFoundException('Client not found');
    }

    // Brokers can only see their own clients; managers/admins can see all.
    // 2026-06-29: also allow access if I am responsibleBroker (case when
    // a coordinator created this client and assigned me as responsible).
    const iAmOwner = client.brokerId === brokerId;
    const iAmResponsible = client.responsibleBrokerId === brokerId;
    if (!iAmOwner && !iAmResponsible) {
      const requester = await this.prisma.broker.findUnique({ where: { id: brokerId } });
      if (requester?.role === 'BROKER') {
        throw new NotFoundException('Client not found');
      }
    }

    // 2026-05-26: догружаем агентство фиксации (нет prisma-relation на Client,
    // только FK fixationAgencyId — поэтому отдельным запросом).
    let fixationAgency: any = null;
    if (client.fixationAgencyId) {
      fixationAgency = await this.prisma.agency.findUnique({
        where: { id: client.fixationAgencyId },
        select: { id: true, name: true, inn: true, phone: true, email: true },
      });
    }

    // История продления уникальности — из audit log (последние 10).
    let uniquenessHistory: any[] = [];
    try {
      uniquenessHistory = await this.prisma.auditLog.findMany({
        where: {
          entity: 'Client',
          entityId: id,
          action: { in: ['UNIQUENESS_EXTENDED', 'UNIQUENESS_RESOLVED', 'CLIENT_FIXED', 'CLIENT_FIXATION', 'CLIENT_FIXATION_CONFLICT', 'AMO_SYNC_FAILED'] },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, action: true, payload: true, createdAt: true, userId: true },
      });
    } catch (e: any) {
      // не валим, история — необязательно
    }

    return { ...client, fixationAgency, uniquenessHistory };
  }

  async extendUniqueness(id: string, brokerId: string, data: { reason: string; comment?: string }) {
    const client = await this.prisma.client.findUnique({ where: { id } });

    if (!client) throw new NotFoundException('Client not found');
    if (client.brokerId !== brokerId) throw new BadRequestException('Not your client');
    if (client.uniquenessStatus !== UniquenessStatus.CONDITIONALLY_UNIQUE) {
      throw new BadRequestException('Client is not in conditionally unique status');
    }

    await this.prisma.client.update({
      where: { id },
      data: {
        uniquenessExpiresAt: new Date(Date.now() + msInDays(UNIQUENESS_DAYS)),
        uniquenessReason: data.reason,
      },
    });

    await this.logAudit(brokerId, 'UNIQUENESS_EXTENDED', 'Client', id, { reason: data.reason });

    return { message: 'Uniqueness extended successfully' };
  }

  async markFixed(id: string, brokerId: string) {
    const client = await this.prisma.client.findUnique({ where: { id } });
    if (!client) throw new NotFoundException('Client not found');
    if (client.brokerId !== brokerId) throw new BadRequestException('Not your client');

    const updated = await this.prisma.client.update({
      where: { id },
      data: {
        fixationStatus: 'FIXED',
        fixationExpiresAt: new Date(Date.now() + msInDays(UNIQUENESS_DAYS)),
        inspectionActSigned: true,
      },
    });

    await this.logAudit(brokerId, 'CLIENT_FIXED', 'Client', id, {});

    return { client: updated, message: 'Client marked as fixed' };
  }

  async resolveUniqueness(id: string, managerId: string, data: { status: UniquenessStatus; reason: string }) {
    const client = await this.prisma.client.findUnique({ where: { id } });
    if (!client) throw new NotFoundException('Client not found');

    const updated = await this.prisma.client.update({
      where: { id },
      data: {
        uniquenessStatus: data.status,
        uniquenessReason: data.reason,
      },
    });

    // Notify the broker about the resolution
    await this.notificationQueue.add('send', {
      brokerId: client.brokerId,
      channel: 'SMS',
      subject: 'Результат проверки уникальности',
      body: `Решение по клиенту ${client.fullName}: ${data.status === 'CONDITIONALLY_UNIQUE' ? 'одобрено' : 'отклонено'}. ${data.reason}`,
    });

    await this.logAudit(managerId, 'UNIQUENESS_RESOLVED', 'Client', id, {
      status: data.status,
      reason: data.reason,
    });

    return { client: updated, message: 'Uniqueness conflict resolved' };
  }

  async quickFix(data: { clientPhone: string; clientFullName: string; brokerPhone: string }) {
    const normalizePhone = (raw: string) => {
      let p = raw.replace(/[\s\-()'"]/g, '');
      if (p.startsWith('8') && p.length === 11) p = '+7' + p.slice(1);
      if (!p.startsWith('+')) p = '+' + p;
      return p;
    };

    const clientPhone = normalizePhone(data.clientPhone);
    const brokerPhone = normalizePhone(data.brokerPhone);

    // Find broker by phone
    const broker = await this.prisma.broker.findUnique({ where: { phone: brokerPhone } });
    if (!broker) {
      throw new BadRequestException('Брокер с таким телефоном не найден. Зарегистрируйтесь в кабинете.');
    }

    // Check if client already exists for this broker
    const existing = await this.prisma.client.findFirst({
      where: { phone: clientPhone, brokerId: broker.id },
    });
    if (existing) {
      return {
        status: 'EXISTS',
        message: 'Клиент уже зафиксирован за вами',
        clientId: existing.id,
      };
    }

    // Create client with conditional uniqueness
    const client = await this.prisma.client.create({
      data: {
        brokerId: broker.id,
        fullName: data.clientFullName,
        phone: clientPhone,
        project: 'ZORGE9' as any,
        uniquenessStatus: UniquenessStatus.CONDITIONALLY_UNIQUE,
        uniquenessExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        comment: 'Моментальная фиксация с лендинга',
      },
    });

    // Audit
    try {
      await this.logAudit(broker.id, 'QUICK_FIXATION', 'Client', client.id, {
        source: 'landing',
        phone: clientPhone,
      });
    } catch {}

    return {
      status: 'CONDITIONALLY_UNIQUE',
      message: 'Клиент условно зафиксирован на 30 дней',
      clientId: client.id,
    };
  }

  async importClients(brokerId: string, fileBuffer: Buffer) {
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });

    // Find target sheet: "Воронка зорге+берз" or fallback to first
    const targetSheetNames = workbook.SheetNames.filter((n) =>
      n.toLowerCase().includes('воронка') || n.toLowerCase().includes('зорге'),
    );
    const sheetName = targetSheetNames[0] || workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (rows.length === 0) throw new BadRequestException('Лист пустой или не содержит данных');

    const normalize = (key: string) => key.trim().toLowerCase();
    const findCol = (row: any, variants: string[]): string => {
      const keys = Object.keys(row);
      for (const v of variants) {
        const found = keys.find((k) => normalize(k).includes(v));
        if (found) return row[found]?.toString().trim() || '';
      }
      return '';
    };

    const extractPhone = (text: string): string => {
      const match = text.replace(/[\s\-()]/g, '').match(/(\+?[78]\d{10})/);
      return match ? match[1] : '';
    };

    const mapProject = (val: string): string => {
      const v = val.toLowerCase();
      if (v.includes('берзарин') || v.includes('серебр') || v.includes('silver') || v.includes('бор') || v.includes('берз')) return 'SILVER_BOR';
      if (v.includes('зорге') || v.includes('zorge')) return 'ZORGE9';
      return 'ZORGE9';
    };

    const parseExcelDate = (raw: string): Date | undefined => {
      if (!raw) return undefined;
      const num = Number(raw);
      if (!isNaN(num) && num > 10000) return new Date((num - 25569) * 86400 * 1000);
      const parsed = new Date(raw);
      return isNaN(parsed.getTime()) ? undefined : parsed;
    };

    const mapDealStatus = (stage: string, dealFlag: string): any => {
      const s = (stage || '').toLowerCase();
      if (String(dealFlag) === '1' || s.includes('оплач')) return 'PAID';
      if (s.includes('подпис') || s.includes('договор')) return 'SIGNED';
      return 'PENDING';
    };

    const mapMeetingType = (val: string): any => {
      const v = (val || '').toLowerCase();
      if (v.includes('онлайн') || v.includes('online') || v.includes('zoom')) return 'ONLINE';
      if (v.includes('тур') || v.includes('брокер')) return 'BROKER_TOUR';
      return 'OFFICE_VISIT';
    };

    let imported = 0;
    let dealsCreated = 0;
    let meetingsCreated = 0;
    let skipped = 0;
    let excluded = 0;
    const errors: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      const fullName = findCol(row, ['основной контакт', 'контакт', 'фио', 'имя', 'name']);

      let rawPhone = findCol(row, ['рабочий телефон', 'телефон (контакт)', 'телефон', 'phone', 'тел']);
      if (!rawPhone) {
        for (const val of Object.values(row)) {
          const found = extractPhone(String(val || ''));
          if (found) { rawPhone = found; break; }
        }
      }

      const projectRaw = findCol(row, ['объект интереса', 'объект', 'проект', 'project']);
      const dateRaw = findCol(row, ['дата создания', 'дата создан', 'created']);

      const email = findCol(row, ['email', 'почта', 'mail']);
      const comment = findCol(row, ['комментарий', 'comment', 'примечание']);
      const budget = findCol(row, ['бюджет в руб', 'бюджет', 'budget', 'сумма']);
      const dealStage = findCol(row, ['этап сделки', 'этап']);
      const dealReadiness = findCol(row, ['готовность к сделке', 'готовность']);
      const dealCurrentStatus = findCol(row, ['текущий статус работы', 'текущий статус']);
      const dealFlag = findCol(row, ['сделка']);
      const meetingTypeRaw = findCol(row, ['встреча']);
      const meetingTargeted = findCol(row, ['целевая встреча']);
      const meetingDateRaw = findCol(row, ['дата и время встречи']);

      // Skip rows where deal stage is "Закрыто и не реализовано"
      if (dealStage && dealStage.toLowerCase().includes('не реализ')) {
        excluded++;
        continue;
      }

      if (!fullName) {
        errors.push(`Строка ${i + 2}: не заполнено ФИО (Основной контакт)`);
        skipped++;
        continue;
      }

      // Normalize phone
      let phone = '';
      if (rawPhone) {
        phone = rawPhone.replace(/[\s\-()'"]/g, '');
        if (phone.startsWith('8') && phone.length === 11) phone = '+7' + phone.slice(1);
        if (!phone.startsWith('+')) phone = '+' + phone;
      } else {
        phone = `+70000${String(Date.now()).slice(-6)}${i}`;
      }

      const project = mapProject(projectRaw);

      // Parse date
      let createdAt: Date | undefined;
      if (dateRaw) {
        const excelDate = Number(dateRaw);
        if (!isNaN(excelDate) && excelDate > 10000) {
          // Excel serial date
          createdAt = new Date((excelDate - 25569) * 86400 * 1000);
        } else {
          const parsed = new Date(dateRaw);
          if (!isNaN(parsed.getTime())) createdAt = parsed;
        }
      }

      const commentParts = [
        comment,
        dealStage ? `Этап: ${dealStage}` : '',
        dealReadiness ? `Готовность: ${dealReadiness}` : '',
        dealCurrentStatus ? `Статус: ${dealCurrentStatus}` : '',
      ].filter(Boolean);
      const finalComment = commentParts.join('. ') || null;

      try {
        let client = await this.prisma.client.findFirst({ where: { phone, brokerId } });

        if (!client) {
          client = await this.prisma.client.create({
            data: {
              brokerId,
              fullName,
              phone,
              email: email || null,
              comment: finalComment,
              project: project as any,
              uniquenessStatus: UniquenessStatus.CONDITIONALLY_UNIQUE,
              uniquenessExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
              ...(createdAt && { createdAt }),
            },
          });
          imported++;
        } else {
          skipped++;
        }

        // Create Deal if budget present
        const budgetNum = Number(String(budget).replace(/[^\d.]/g, '')) || 0;
        if (budgetNum > 0 || dealStage) {
          const existingDeal = await this.prisma.deal.findFirst({
            where: { clientId: client.id, brokerId },
          });
          if (!existingDeal) {
            await this.prisma.deal.create({
              data: {
                clientId: client.id,
                brokerId,
                project: project as any,
                amount: budgetNum,
                sqm: 0,
                commissionRate: 0,
                commissionAmount: 0,
                status: mapDealStatus(dealStage, dealFlag) as any,
                ...(createdAt && { createdAt }),
              },
            });
            dealsCreated++;
          }
        }

        // Create Meeting if meeting type or date present
        if (meetingTypeRaw || meetingDateRaw) {
          const meetingDate = parseExcelDate(meetingDateRaw) || createdAt || new Date();
          const existingMeeting = await this.prisma.meeting.findFirst({
            where: { clientId: client.id, brokerId, date: meetingDate },
          });
          if (!existingMeeting) {
            await this.prisma.meeting.create({
              data: {
                clientId: client.id,
                brokerId,
                type: mapMeetingType(meetingTypeRaw) as any,
                date: meetingDate,
                comment: meetingTargeted ? `Целевая: ${meetingTargeted}` : null,
              },
            });
            meetingsCreated++;
          }
        }
      } catch (e: any) {
        errors.push(`Строка ${i + 2}: ошибка при сохранении (${fullName})`);
        skipped++;
      }
    }

    return { imported, dealsCreated, meetingsCreated, excluded, skipped, sheet: sheetName, errors: errors.slice(0, 20) };
  }

  private async logAudit(userId: string, action: string, entity: string, entityId: string, payload: any) {
    await this.prisma.auditLog.create({
      data: { userId, action, entity, entityId, payload },
    });
  }

  // 2026-05-25: контакты менеджеров (роль MANAGER) — отдаём брокеру в UI,
  // если фиксация не передалась в amo и брокер хочет позвонить вручную.
  private async getManagerContacts() {
    const managers = await this.prisma.broker.findMany({
      where: { role: 'MANAGER', status: 'ACTIVE' },
      select: { id: true, fullName: true, phone: true, telegramUsername: true },
      orderBy: { fullName: 'asc' },
    });
    return managers.map((m) => ({
      fullName: m.fullName,
      phone: m.phone,
      telegram: m.telegramUsername || null,
    }));
  }

  // 2026-05-25: рассылка алерта менеджерам и координаторам, что заявка не
  // передалась в amo. Уведомляем всех активных MANAGER + isCoordinator=true.
  private async notifyAmoSyncFailed(clientId: string, broker: { fullName: string; phone: string }, clientPhone: string, error: string) {
    const recipients = await this.prisma.broker.findMany({
      where: {
        status: 'ACTIVE',
        OR: [{ role: 'MANAGER' }, { isCoordinator: true }],
      },
      select: { id: true },
    });
    const body = `⚠ Фиксация клиента ${clientPhone} НЕ передана в amoCRM. Брокер: ${broker.fullName} (${broker.phone}). Клиент сохранён в кабинете, нужно вручную создать лид или дождаться авто-ретрая. Ошибка: ${error.slice(0, 200)}`;
    for (const r of recipients) {
      try {
        await this.notificationQueue.add('send', {
          brokerId: r.id,
          channel: 'TELEGRAM',
          subject: 'amoCRM: фиксация не передана',
          body,
          payload: { clientId, kind: 'AMO_SYNC_FAILED' },
        });
      } catch (e: any) {
        console.error('[notifyAmoSyncFailed] queue add failed:', e?.message || e);
      }
    }
  }
}
