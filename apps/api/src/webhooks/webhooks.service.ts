import { Injectable, Inject, BadRequestException, Logger } from '@nestjs/common';
import { PrismaClient, UniquenessStatus } from '@st-michael/database';
import { AmoCrmAdapter, isSalesPipeline, isSalesExceptionStatus, isSalesDealStatus } from '@st-michael/integrations';
import * as crypto from 'crypto';

const UNIQUENESS_DAYS = 30;
const msInDays = (days: number) => days * 24 * 60 * 60 * 1000;

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  private readonly amo = new AmoCrmAdapter();

  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  private verifyHmac(payload: string, signature: string, secret: string): boolean {
    if (!secret) return true; // Skip verification if no secret configured
    const computed = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
  }

  // ─── amoCRM Lead Update ─────────────────────────────
  // 2026-06-15: amoCRM webhook payload — это НЕ единичный объект лида,
  // а пакетный формат с массивами `leads[update]`, `leads[status]`,
  // `leads[add]`. Тело шлётся как application/x-www-form-urlencoded с
  // вложенными ключами (`leads[update][0][id]=...&leads[update][0][status_id]=...`).
  // Раньше код читал data.id напрямую — и для пакетных webhook'ов это
  // всегда undefined, из-за чего syncBrokerAttachmentFromLead никогда не
  // вызывался → открепление брокера в amoCRM не обновляло статус Client.
  // Теперь обходим все три массива событий и каждое обрабатываем
  // индивидуально.
  async handleAmoLeadUpdate(data: any, headers: any) {
    // 2026-06-16: ВСЕГДА возвращаем 200 OK. amoCRM отключает webhook
    // (disabled=true) если он несколько раз подряд вернул 5xx или
    // connection refused (например, во время деплоя api). Из-за этого
    // полностью разрывается синхронизация прикрепления/открепления
    // брокеров — пришлось вручную пересоздавать через setup-amo-webhook.
    // Теперь любое исключение ловим, логируем, отвечаем 200.
    try {
      const secret = process.env.AMO_WEBHOOK_SECRET || '';
      if (secret && headers['x-amo-signature']) {
        if (!this.verifyHmac(JSON.stringify(data), headers['x-amo-signature'], secret)) {
          this.logger.warn('amoCRM webhook: invalid signature');
          return { status: 'processed', error: 'invalid_signature' };
        }
      }

      // Собираем все события лидов из webhook payload. amoCRM v4 шлёт:
      //   data.leads.add[]    — на создание лида
      //   data.leads.update[] — на любое обновление (включая link/unlink контактов)
      //   data.leads.status[] — на смену статуса
      // Для обратной совместимости с прямыми тестовыми вызовами поддерживаем
      // и старый формат с data.id на верхнем уровне.
      const events: Array<{ id: number; status_id?: number; price?: number; custom_fields?: any[] }> = [];
      const collect = (arr: any) => {
        if (!Array.isArray(arr)) return;
        for (const ev of arr) {
          const id = Number(ev?.id);
          if (!id || isNaN(id)) continue;
          events.push({
            id,
            status_id: ev?.status_id ? Number(ev.status_id) : undefined,
            price: ev?.price ? Number(ev.price) : undefined,
            custom_fields: ev?.custom_fields,
          });
        }
      };
      collect(data?.leads?.update);
      collect(data?.leads?.status);
      collect(data?.leads?.add);
      if (events.length === 0 && data?.id) {
        events.push({
          id: Number(data.id),
          status_id: data.status_id ? Number(data.status_id) : undefined,
          price: data.price ? Number(data.price) : undefined,
          custom_fields: data.custom_fields,
        });
      }

      if (events.length === 0) {
        this.logger.warn(`amoCRM lead webhook: no events extracted from payload keys=[${Object.keys(data || {}).join(',')}]`);
        return { status: 'processed', matched: false, reason: 'no_events' };
      }

      this.logger.log(`amoCRM lead webhook: ${events.length} event(s): ${events.map((e) => `${e.id}/${e.status_id ?? '—'}`).join(', ')}`);

      const results: any[] = [];
      for (const ev of events) {
        try {
          results.push(await this.processLeadEvent(ev));
        } catch (e: any) {
          this.logger.error(`processLeadEvent failed for lead ${ev.id}: ${e?.message || e}`);
          results.push({ leadId: ev.id, error: String(e?.message || e).slice(0, 200) });
        }
      }
      return { status: 'processed', events: results };
    } catch (e: any) {
      this.logger.error(`handleAmoLeadUpdate top-level error: ${e?.message || e}`);
      return { status: 'processed', error: String(e?.message || e).slice(0, 200) };
    }
  }

  private async processLeadEvent(ev: { id: number; status_id?: number; price?: number; custom_fields?: any[] }) {
    // 2026-06-04: при любом изменении лида проверяем, какие контакты
    // привязаны сейчас. Если broker.amoContactId есть в списке — он
    // прикреплён; если нет — открепили и статус Client → REJECTED.
    try {
      await this.syncBrokerAttachmentFromLead(ev.id);
    } catch (e: any) {
      this.logger.error(`syncBrokerAttachmentFromLead failed for lead ${ev.id}: ${e?.message || e}`);
    }

    // Find deal linked to this amoCRM lead
    const deal = await this.prisma.deal.findFirst({
      where: { amoDealId: BigInt(ev.id) },
      include: { client: true },
    });

    if (!deal) {
      // 2026-07-01: раньше здесь записывали в client.comment строку
      // «[timestamp] amoCRM статус: XXX» — как отладочный маркер того,
      // что webhook пришёл, но Deal ещё не создан. Брокер видел эту
      // техническую метку в поле «Комментарий брокера» карточки клиента
      // → отражение и запутывание. Больше не пишем — webhook просто
      // фиксирует что Deal не найден и выходит.
      return { leadId: ev.id, matched: false };
    }

    // Map amoCRM status to deal status
    const statusMap: Record<number, string> = {
      142: 'PENDING',    // Новая сделка
      143: 'SIGNED',     // Подписан договор
      144: 'PAID',       // Оплачен
      145: 'COMMISSION_PAID', // Комиссия выплачена
      146: 'CANCELLED',  // Отменён
    };

    const updateData: any = {};
    if (ev.status_id && statusMap[ev.status_id]) {
      updateData.status = statusMap[ev.status_id];
      if (updateData.status === 'SIGNED') updateData.signedAt = new Date();
      if (updateData.status === 'PAID') updateData.paidAt = new Date();
    }
    if (ev.price && (!deal.amount || Number(deal.amount) === 0)) {
      updateData.amount = ev.price;
      updateData.commissionAmount = (ev.price * Number(deal.commissionRate)) / 100;
    }

    if (Object.keys(updateData).length > 0) {
      await this.prisma.deal.update({ where: { id: deal.id }, data: updateData });
    }

    if (ev.custom_fields && !deal.agencyId) {
      const agencyField = ev.custom_fields.find((f: any) => f.field_name === 'agency_id');
      if (agencyField?.values?.[0]?.value) {
        await this.prisma.deal.update({
          where: { id: deal.id },
          data: { agencyId: agencyField.values[0].value },
        });
      }
    }

    await this.prisma.auditLog.create({
      data: {
        action: 'AMO_LEAD_UPDATE',
        entity: 'Deal',
        entityId: deal.id,
        payload: { amoLeadId: ev.id, statusId: ev.status_id },
      },
    });

    return { leadId: ev.id, dealId: deal.id };
  }

  // ─── amoCRM Contact Update ──────────────────────────
  async handleAmoContactUpdate(data: any, headers: any) {
    const secret = process.env.AMO_WEBHOOK_SECRET || '';
    if (secret && headers['x-amo-signature']) {
      if (!this.verifyHmac(JSON.stringify(data), headers['x-amo-signature'], secret)) {
        throw new BadRequestException('Invalid signature');
      }
    }

    this.logger.log(`amoCRM contact update: contact_id=${data.id}`);

    const broker = await this.prisma.broker.findFirst({
      where: { amoContactId: BigInt(data.id) },
    });

    if (!broker) {
      this.logger.warn(`No broker found for amo contact ${data.id}`);
      return { status: 'processed', matched: false };
    }

    // 2026-05-26: webhook больше НЕ перетирает поля которые админ
    // мог отредактировать в кабинете. Только заполняет пустые.
    // Иначе: админ исправил ФИО / телефон / email в /admin/brokers,
    // а через минуту приходит webhook с старым значением из amo —
    // правка стиралась.
    const updateData: any = {};
    if (data.name && !broker.fullName) updateData.fullName = data.name;

    if (data.custom_fields_values) {
      const phoneField = data.custom_fields_values.find((f: any) => f.field_code === 'PHONE');
      if (phoneField?.values?.[0]?.value && !broker.phone) {
        updateData.phone = phoneField.values[0].value;
      }
      const emailField = data.custom_fields_values.find((f: any) => f.field_code === 'EMAIL');
      if (emailField?.values?.[0]?.value && !broker.email) {
        updateData.email = emailField.values[0].value;
      }
    }

    if (Object.keys(updateData).length > 0) {
      await this.prisma.broker.update({ where: { id: broker.id }, data: updateData });
    }

    return { status: 'processed', brokerId: broker.id };
  }

  // ─── Mango Call Result ──────────────────────────────
  async handleMangoCallResult(data: any, headers: any) {
    const secret = process.env.MANGO_API_SALT || '';
    if (secret && headers['x-mango-sign']) {
      if (!this.verifyHmac(JSON.stringify(data), headers['x-mango-sign'], secret)) {
        throw new BadRequestException('Invalid signature');
      }
    }

    this.logger.log(`Mango call result: call_id=${data.call_id}, status=${data.status}`);

    // Map Mango status
    const statusMap: Record<string, string> = {
      completed: 'COMPLETED',
      no_answer: 'NO_ANSWER',
      busy: 'BUSY',
      unavailable: 'UNAVAILABLE',
      failed: 'FAILED',
    };

    // 1) Прямой матч по mangoCallId — если webhook знает наш command_id
    //    (Mango echoes back наш command_id для callback-команд).
    const callIdCandidate = data.call_id || data.command_id;
    let existingCall = callIdCandidate
      ? await this.prisma.call.findFirst({ where: { mangoCallId: callIdCandidate } })
      : null;

    // 2) Bug fix 2026-06-02: если по mangoCallId не нашлось — может быть,
    //    Mango прислал свой внутренний call_id, отличающийся от нашего
    //    command_id. Тогда ищем недавнюю INITIATED-запись по телефону
    //    брокера. Это позволяет «подвязать» webhook к записи, которую
    //    broker-calls.service создал при initiate.
    if (!existingCall && (data.to_number || data.from_number)) {
      const brokerPhone = data.direction === 'outbound' ? data.from_number : data.to_number;
      if (brokerPhone) {
        const brokerDigits = String(brokerPhone).replace(/\D/g, '').slice(-10);
        const broker = await this.prisma.broker.findFirst({
          where: { phone: { endsWith: brokerDigits } },
        });
        if (broker) {
          existingCall = await this.prisma.call.findFirst({
            where: {
              brokerId: broker.id,
              status: 'INITIATED' as any,
              initiatedAt: { gt: new Date(Date.now() - 10 * 60 * 1000) },
            },
            orderBy: { initiatedAt: 'desc' },
          });
        }
      }
    }

    if (existingCall) {
      await this.prisma.call.update({
        where: { id: existingCall.id },
        data: {
          mangoCallId: existingCall.mangoCallId || callIdCandidate,
          status: (statusMap[data.status] || 'COMPLETED') as any,
          durationSec: data.duration || 0,
          recordingUrl: data.recording_url,
        },
      });
      return { status: 'processed', callId: existingCall.id, action: 'updated' };
    }

    // 3) Старая логика — для звонков, инициированных НЕ из нашего кабинета
    //    (КЦ-обзвон, входящие, ручная инициация из Mango UI):
    //    матчим брокера по номеру и создаём новую запись.
    if (data.to_number || data.from_number) {
      const brokerPhone = data.direction === 'outbound' ? data.from_number : data.to_number;
      const broker = await this.prisma.broker.findFirst({
        where: { phone: brokerPhone },
      });

      if (broker) {
        const call = await this.prisma.call.create({
          data: {
            brokerId: broker.id,
            mangoCallId: callIdCandidate,
            direction: data.direction === 'outbound' ? 'OUTBOUND' : 'INBOUND',
            status: (statusMap[data.status] || 'COMPLETED') as any,
            durationSec: data.duration || 0,
            recordingUrl: data.recording_url,
          },
        });
        return { status: 'processed', callId: call.id, action: 'created' };
      }
    }

    this.logger.warn(`No broker matched for call ${callIdCandidate}`);
    return { status: 'processed', matched: false };
  }

  // ─── Profitbase Lot Update ──────────────────────────
  async handleProfitbaseLotUpdate(data: any, headers: any) {
    const secret = process.env.PROFITBASE_WEBHOOK_SECRET || '';
    if (secret && headers['x-profitbase-sign']) {
      if (!this.verifyHmac(JSON.stringify(data), headers['x-profitbase-sign'], secret)) {
        throw new BadRequestException('Invalid signature');
      }
    }

    this.logger.log(`Profitbase lot update: id=${data.id}, status=${data.status}`);

    const statusMap: Record<string, string> = {
      available: 'AVAILABLE',
      booked: 'BOOKED',
      sold: 'SOLD',
    };

    // Find lot by external ID
    const lot = await this.prisma.lot.findFirst({
      where: { externalId: String(data.id) },
    });

    if (lot) {
      const updateData: any = {};
      if (data.status) updateData.status = statusMap[data.status] || data.status;
      if (data.price) {
        updateData.price = data.price;
        if (lot.sqm) {
          updateData.pricePerSqm = data.price / Number(lot.sqm);
        }
      }

      await this.prisma.lot.update({ where: { id: lot.id }, data: updateData });

      await this.prisma.auditLog.create({
        data: {
          action: 'PROFITBASE_LOT_UPDATE',
          entity: 'Lot',
          entityId: lot.id,
          payload: { externalId: data.id, status: data.status, price: data.price },
        },
      });

      return { status: 'processed', lotId: lot.id, action: 'updated' };
    }

    // Create new lot if not found
    if (data.number && data.building) {
      const newLot = await this.prisma.lot.create({
        data: {
          externalId: String(data.id),
          number: data.number,
          project: data.project || 'ZORGE9',
          building: data.building,
          floor: data.floor || 1,
          rooms: data.rooms || 'Студия',
          sqm: data.sqm || 0,
          price: data.price || 0,
          pricePerSqm: data.sqm ? data.price / data.sqm : 0,
          status: (statusMap[data.status] || 'AVAILABLE') as any,
          layoutUrl: data.layout_url,
          planImageUrl: data.plan_image_url,
          description: data.description,
        },
      });
      return { status: 'processed', lotId: newLot.id, action: 'created' };
    }

    return { status: 'processed', matched: false };
  }

  // ─── Broker attachment sync ─────────────────────────
  // 2026-06-04: запрашиваем у amo актуальный лид (надёжнее чем доверять
  // payload вебхука, который может приходить без _embedded.contacts).
  // Для каждого Client, привязанного к этому лиду:
  //   • если сделка прошла (PAID / COMMISSION_PAID) — брокер закреплён
  //     навсегда, статус не трогаем;
  //   • если у brokers.amoContactId есть в списке контактов лида:
  //       - был REJECTED → восстанавливаем CONDITIONALLY_UNIQUE +30 дней;
  //       - 2026-06-05: был UNDER_REVIEW → CONDITIONALLY_UNIQUE +30 дней
  //         (одобрение от КЦ через прикрепление брокера к лиду в amo);
  //       - иначе оставляем как есть;
  //   • если нет:
  //       - был CONDITIONALLY_UNIQUE → REJECTED («Не уникален»).
  // UNDER_REVIEW при отсутствии брокера остаётся — потому что это
  // дефолтное состояние ALARM-фиксации (брокер ещё не прикреплён).
  // EXPIRED не трогаем — авто-timeout, не должен перетираться.
  private async syncBrokerAttachmentFromLead(leadId: number): Promise<void> {
    if (!leadId) return;

    const lead: any = await this.amo.getLead(leadId).catch(() => null);
    if (!lead) {
      this.logger.warn(`syncBrokerAttachmentFromLead: lead ${leadId} not found in amo`);
      return;
    }
    const leadContactIds: number[] = ((lead?._embedded?.contacts as any[]) || [])
      .map((c) => Number(c.id))
      .filter((id) => !isNaN(id));
    const leadStatusId = Number(lead?.status_id || 0);
    const leadPipelineId = Number(lead?.pipeline_id || 0);

    const clients = await this.prisma.client.findMany({
      where: { amoLeadId: BigInt(leadId) },
      include: {
        broker: { select: { id: true, fullName: true, amoContactId: true } },
        deals: { select: { id: true, status: true } },
        meetings: { select: { id: true, status: true } },
      },
    });

    for (const client of clients) {
      const hasClosedDeal = client.deals.some((d) =>
        d.status === 'PAID' || d.status === 'COMMISSION_PAID',
      );
      if (hasClosedDeal) continue;

      const brokerAmoId = client.broker?.amoContactId ? Number(client.broker.amoContactId) : null;
      if (!brokerAmoId) continue; // нечего проверять — брокер не синкан с amo

      // 2026-06-16 (правка 3, жёсткая версия): если КЦ-лид закрылся в
      // статусе 143 «Закрыто и не реализовано» — у ВСЕХ Client с этим
      // лидом фиксация отклоняется. Включая брокера, у которого была
      // встреча: до сделки клиент не дошёл, уникальность сгорает.
      // Если клиент вернётся — любой брокер сможет фиксировать заново.
      //
      // Раньше условие было !meetingHeld — attached-брокер с проведённой
      // встречей оставался CONDITIONALLY_UNIQUE вечно, что неправильно
      // если КЦ потом закрыл лид без перехода в воронку продаж.
      if (leadStatusId === 143 && leadPipelineId === 7600542) {
        if (client.uniquenessStatus !== UniquenessStatus.REJECTED) {
          await this.prisma.client.update({
            where: { id: client.id },
            data: {
              uniquenessStatus: UniquenessStatus.REJECTED,
              uniquenessReason: 'КЦ закрыл лид (Закрыто и не реализовано)',
              uniquenessExpiresAt: null,
            },
          });
          await this.prisma.auditLog.create({
            data: {
              action: 'UNIQUENESS_RESOLVED',
              entity: 'Client',
              entityId: client.id,
              payload: { trigger: 'KC_LEAD_CLOSED_143', amoLeadId: leadId },
            },
          });
          this.logger.log(`Client ${client.id}: → REJECTED (КЦ-лид ${leadId} закрыт 143)`);
        }
        continue;
      }

      const attached = leadContactIds.includes(brokerAmoId);

      // 2026-07-03: исключение для делегированных клиентов («Фиксирую на другого
      // брокера»). Если у клиента creator (client.brokerId) != executor
      // (client.responsibleBrokerId) — то creator по бизнесу и НЕ должен быть
      // в контактах amoCRM-лида: там executor, он ведёт клиента с КЦ. Значит
      // attach/detach логика (attached==false → REJECTED) для такого Client
      // ошибочна: она сбивает уникальность creator'а на пустом месте.
      // Пропускаем обе attach/detach ветки для делегированных клиентов.
      // Что осталось активным для делегированных: 143-закрытие КЦ-лида
      // (см. выше), закрытие sales-карточки, сброс через `resolveUniqueness`.
      const isDelegated = !!client.responsibleBrokerId
        && client.responsibleBrokerId !== client.brokerId;
      if (isDelegated) continue;

      // 2026-06-16: маркер «исключения» — Client был создан как RULE_EXCEPTION_AFTER_SALES_MEETING.
      // Лифт UNDER_REVIEW → CONDITIONALLY_UNIQUE ТОЛЬКО когда L2 (текущий лид)
      // дойдёт до 62907282 «Квалифицировали и выводим на встречу» в КЦ
      // (или дальше: 62907286 / 142). Просто «attached» не достаточно.
      const isExceptionClient = !!client.uniquenessReason?.startsWith('EXCEPTION_AFTER_SALES_MEETING:');
      const exceptionLiftStatuses = new Set([62907282, 62907286, 142]); // QUALIFIED, MEETING_SCHEDULED, MEETING_HELD

      // 2026-06-17: маркер «RULE_2_KC_PENDING» — Client был создан при
      // фиксации, когда у клиента уже была КЦ-карточка на 62907286
      // «Встреча назначена». Брокер B прикреплён контактом, но статус
      // UNDER_REVIEW. Лифт ТОЛЬКО когда лид достиг 142 «Встреча проведена»
      // (КЦ выбрал победителя — он остался прикреплён, проигравшие
      // отдетачены, идут в REJECTED через стандартный путь).
      const isRule2KcPending = !!client.uniquenessReason?.startsWith('RULE_2_KC_PENDING:');

      if (attached && isRule2KcPending && client.uniquenessStatus === UniquenessStatus.UNDER_REVIEW) {
        if (leadStatusId === 142 && leadPipelineId === 7600542) {
          await this.prisma.client.update({
            where: { id: client.id },
            data: {
              uniquenessStatus: UniquenessStatus.CONDITIONALLY_UNIQUE,
              uniquenessExpiresAt: new Date(Date.now() + msInDays(UNIQUENESS_DAYS)),
              uniquenessReason: `КЦ продвинул лид к «Встреча проведена», вы остались прикреплённым — уникальность подтверждена`,
            },
          });
          await this.prisma.auditLog.create({
            data: {
              action: 'UNIQUENESS_RESOLVED',
              entity: 'Client',
              entityId: client.id,
              payload: { trigger: 'RULE_2_KC_LIFTED_AT_MEETING_HELD', amoLeadId: leadId },
            },
          });
          this.logger.log(`Client ${client.id}: RULE_2_KC UNDER_REVIEW → CONDITIONALLY_UNIQUE (лид ${leadId} → 142 «Встреча проведена»)`);
        }
        // Иначе остаёмся в UNDER_REVIEW (КЦ ещё не выбрал победителя)
        continue;
      }

      if (attached && isExceptionClient && client.uniquenessStatus === UniquenessStatus.UNDER_REVIEW) {
        if (exceptionLiftStatuses.has(leadStatusId)) {
          await this.prisma.client.update({
            where: { id: client.id },
            data: {
              uniquenessStatus: UniquenessStatus.CONDITIONALLY_UNIQUE,
              uniquenessExpiresAt: new Date(Date.now() + msInDays(UNIQUENESS_DAYS)),
              uniquenessReason: `КЦ-лид перешёл в статус ${leadStatusId} — исключение снято`,
            },
          });
          await this.prisma.auditLog.create({
            data: {
              action: 'UNIQUENESS_RESOLVED',
              entity: 'Client',
              entityId: client.id,
              payload: { trigger: 'EXCEPTION_LIFTED_BY_KC_STATUS', amoLeadId: leadId, leadStatusId },
            },
          });
          this.logger.log(`Client ${client.id}: EXCEPTION UNDER_REVIEW → CONDITIONALLY_UNIQUE (L2 ${leadId} достиг status=${leadStatusId})`);
        }
        // Иначе остаёмся в UNDER_REVIEW (КЦ ещё не квалифицировал)
        continue;
      }

      if (attached && (
        client.uniquenessStatus === UniquenessStatus.REJECTED ||
        client.uniquenessStatus === UniquenessStatus.UNDER_REVIEW
      )) {
        const wasUnderReview = client.uniquenessStatus === UniquenessStatus.UNDER_REVIEW;
        await this.prisma.client.update({
          where: { id: client.id },
          data: {
            uniquenessStatus: UniquenessStatus.CONDITIONALLY_UNIQUE,
            uniquenessExpiresAt: new Date(Date.now() + msInDays(UNIQUENESS_DAYS)),
            uniquenessReason: wasUnderReview
              ? 'КЦ одобрил — брокер прикреплён к лиду в amoCRM'
              : 'Брокер прикреплён обратно к лиду в amoCRM',
          },
        });
        await this.prisma.auditLog.create({
          data: {
            action: 'UNIQUENESS_RESOLVED',
            entity: 'Client',
            entityId: client.id,
            payload: {
              trigger: wasUnderReview ? 'AMO_KC_APPROVED' : 'AMO_BROKER_REATTACHED',
              amoLeadId: leadId,
              brokerAmoContactId: brokerAmoId,
            },
          },
        });
        this.logger.log(`Client ${client.id}: ${wasUnderReview ? 'UNDER_REVIEW' : 'REJECTED'} → CONDITIONALLY_UNIQUE (broker attached to lead ${leadId})`);
      } else if (
        !attached
        && (
          client.uniquenessStatus === UniquenessStatus.CONDITIONALLY_UNIQUE
          || client.uniquenessStatus === UniquenessStatus.UNDER_REVIEW
        )
      ) {
        // 2026-06-16: жёсткое правило по решению пользователя — если брокер
        // НЕ в списке контактов лида, его фиксация = REJECTED. Не важно,
        // в какой стадии лид (62907286 «Встреча назначена», или финал).
        // Раньше для UNDER_REVIEW требовался переход в 142/143 — это
        // оставляло Client «На проверке» при просто «открепили». Новое
        // правило: amoCRM-контакты = источник истины уникальности.
        const wasUnderReview = client.uniquenessStatus === UniquenessStatus.UNDER_REVIEW;
        await this.prisma.client.update({
          where: { id: client.id },
          data: {
            uniquenessStatus: UniquenessStatus.REJECTED,
            uniquenessReason: wasUnderReview
              ? 'КЦ не прикрепил брокера к лиду, фиксация отклонена'
              : 'Брокер откреплён от лида в amoCRM',
            uniquenessExpiresAt: null,
          },
        });
        await this.prisma.auditLog.create({
          data: {
            action: 'UNIQUENESS_RESOLVED',
            entity: 'Client',
            entityId: client.id,
            payload: {
              trigger: wasUnderReview ? 'KC_DID_NOT_ATTACH' : 'AMO_BROKER_DETACHED',
              amoLeadId: leadId,
              leadStatusId,
              brokerAmoContactId: brokerAmoId,
            },
          },
        });
        this.logger.log(`Client ${client.id}: ${client.uniquenessStatus} → REJECTED (брокер не прикреплён к лиду ${leadId}, status=${leadStatusId})`);
      }
    }

    // 2026-06-16: если этот лид закрылся 143 (КЦ или sales), и у нас
    // есть Client-записи с маркером EXCEPTION_AFTER_SALES_MEETING на
    // том же телефоне (брокер B ждал решения) — снимаем UNDER_REVIEW
    // → CONDITIONALLY_UNIQUE. Брокер A провалился, B свободен.
    if (leadStatusId === 143 && clients.length > 0) {
      const phones = Array.from(new Set(clients.map((c) => c.phone))).filter(Boolean);
      if (phones.length > 0) {
        const exceptionClients = await this.prisma.client.findMany({
          where: {
            phone: { in: phones as string[] },
            uniquenessStatus: UniquenessStatus.UNDER_REVIEW,
            uniquenessReason: { startsWith: 'EXCEPTION_AFTER_SALES_MEETING:' },
          },
        });
        for (const ec of exceptionClients) {
          await this.prisma.client.update({
            where: { id: ec.id },
            data: {
              uniquenessStatus: UniquenessStatus.CONDITIONALLY_UNIQUE,
              uniquenessExpiresAt: new Date(Date.now() + msInDays(UNIQUENESS_DAYS)),
              uniquenessReason: `Брокер A провалился (lead ${leadId} закрыт 143), исключение снято`,
            },
          });
          await this.prisma.auditLog.create({
            data: {
              action: 'UNIQUENESS_RESOLVED',
              entity: 'Client',
              entityId: ec.id,
              payload: { trigger: 'EXCEPTION_LIFTED_BY_BROKER_A_FAILED', amoLeadId: leadId },
            },
          });
          this.logger.log(`Client ${ec.id}: EXCEPTION UNDER_REVIEW → CONDITIONALLY_UNIQUE (брокер A провалился на лиде ${leadId})`);
        }
      }
    }

    // 2026-06-17: ретро-обработка sales-pipeline переходов. Если sales-лид
    // (Зорге/Берзарина/Толбухина) перешёл в exception stage (Встреча
    // проведена, думают / Отложенный / Устная бронь / Снята бронь) или
    // в deal stage (Платная бронь и далее), нужно ретроактивно обновить
    // параллельных брокеров — тех, кто зафиксировался до того, как sales
    // достиг этой стадии (и тогда они получили CONDITIONALLY_UNIQUE по
    // RULE_3, потому что sales ещё не было в exception/deal стадии).
    //
    // Параллельный брокер = тот, чей amoContactId НЕ в списке contacts
    // этого sales-лида. Брокер A (тот, кто привёл клиента) — прикреплён.
    if (isSalesPipeline(leadPipelineId)) {
      let phones: string[] = Array.from(new Set(clients.map((c) => c.phone))).filter(Boolean) as string[];
      if (phones.length === 0) {
        // Если у нас нет Client'ов на этом sales-лиде (брокер A фиксировался
        // не через нас, а Морикит создал sales), достанем телефоны из
        // контактов лида.
        const contactIds: number[] = ((lead?._embedded?.contacts as any[]) || [])
          .map((c) => Number(c.id))
          .filter((id) => !isNaN(id));
        const phonesSet = new Set<string>();
        for (const cid of contactIds) {
          try {
            const contact: any = await this.amo.getContact(cid);
            const pf = contact?.custom_fields_values?.find((f: any) => f.field_code === 'PHONE');
            for (const v of (pf?.values || [])) {
              const raw = String(v?.value || '').replace(/\D/g, '');
              if (raw.length === 11) phonesSet.add('+' + raw);
              else if (raw.length === 10) phonesSet.add('+7' + raw);
            }
          } catch (e: any) {
            this.logger.warn(`[sales-retroactive] getContact ${cid} failed: ${e?.message || e}`);
          }
        }
        phones = Array.from(phonesSet);
      }

      if (phones.length > 0) {
        const isExceptionStage = isSalesExceptionStatus(leadPipelineId, leadStatusId);
        const isDealStage = isSalesDealStatus(leadPipelineId, leadStatusId);

        if (isExceptionStage) {
          // Параллельные брокеры с CONDITIONALLY_UNIQUE → UNDER_REVIEW + EXCEPTION marker
          const candidates = await this.prisma.client.findMany({
            where: {
              phone: { in: phones },
              uniquenessStatus: UniquenessStatus.CONDITIONALLY_UNIQUE,
            },
            // 2026-07-03: включаем responsibleBroker — для делегированных
            // клиентов «Фиксирую на другого» amo-контакт стоит у executor'а (Б),
            // а не у creator'а (А). Проверка «брокер на лиде» должна засчитывать
            // ЛЮБОГО из двух.
            include: {
              broker: { select: { amoContactId: true } },
              responsibleBroker: { select: { amoContactId: true } },
            },
          });
          for (const c of candidates) {
            const brokerAmoId = c.broker?.amoContactId ? Number(c.broker.amoContactId) : null;
            const respAmoId = c.responsibleBroker?.amoContactId ? Number(c.responsibleBroker.amoContactId) : null;
            const brokerOnLead =
              (brokerAmoId && leadContactIds.includes(brokerAmoId)) ||
              (respAmoId && leadContactIds.includes(respAmoId));
            if (brokerOnLead) continue; // это брокер A (creator) или B (executor) на этом лиде, пропускаем
            await this.prisma.client.update({
              where: { id: c.id },
              data: {
                uniquenessStatus: UniquenessStatus.UNDER_REVIEW,
                uniquenessReason: `EXCEPTION_AFTER_SALES_MEETING:${leadId} sales-карточка в exception stage`,
                uniquenessExpiresAt: null,
              },
            });
            await this.prisma.auditLog.create({
              data: {
                action: 'UNIQUENESS_RESOLVED',
                entity: 'Client',
                entityId: c.id,
                payload: { trigger: 'SALES_REACHED_EXCEPTION_STAGE', amoLeadId: leadId, leadStatusId },
              },
            });
            this.logger.log(`Client ${c.id}: CONDITIONALLY_UNIQUE → UNDER_REVIEW (sales lead ${leadId} в exception stage, брокер ${brokerAmoId} не прикреплён)`);
          }
        } else if (isDealStage) {
          // Параллельные брокеры с любым активным → REJECTED
          const candidates = await this.prisma.client.findMany({
            where: {
              phone: { in: phones },
              uniquenessStatus: { in: [UniquenessStatus.CONDITIONALLY_UNIQUE, UniquenessStatus.UNDER_REVIEW] },
            },
            // 2026-07-03: учитываем executor'а — см. комментарий выше.
            include: {
              broker: { select: { amoContactId: true } },
              responsibleBroker: { select: { amoContactId: true } },
            },
          });
          for (const c of candidates) {
            const brokerAmoId = c.broker?.amoContactId ? Number(c.broker.amoContactId) : null;
            const respAmoId = c.responsibleBroker?.amoContactId ? Number(c.responsibleBroker.amoContactId) : null;
            const brokerOnLead =
              (brokerAmoId && leadContactIds.includes(brokerAmoId)) ||
              (respAmoId && leadContactIds.includes(respAmoId));
            if (brokerOnLead) continue;
            await this.prisma.client.update({
              where: { id: c.id },
              data: {
                uniquenessStatus: UniquenessStatus.REJECTED,
                uniquenessReason: `Sales-карточка перешла в стадию сделки, ваша фиксация отклонена`,
                uniquenessExpiresAt: null,
              },
            });
            await this.prisma.auditLog.create({
              data: {
                action: 'UNIQUENESS_RESOLVED',
                entity: 'Client',
                entityId: c.id,
                payload: { trigger: 'SALES_REACHED_DEAL_STAGE', amoLeadId: leadId, leadStatusId },
              },
            });
            this.logger.log(`Client ${c.id}: → REJECTED (sales lead ${leadId} в deal stage, брокер ${brokerAmoId} не прикреплён)`);
          }
        }
      }
    }
  }
}
