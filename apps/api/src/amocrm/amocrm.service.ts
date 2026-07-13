import { Injectable, Inject, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaClient, UniquenessStatus } from '@st-michael/database';
import { AmoCrmAdapter, AMO_CONTACT_FIELDS, AMO_LEAD_FIELDS, AMO_PIPELINES, getLeadCustomFieldNumber, getLeadCustomFieldValue, pipelineToProject, leadToProject, statusToDealStatus, isDealStage, mapMeetingStatus, BROKER_PIPELINE_ID } from '@st-michael/integrations';
import { levelForSqm, rateFor, rateForWithPolicy } from '../commission/commission.service';
@Injectable()
export class AmocrmService {
  private amo: AmoCrmAdapter;
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {
    this.amo = new AmoCrmAdapter();
  }
  /**
   * Чистит имя клиента от служебных суффиксов amoCRM: "от брокера", "от Владимира",
   * "от боркера" (опечатка) и т.п. Убираем всё начиная от слова "от ".
   * Правка 2026-05-13: чтобы в кабинете брокера ФИО клиентов были как при ручном
   * заведении, без приписок "от <кого-то>".
   */
  private cleanClientName(raw: string | null | undefined): string {
    if (!raw) return 'Без имени';
    const cleaned = String(raw).replace(/\s+от\s+.+$/iu, '').trim();
    return cleaned || 'Без имени';
  }
  private async getCommissionRate(brokerId: string, project: string, dealDate?: Date): Promise<number> {
    const brokerAgency = await this.prisma.brokerAgency.findFirst({
      where: { brokerId, isPrimary: true },
      include: { agency: true },
    });
    const totalSqm = Number(brokerAgency?.agency?.totalSqmSold || 0);
    // Правка 2026-05-13: учитываем активную политику на дату сделки.
    // PROGRESSIVE — берём rate из шкалы политики по totalSqm.
    // FLAT — берём policy.flatRate (всегда одна и та же).
    // FALLBACK — старая хардкод-шкала.
    const result = await rateForWithPolicy(this.prisma, project, totalSqm, dealDate);
    return result.rate;
  }
  private mapMeetingType(raw: string): 'OFFICE_VISIT' | 'ONLINE' | 'BROKER_TOUR' {
    const v = (raw || '').toLowerCase();
    if (v.includes('онлайн') || v.includes('online') || v.includes('zoom')) return 'ONLINE';
    if (v.includes('тур') || v.includes('брокер')) return 'BROKER_TOUR';
    return 'OFFICE_VISIT';
  }
  /**
   * Sync meeting from a lead if it has meeting date field. Creates/updates Meeting linked to broker.
   */
  async syncMeetingFromLead(
    lead: any,
    brokerId: string,
    clientId: string,
  ): Promise<boolean> {
    const customFields = lead?.custom_fields_values || [];
    const dateField = customFields.find((f: any) => f.field_name === 'Дата и время встречи');
    const typeField = customFields.find((f: any) => f.field_name === 'Встреча');
    const rawDate = dateField?.values?.[0]?.value;
    if (!rawDate) return false;
    // amoCRM stores date as Unix timestamp (seconds)
    const meetingDate = new Date(Number(rawDate) * 1000);
    if (isNaN(meetingDate.getTime())) return false;
    const rawType = typeField?.values?.[0]?.value || '';
    const meetingType = this.mapMeetingType(rawType);
    const meetingStatus = mapMeetingStatus(lead.status_id);
    // Upsert meeting by clientId+brokerId+date (or use lead.id via comment)
    const existing = await this.prisma.meeting.findFirst({
      where: { clientId, brokerId, date: meetingDate },
    });
    if (existing) {
      await this.prisma.meeting.update({
        where: { id: existing.id },
        data: { type: meetingType as any, status: meetingStatus as any },
      });
    } else {
      // 2026-07-01: убрал техническую строку «Тип из amoCRM». Вместо неё
      // мини-детали клиента, чтобы менеджеру было понятно про кого встреча.
      const client = await this.prisma.client.findUnique({
        where: { id: clientId },
        select: { fullName: true, phone: true, project: true },
      });
      const projectLabel = client?.project === 'ZORGE9' ? 'Зорге 9'
        : client?.project === 'SILVER_BOR' ? 'Серебряный Бор'
        : (client?.project || '');
      const commentLines = client
        ? [
            `Клиент: ${client.fullName}`,
            `Телефон: ${client.phone}`,
            ...(projectLabel ? [`Проект: ${projectLabel}`] : []),
          ]
        : [];
      await this.prisma.meeting.create({
        data: {
          brokerId,
          clientId,
          type: meetingType as any,
          status: meetingStatus as any,
          date: meetingDate,
          comment: commentLines.length ? commentLines.join('\n') : null,
        },
      });
    }
    return true;
  }
  async getAccount() {
    return this.amo.getAccount();
  }
  /**
   * Diagnostic: fetch lead with all custom_fields. Used to discover field names/ids
   * for sqm/price/profitbase. Returns sanitized data (no contacts/PII).
   */
  async inspectLead(leadId: number) {
    const lead: any = await this.amo.getLead(leadId);
    if (!lead) return { error: 'Lead not found', leadId };
    const customFields = (lead.custom_fields_values || []).map((f: any) => ({
      field_id: f.field_id,
      field_name: f.field_name,
      field_code: f.field_code,
      values: f.values,
    }));
    // 2026-06-10: список задач по этому лиду — чтобы видеть кто ответственный.
    const tasks = await this.amo.getTasksByEntity('leads', leadId);
    return {
      id: lead.id,
      name: lead.name,
      pipeline_id: lead.pipeline_id,
      status_id: lead.status_id,
      price: lead.price,
      created_at: lead.created_at,
      updated_at: lead.updated_at,
      responsible_user_id: lead.responsible_user_id,
      custom_fields_count: customFields.length,
      custom_fields: customFields,
      tasks,
    };
  }
  async getPipelines() {
    const pipelines = await this.amo.getPipelines();
    return pipelines.map((p: any) => ({
      id: p.id,
      name: p.name,
      is_main: p.is_main,
      statuses: (p._embedded?.statuses || []).map((s: any) => ({
        id: s.id,
        name: s.name,
        sort: s.sort,
        is_editable: s.is_editable,
      })),
    }));
  }
  async getContactFields() {
    return this.amo.getContactCustomFields();
  }
  async getCompanyFields() {
    return this.amo.getCompanyCustomFields();
  }
  async getUsers() {
    const users = await this.amo.getUsers();
    return users.map((u: any) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      role_id: u.role_id,
    }));
  }
  /**
   * Find broker contact in amoCRM by phone and sync linked leads/clients to local DB
   */
  async syncBrokerByPhone(phone: string, brokerId?: string, inn?: string) {
    if (!phone) throw new BadRequestException('phone required');
    const contact = await this.amo.findContactByPhone(phone);
    if (!contact) {
      return { found: false, message: 'Contact not found in amoCRM' };
    }
    // Get full contact with leads
    const fullContact = await this.amo.getContact(contact.id);
    const leads = fullContact?._embedded?.leads || [];
    // If INN provided, attach company with INN
    if (inn && brokerId) {
      let company = await this.amo.findCompanyByInn(inn);
      if (!company) {
        company = await this.amo.createCompany({
          name: `Агентство ${inn}`,
          custom_fields_values: [
            { field_code: 'INN' as any, values: [{ value: inn }] },
          ],
        });
      }
      try {
        await this.amo.linkContactToCompany(contact.id, company.id);
      } catch {}
      // Save agency in DB
      let agency = await this.prisma.agency.findUnique({ where: { inn } });
      if (!agency) {
        agency = await this.prisma.agency.create({
          data: { name: company.name, inn },
        });
      }
      // Link broker to agency
      const existingLink = await this.prisma.brokerAgency.findFirst({
        where: { brokerId, agencyId: agency.id },
      });
      if (!existingLink) {
        await this.prisma.brokerAgency.create({
          data: { brokerId, agencyId: agency.id, isPrimary: true },
        });
      }
      // Save amo_contact_id to broker
      await this.prisma.broker.update({
        where: { id: brokerId },
        data: { amoContactId: BigInt(contact.id) },
      });
    }
    return {
      found: true,
      contact: { id: contact.id, name: contact.name },
      leadsCount: leads.length,
      leads: leads.map((l: any) => ({ id: l.id })),
    };
  }
  /**
   * Pull all leads (deals) linked to broker's amoCRM contact and create local Client + Deal records
   */
  async syncMyDealsAndClients(brokerId: string) {
    const broker = await this.prisma.broker.findUnique({ where: { id: brokerId } });
    if (!broker) throw new NotFoundException('Broker not found');
    // Find correct broker contact in amoCRM (with Брокер=true flag)
    let amoContactId = broker.amoContactId ? Number(broker.amoContactId) : null;
    const brokerContact = await this.amo.findBrokerContactByPhone(broker.phone);
    if (brokerContact && (!amoContactId || brokerContact.id !== amoContactId)) {
      // Re-link to correct broker contact
      amoContactId = brokerContact.id;
      await this.prisma.broker.update({
        where: { id: brokerId },
        data: { amoContactId: BigInt(brokerContact.id) },
      });
    }
    // Strategy 1: Get leads linked to broker's contact
    let allLeadIds: number[] = [];
    if (amoContactId) {
      const fullContact = await this.amo.getContact(amoContactId);
      const contactLeads = fullContact?._embedded?.leads || [];
      allLeadIds.push(...contactLeads.map((l: any) => l.id));
    }
    // Strategy 2: Find broker as amoCRM user (employee) and get leads by responsible_user_id
    let amoUserId: number | null = null;
    try {
      const users = await this.amo.getUsers();
      const cleanPhone = broker.phone.replace(/\D/g, '').slice(-10);
      const userByPhone = users.find((u: any) => {
        const uPhone = String(u.phone || '').replace(/\D/g, '');
        return uPhone && uPhone.endsWith(cleanPhone);
      });
      const userByName = !userByPhone ? users.find((u: any) =>
        u.name && broker.fullName && u.name.toLowerCase().includes(broker.fullName.split(' ')[0]?.toLowerCase()),
      ) : null;
      const matchedUser = userByPhone || userByName;
      if (matchedUser) {
        amoUserId = matchedUser.id;
        const userLeads = await this.amo.getLeadsByResponsibleUser(matchedUser.id, 500);
        for (const lead of userLeads) {
          if (!allLeadIds.includes(lead.id)) allLeadIds.push(lead.id);
        }
      }
    } catch (e) {
      console.error('User lookup failed:', e);
    }
    if (allLeadIds.length === 0) {
      return {
        dealsCreated: 0, dealsUpdated: 0, clientsCreated: 0,
        message: 'No leads found. Broker not linked to deals in amoCRM.',
        amoContactId, amoUserId,
      };
    }
    let dealsCreated = 0;
    let dealsUpdated = 0;
    let clientsCreated = 0;
    let skipped = 0;
    // Cleanup: удалить устаревшие Meeting/Deal/Client с fake-телефонами +70000XXX.
    // Правка 2026-05-14. Сначала Meeting и Deal (зависят от Client через FK), потом Client.
    await this.prisma.meeting.deleteMany({
      where: { brokerId, client: { phone: { startsWith: '+70000' } } },
    });
    await this.prisma.deal.deleteMany({
      where: { brokerId, client: { phone: { startsWith: '+70000' } } },
    });
    await this.prisma.client.deleteMany({
      where: { brokerId, phone: { startsWith: '+70000' } },
    });
    for (const leadId of allLeadIds) {
      try {
        const lead: any = await this.amo.getLead(leadId);
        if (!lead) continue;
        // Skip leads from "Воронка брокеров" — они отслеживают самих брокеров, не клиентов.
        if (lead.pipeline_id === BROKER_PIPELINE_ID) { skipped++; continue; }
        // КЦ-карточки: status 142 у них = "встреча проведена" (успех КЦ), не "клиент купил".
        // Не создаём Deal из них, но meeting-sync проходит как обычно. Правка 2026-05-13.
        const isKcPipeline = lead.pipeline_id === AMO_PIPELINES.KC;
        const status_id = lead.status_id;
        const isDealLead = !isKcPipeline && status_id !== 143 && isDealStage(status_id);
        const project = leadToProject(lead);
        // Find client contact in lead (any contact that is NOT the broker)
        const leadContacts = lead?._embedded?.contacts || [];
        const clientContactRef = leadContacts.find(
          (c: any) => !amoContactId || Number(c.id) !== amoContactId,
        ) || leadContacts[0];
        let fullName = this.cleanClientName(lead.name);
        let phone = `+70000${leadId}`;
        let email: string | null = null;
        if (clientContactRef) {
          const clientContact: any = await this.amo.getContact(clientContactRef.id);
          if (clientContact) {
            const contactCleaned = this.cleanClientName(clientContact.name);
            if (contactCleaned !== 'Без имени') fullName = contactCleaned;
            const phoneField = (clientContact.custom_fields_values || []).find(
              (f: any) => f.field_id === AMO_CONTACT_FIELDS.PHONE || f.field_code === 'PHONE',
            );
            const rawPhone = phoneField?.values?.[0]?.value || '';
            // Агрессивная нормализация: убрать ВСЁ кроме цифр, затем +7XXXXXXXXXX.
            // Правка 2026-05-12: amoCRM хранит phone в разных форматах ("8 925...", "(925)...",
            // "+7-925..."), и наш прежний parser плохо ловил пробелы внутри числа.
            // Теперь — single source of truth: всегда +7 и 11 цифр или +<digits>.
            let p = String(rawPhone).replace(/\D/g, '');
            if (p.length === 11 && p.startsWith('8')) p = '7' + p.slice(1);
            if (p.length === 10) p = '7' + p;
            if (p) phone = '+' + p;
            const emailField = (clientContact.custom_fields_values || []).find(
              (f: any) => f.field_id === AMO_CONTACT_FIELDS.EMAIL || f.field_code === 'EMAIL',
            );
            email = emailField?.values?.[0]?.value || null;
          }
        }
        // Если у контакта в amoCRM нет реального телефона — мы НЕ создаём Client.
        // Раньше писался fake-телефон вида +70000<leadId> (Лина-style).
        // Правка 2026-05-14.
        if (phone.startsWith('+70000')) {
          // Удалить устаревшие Meeting/Deal/Client с fake-телефоном если есть.
          const fakeClient = await this.prisma.client.findFirst({ where: { phone, brokerId } });
          if (fakeClient) {
            await this.prisma.meeting.deleteMany({ where: { clientId: fakeClient.id } });
            await this.prisma.deal.deleteMany({ where: { clientId: fakeClient.id } });
            await this.prisma.client.delete({ where: { id: fakeClient.id } });
          }
          skipped++;
          continue;
        }
        // Upsert client с реальной датой создания/изменения из amoCRM (правка 2026-05-14).
        const leadCreatedAt = lead.created_at ? new Date(lead.created_at * 1000) : null;
        const leadUpdatedAt = lead.updated_at ? new Date(lead.updated_at * 1000) : null;
        let client = await this.prisma.client.findFirst({ where: { phone, brokerId } });
        // 2026-07-02: если клиент уже есть у ДРУГОГО брокера (напр. фиксация
        // А → на Б создала Client с brokerId=А), синк Б переиспользует
        // существующего вместо создания дубля. Плюс назначаем Б как
        // responsibleBrokerId, если поле пустое.
        if (!client) {
          const existingAnyBroker = await this.prisma.client.findFirst({
            where: { phone },
            orderBy: { createdAt: 'asc' },
          });
          if (existingAnyBroker) {
            client = existingAnyBroker;
            if (!client.responsibleBrokerId || client.responsibleBrokerId === client.brokerId) {
              if (client.brokerId !== brokerId) {
                await this.prisma.client.update({
                  where: { id: client.id },
                  data: { responsibleBrokerId: brokerId },
                });
                client = { ...client, responsibleBrokerId: brokerId } as any;
              }
            }
          }
        }
        if (!client) {
          client = await this.prisma.client.create({
            data: {
              brokerId, fullName, phone, email,
              project: project as any,
              amoLeadId: BigInt(lead.id),
              uniquenessStatus: UniquenessStatus.CONDITIONALLY_UNIQUE,
              // Уникальность = 30 дней от даты создания лида в amoCRM (правка 2026-05-14, ранее 40).
              uniquenessExpiresAt: new Date((leadCreatedAt ? leadCreatedAt.getTime() : Date.now()) + 30 * 24 * 60 * 60 * 1000),
              amoCreatedAt: leadCreatedAt,
              amoUpdatedAt: leadUpdatedAt,
            },
          });
          clientsCreated++;
        } else if (leadCreatedAt || leadUpdatedAt) {
          // MIN amoCreatedAt + MAX amoUpdatedAt по всем связанным лидам.
          // Уникальность пересчитывается от самой ранней даты + 30 дней. Правка 2026-05-14.
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
        // КЦ-карточки: cleanup существующего Deal (если был создан до фикса) и сразу
        // к meeting-sync — НЕ создаём/обновляем Deal.
        if (isKcPipeline) {
          const existingKcDeal = await this.prisma.deal.findFirst({ where: { amoDealId: BigInt(lead.id) } });
          if (existingKcDeal) {
            await this.prisma.deal.delete({ where: { id: existingKcDeal.id } });
          }
          try { await this.syncMeetingFromLead(lead, brokerId, client.id); } catch {}
          continue;
        }
        // Лиды не на стадии сделки или 143 («Закрыто и не реализовано») — удаляем
        // ошибочный Deal из БД (если был синкан раньше при другом статусе) и
        // переходим к meeting-sync. Правка 2026-05-13.
        if (!isDealLead) {
          const staleDeal = await this.prisma.deal.findFirst({ where: { amoDealId: BigInt(lead.id) } });
          if (staleDeal) {
            await this.prisma.deal.delete({ where: { id: staleDeal.id } });
          }
          try { await this.syncMeetingFromLead(lead, brokerId, client.id); } catch {}
          skipped++;
          continue;
        }
        const status = statusToDealStatus(status_id);
        // Извлекаем sqm/price/lotId из custom_fields (правка 2026-05-12).
        // Раньше: amount=lead.price, sqm=0. Теперь — приоритет custom-полей.
        const sqm = getLeadCustomFieldNumber(lead, AMO_LEAD_FIELDS.SQM);
        const priceNoDiscount = getLeadCustomFieldNumber(lead, AMO_LEAD_FIELDS.PRICE_NO_DISCOUNT);
        // amount: приоритет "Стоимость без скидок" → fallback lead.price
        const amount = priceNoDiscount > 0 ? priceNoDiscount : Number(lead.price || 0);
        const profitbaseLotId = getLeadCustomFieldValue(lead, AMO_LEAD_FIELDS.PROFITBASE_LOT_ID);
        const ccIdParent = getLeadCustomFieldValue(lead, AMO_LEAD_FIELDS.CC_ID_PARENT);
        // Комиссия — приоритет: значения, проставленные руками менеджером в amoCRM
        // (custom-поля 673171 "Комиссия в руб." и 673169 "Комиссия брокера в %").
        // Если хотя бы одно из них заполнено — используем amoCRM-значения.
        // Если ни одно не заполнено — fallback на локальный расчёт. Правка 2026-05-14.
        const dealDate = lead.created_at ? new Date(lead.created_at * 1000) : new Date();
        const amoCommissionAmt = getLeadCustomFieldNumber(lead, AMO_LEAD_FIELDS.COMMISSION_AMOUNT);
        const amoCommissionRate = getLeadCustomFieldNumber(lead, AMO_LEAD_FIELDS.COMMISSION_RATE);
        let rate: number;
        let commissionAmount: number;
        if (amoCommissionAmt > 0 || amoCommissionRate > 0) {
          rate = amoCommissionRate > 0 ? amoCommissionRate : (amount > 0 ? (amoCommissionAmt / amount) * 100 : 0);
          commissionAmount = amoCommissionAmt > 0 ? Math.round(amoCommissionAmt) : Math.round(amount * rate / 100);
        } else {
          rate = await this.getCommissionRate(brokerId, project, dealDate);
          commissionAmount = Math.round(amount * rate / 100);
        }
        // Дедупликация: на одну реальную сделку в amoCRM может быть 2-3 карточки
        // (КЦ, проектная воронка, воронка брокеров). Связь child→parent через cc_id_parent.
        // Ищем существующий Deal по любой из связанных карточек:
        //   1. По собственному amoDealId
        //   2. По cc_id_parent текущего лида (если он child — родитель уже мог попасть в БД)
        //   3. По amoParentDealId == lead.id (если этот лид — родитель, а его child уже в БД)
        let existingDeal = await this.prisma.deal.findFirst({
          where: { amoDealId: BigInt(lead.id) },
        });
        if (!existingDeal && ccIdParent) {
          existingDeal = await this.prisma.deal.findFirst({
            where: {
              OR: [
                { amoDealId: BigInt(ccIdParent) },
                { amoParentDealId: BigInt(ccIdParent) },
              ],
            },
          });
        }
        if (!existingDeal) {
          existingDeal = await this.prisma.deal.findFirst({
            where: { amoParentDealId: BigInt(lead.id) },
          });
        }
        // При апдейте существующего Deal не перетираем sqm/amount нулями,
        // если новые данные пустые — данные могут быть в parent-карточке.
        const dealData: any = {
          clientId: client.id,
          brokerId,
          project: project as any,
          commissionRate: rate,
          commissionAmount,
          status: status as any,
          amoDealId: BigInt(lead.id),
          amoParentDealId: ccIdParent ? BigInt(ccIdParent) : null,
        };
        // Дата сделки из amoCRM (lead.created_at) — для UI и сортировки.
        // Правка 2026-05-13: раньше показывался deal.createdAt (день нашего синка).
        if (lead.created_at) dealData.signedAt = new Date(lead.created_at * 1000);
        // Заполняем sqm/amount ТОЛЬКО если новое значение > 0
        // (приоритет child-карточек где эти поля заполнены).
        if (sqm > 0 || !existingDeal) dealData.sqm = sqm;
        if (amount > 0 || !existingDeal) dealData.amount = amount;
        if (existingDeal) {
          await this.prisma.deal.update({ where: { id: existingDeal.id }, data: dealData });
          dealsUpdated++;
          // Post-fix дедуп (правка 2026-05-13): если в БД есть ДВЕ записи на ту же
          // продажу (parent и child были засинканы раздельно до cc_id_parent логики),
          // удаляем дубликат. amoCRM-карточки НЕ трогаем — только наша БД.
          if (ccIdParent) {
            const dupParent = await this.prisma.deal.findFirst({
              where: { amoDealId: BigInt(ccIdParent), id: { not: existingDeal.id } },
            });
            if (dupParent) await this.prisma.deal.delete({ where: { id: dupParent.id } });
          }
          const dupChild = await this.prisma.deal.findFirst({
            where: { amoParentDealId: BigInt(lead.id), id: { not: existingDeal.id } },
          });
          if (dupChild) {
            // child обычно содержит точные sqm/amount → если у нас pусто, оставляем child
            if (Number(dupChild.sqm) > 0 && Number(existingDeal.sqm || 0) === 0) {
              await this.prisma.deal.delete({ where: { id: existingDeal.id } });
            } else {
              await this.prisma.deal.delete({ where: { id: dupChild.id } });
            }
          }
        } else {
          await this.prisma.deal.create({ data: dealData });
          dealsCreated++;
        }
        // Sync meeting from lead if present (only for current broker)
        try { await this.syncMeetingFromLead(lead, brokerId, client.id); } catch {}
      } catch (e) {
        skipped++;
      }
    }
    // Пересчёт totalSqmSold для primary agency брокера — после всех апдейтов сделок.
    // Раньше это поле никогда не записывалось → level всегда START. Правка 2026-05-12.
    await this.recalcAgencyTotalSqm(brokerId);
    // Second-pass recalc убран 2026-05-14: amoCRM-значения комиссии (673169/673171)
    // теперь авторитетный источник, локальный пересчёт перетирал бы их.
    return { dealsCreated, dealsUpdated, clientsCreated, skipped, totalLeads: allLeadIds.length, amoContactId, amoUserId };
  }
  /**
   * Пересчитывает agency.totalSqmSold = SUM(sqm) по всем PAID/COMMISSION_PAID
   * сделкам брокера. Зовётся после синхронизации, чтобы уровень комиссии
   * (levelForSqm) обновлялся.
   */
  private async recalcAgencyTotalSqm(brokerId: string): Promise<void> {
    const ba = await this.prisma.brokerAgency.findFirst({
      where: { brokerId, isPrimary: true },
      include: { agency: true },
    });
    if (!ba?.agency) return;
    const result = await this.prisma.deal.aggregate({
      where: { brokerId, status: { in: ['PAID', 'COMMISSION_PAID'] } },
      _sum: { sqm: true },
    });
    const totalSqm = Number(result._sum.sqm || 0);
    await this.prisma.agency.update({
      where: { id: ba.agency.id },
      data: { totalSqmSold: totalSqm },
    });
  }
}
