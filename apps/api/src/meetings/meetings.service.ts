import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { AmoCrmAdapter, isSalesPipeline } from '@st-michael/integrations';

@Injectable()
export class MeetingsService {
  private amo = new AmoCrmAdapter();
  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    @InjectQueue('notifications') private notificationQueue: Queue,
  ) {}

  async getMeetings(
    brokerId: string,
    query: {
      page?: number;
      limit?: number;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      status?: string;
      type?: string;
    },
  ) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const skip = (page - 1) * limit;

    const where: any = { brokerId };
    if (query.status) {
      // Поддержка "upcoming" — только запланированные (PENDING/CONFIRMED).
      // Правка заказчика 2026-05-12: на /meetings показывать только не-завершённые.
      if (query.status === 'upcoming') {
        where.status = { in: ['PENDING', 'CONFIRMED'] };
      } else {
        where.status = query.status;
      }
    } else {
      // По умолчанию исключаем CANCELLED И COMPLETED (только запланированные).
      where.status = { notIn: ['CANCELLED', 'COMPLETED'] };
    }
    if (query.type) where.type = query.type;

    const orderBy: any = {};
    orderBy[query.sortBy || 'date'] = query.sortOrder || 'desc';

    const [meetings, total] = await Promise.all([
      this.prisma.meeting.findMany({
        where,
        include: {
          client: { select: { id: true, fullName: true, phone: true } },
        },
        skip,
        take: limit,
        orderBy,
      }),
      this.prisma.meeting.count({ where }),
    ]);

    return {
      meetings,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // 2026-07-01: календарь встреч из amoCRM (read-only) для кабинета брокера.
  // Тянем задачи task_type_id=2 (Встреча) по всем клиентам брокера (по их
  // amoLeadId), плюс задачи-встречи назначенные на amoContactId брокера
  // (если он есть). Возвращаем плоский список с датами — UI сортирует.
  async getAmoCrmCalendar(brokerId: string): Promise<Array<{
    id: number;
    text: string;
    date: string;
    isCompleted: boolean;
    source: 'lead' | 'contact';
    clientName?: string | null;
    leadId?: number | null;
  }>> {
    const clients = await this.prisma.client.findMany({
      where: { brokerId, amoLeadId: { not: null } },
      select: { fullName: true, amoLeadId: true },
    });
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
      select: { amoContactId: true },
    });

    const MEETING_TASK_TYPE = 2;
    const result: Array<{
      id: number; text: string; date: string; isCompleted: boolean;
      source: 'lead' | 'contact'; clientName?: string | null; leadId?: number | null;
    }> = [];
    const seenTaskIds = new Set<number>();

    // По каждому клиенту — задачи-встречи из лида.
    for (const c of clients) {
      const leadId = Number(c.amoLeadId);
      if (!leadId) continue;
      try {
        const tasks = await this.amo.getTasksByEntity('leads', leadId);
        for (const t of tasks) {
          if (t.task_type_id !== MEETING_TASK_TYPE) continue;
          if (seenTaskIds.has(t.id)) continue;
          seenTaskIds.add(t.id);
          result.push({
            id: t.id,
            text: t.text,
            date: new Date(t.complete_till * 1000).toISOString(),
            isCompleted: !!t.is_completed,
            source: 'lead',
            clientName: c.fullName,
            leadId,
          });
        }
      } catch (e: any) {
        console.warn(`[getAmoCrmCalendar] lead ${leadId} failed:`, e?.message || e);
      }
    }

    // Задачи-встречи на contact брокера — если он менеджер / у него закреплены.
    if (broker?.amoContactId) {
      try {
        const contactTasks = await this.amo.getTasksByEntity('contacts', Number(broker.amoContactId));
        for (const t of contactTasks) {
          if (t.task_type_id !== MEETING_TASK_TYPE) continue;
          if (seenTaskIds.has(t.id)) continue;
          seenTaskIds.add(t.id);
          result.push({
            id: t.id,
            text: t.text,
            date: new Date(t.complete_till * 1000).toISOString(),
            isCompleted: !!t.is_completed,
            source: 'contact',
            clientName: null,
            leadId: null,
          });
        }
      } catch (e: any) {
        console.warn('[getAmoCrmCalendar] broker contact tasks failed:', e?.message || e);
      }
    }

    result.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    return result;
  }

  async getMeeting(id: string, brokerId: string) {
    const meeting = await this.prisma.meeting.findUnique({
      where: { id },
      include: {
        client: true,
        broker: { select: { id: true, fullName: true, phone: true } },
      },
    });

    if (!meeting) throw new NotFoundException('Meeting not found');

    if (meeting.brokerId !== brokerId) {
      const requester = await this.prisma.broker.findUnique({ where: { id: brokerId } });
      if (requester?.role === 'BROKER') throw new NotFoundException('Meeting not found');
    }

    return meeting;
  }

  async createMeeting(
    brokerId: string,
    data: { clientId: string; type: string; date?: string; slotId?: string; comment?: string; extraPhone?: string; notifySms?: boolean; notifyEmail?: boolean; notifyReminder?: boolean },
  ) {
    const client = await this.prisma.client.findUnique({ where: { id: data.clientId } });
    if (!client) throw new NotFoundException('Client not found');
    if (client.brokerId !== brokerId) throw new BadRequestException('Client does not belong to you');

    let meetingDate: Date;
    let slotId: string | undefined;

    if (data.slotId) {
      const slot = await this.prisma.meetingSlot.findUnique({ where: { id: data.slotId } });
      if (!slot || !slot.isActive) throw new BadRequestException('Слот не существует или отключён');
      if (slot.type && slot.type !== data.type) {
        throw new BadRequestException('Тип встречи не соответствует слоту');
      }
      const booked = await this.prisma.meeting.count({
        where: { slotId: slot.id, status: { not: 'CANCELLED' } },
      });
      if (booked >= slot.capacity) {
        throw new BadRequestException('Слот полностью занят');
      }
      meetingDate = slot.startsAt;
      slotId = slot.id;
    } else if (data.date) {
      meetingDate = new Date(data.date);
      if (isNaN(meetingDate.getTime())) throw new BadRequestException('Invalid date');
    } else {
      throw new BadRequestException('Required: slotId or date');
    }

    const commentParts = [
      data.comment,
      data.extraPhone ? `Доп. телефон: ${data.extraPhone}` : '',
    ].filter(Boolean);

    const meeting = await this.prisma.meeting.create({
      data: {
        clientId: data.clientId,
        brokerId,
        type: data.type as any,
        date: meetingDate,
        slotId,
        comment: commentParts.join('. ') || null,
      },
      include: { client: { select: { id: true, fullName: true, phone: true, email: true } } },
    });

    const typeLabel = data.type === 'OFFICE_VISIT' ? 'в офисе' : data.type === 'ONLINE' ? 'онлайн' : 'брокер-тур';
    const dateStr = meetingDate.toLocaleString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
    const body = `Встреча ${typeLabel} с клиентом ${meeting.client.fullName} запланирована на ${dateStr}`;

    try {
      if (data.notifySms) {
        await this.notificationQueue.add('send', { brokerId, channel: 'SMS', body });
      }
      if (data.notifyEmail) {
        await this.notificationQueue.add('send', { brokerId, channel: 'EMAIL', subject: 'Встреча запланирована', body });
      }
      if (data.notifyReminder) {
        const reminderAt = new Date(meetingDate.getTime() - 2 * 60 * 60 * 1000);
        const delay = Math.max(0, reminderAt.getTime() - Date.now());
        await this.notificationQueue.add(
          'send',
          { brokerId, channel: 'SMS', body: `Напоминание: встреча с ${meeting.client.fullName} через 2 часа (${dateStr})` },
          { delay },
        );
      }
    } catch (e) {
      console.error('Notification queue failed:', e);
    }

    // Update broker funnel stage if needed
    const broker = await this.prisma.broker.findUnique({ where: { id: brokerId } });
    if (broker && ['NEW_BROKER', 'BROKER_TOUR', 'FIXATION'].includes(broker.funnelStage)) {
      await this.prisma.broker.update({
        where: { id: brokerId },
        data: { funnelStage: 'MEETING' },
      });
    }

    // Sync встречи в amoCRM (правка #10 аудита 2026-05-22): если у клиента
    // есть amoLeadId — добавляем note к лиду с инфой о встрече. Менеджеру
    // в amo видно что брокер запланировал встречу. Note — самый простой
    // способ; в будущем можно записать в custom_field «Дата и время встречи»
    // когда узнаем точный field_id из инспектора.
    const clientForAmo = await this.prisma.client.findUnique({
      where: { id: data.clientId },
      select: { amoLeadId: true },
    });
    if (clientForAmo?.amoLeadId) {
      // 2026-06-15: воронки продаж broker-platform не трогает. Если лид
      // клиента уже в Зорге9/Берзарина/Толбухина — не пишем ни ноту, ни
      // задачу. Этой картой управляет админ/менеджер продаж.
      const fullLead = await this.amo
        .getLead(Number(clientForAmo.amoLeadId))
        .catch(() => null);
      const leadPipelineId = Number((fullLead as any)?.pipeline_id || 0);
      if (leadPipelineId && isSalesPipeline(leadPipelineId)) {
        console.log(`[createMeeting] лид ${clientForAmo.amoLeadId} в sales-pipeline ${leadPipelineId} — пропускаем amo-запись`);
      } else {
        const note = `Брокер запланировал встречу: ${typeLabel}\nКлиент: ${meeting.client.fullName} (${meeting.client.phone})\nКогда: ${dateStr}\nКомментарий: ${meeting.comment || '(без комментария)'}`;
        this.amo.addNoteToLead(Number(clientForAmo.amoLeadId), note).catch((e) => {
          console.error('amoCRM addNoteToLead failed:', e?.message || e);
        });

        // 2026-06-15 (правки Ксении KB5 п.2В): создаём задачу в amoCRM на
        // менеджера встреч (Ксения), чтобы встреча отобразилась в её
        // календаре.
        const managerId = Number(process.env.AMO_BROKER_MEETINGS_MANAGER_ID || 0);
        if (managerId) {
          const meetingTaskTypeId = Number(process.env.AMO_MEETING_TASK_TYPE_ID || 2);
          const taskText = `Встреча ${typeLabel} с клиентом ${meeting.client.fullName} (${meeting.client.phone}). Брокер: ${broker?.fullName || '—'}.${meeting.comment ? ` Коммент: ${meeting.comment}` : ''}`;
          this.amo.createTask({
            text: taskText,
            entityType: 'leads',
            entityId: Number(clientForAmo.amoLeadId),
            taskTypeId: meetingTaskTypeId,
            completeTillSec: Math.floor(meetingDate.getTime() / 1000),
            responsibleUserId: managerId,
          }).catch((e) => {
            console.error('amoCRM createTask (meeting) failed:', e?.message || e);
          });
        }
      }
    }

    return meeting;
  }

  async updateMeeting(
    id: string,
    brokerId: string,
    data: { date?: string; comment?: string; status?: string; type?: string; extraPhone?: string },
  ) {
    const meeting = await this.prisma.meeting.findUnique({ where: { id } });
    if (!meeting) throw new NotFoundException('Meeting not found');
    if (meeting.brokerId !== brokerId) {
      const requester = await this.prisma.broker.findUnique({ where: { id: brokerId } });
      if (requester?.role === 'BROKER') throw new BadRequestException('Not your meeting');
    }

    const updateData: any = {};
    if (data.date) updateData.date = new Date(data.date);
    if (data.status) updateData.status = data.status;
    if (data.type) updateData.type = data.type;

    // Preserve/append "Доп. телефон" in comment
    if (data.comment !== undefined || data.extraPhone !== undefined) {
      const parts: string[] = [];
      const rawComment = data.comment !== undefined ? data.comment : (meeting.comment || '').replace(/\.?\s*Доп\. телефон:.*$/, '').trim();
      if (rawComment) parts.push(rawComment);
      if (data.extraPhone) parts.push(`Доп. телефон: ${data.extraPhone}`);
      updateData.comment = parts.join('. ') || null;
    }

    return this.prisma.meeting.update({
      where: { id },
      data: updateData,
      include: { client: { select: { id: true, fullName: true, phone: true } } },
    });
  }

  async cancelMeeting(id: string, brokerId: string) {
    return this.updateMeeting(id, brokerId, { status: 'CANCELLED' });
  }

  // ─── Slots ────────────────────────────────────────────────

  async getAvailableSlots(query: { date?: string; from?: string; to?: string; type?: string }) {
    let from: Date;
    let to: Date;

    if (query.date) {
      const d = new Date(query.date);
      if (isNaN(d.getTime())) throw new BadRequestException('Invalid date');
      from = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
      to = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
    } else if (query.from && query.to) {
      from = new Date(query.from);
      to = new Date(query.to);
    } else {
      const now = new Date();
      from = now;
      to = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    }

    const where: any = {
      isActive: true,
      startsAt: { gte: from, lte: to },
    };
    if (query.type) where.OR = [{ type: query.type as any }, { type: null }];

    const slots = await this.prisma.meetingSlot.findMany({
      where,
      orderBy: { startsAt: 'asc' },
    });

    // Compute booked counts in one query
    const slotIds = slots.map((s) => s.id);
    const booked = slotIds.length
      ? await this.prisma.meeting.groupBy({
          by: ['slotId'],
          where: { slotId: { in: slotIds }, status: { not: 'CANCELLED' } },
          _count: true,
        })
      : [];
    const bookedMap = new Map(booked.map((b) => [b.slotId, b._count]));

    // 2026-06-15 (правки Ксении KB5 п.2В): синхронизируем с календарём
    // Ксении в amoCRM. Берём её незавершённые задачи в нужном окне и
    // вычитаем из доступности — слот, попадающий на задачу, считаем
    // занятым. Если AMO_BROKER_MEETINGS_MANAGER_ID не задан или amo
    // недоступен — fail-soft, отдаём только локальную картину.
    const managerId = Number(process.env.AMO_BROKER_MEETINGS_MANAGER_ID || 0);
    const amoBusy = managerId
      ? await this.amo
          .getOpenTasksForUser(
            managerId,
            Math.floor(from.getTime() / 1000),
            Math.floor(to.getTime() / 1000),
          )
          .catch(() => [])
      : [];

    return slots.map((s) => {
      const bookedCount = bookedMap.get(s.id) || 0;
      const slotStart = s.startsAt.getTime();
      const slotEnd = slotStart + s.durationMin * 60 * 1000;
      // Слот пересекается с задачей если интервал задачи [task_start, complete_till]
      // (где task_start = complete_till - 1h) накладывается на [slotStart, slotEnd].
      const isBusyInAmo = amoBusy.some((t) => {
        const taskEnd = t.completeTill;
        const taskStart = taskEnd - t.durationSec * 1000;
        return taskStart < slotEnd && taskEnd > slotStart;
      });
      const effectiveBooked = isBusyInAmo ? s.capacity : bookedCount;
      return {
        id: s.id,
        startsAt: s.startsAt,
        durationMin: s.durationMin,
        capacity: s.capacity,
        type: s.type,
        booked: effectiveBooked,
        available: Math.max(0, s.capacity - effectiveBooked),
        // диагностика — фронт может показывать «у менеджера занято» отдельно
        // от «слот полностью забронирован брокерами»
        ...(isBusyInAmo ? { busyInAmoCrm: true } : {}),
      };
    });
  }

  async listSlotsAdmin(query: { from?: string; to?: string }) {
    const where: any = {};
    if (query.from || query.to) {
      where.startsAt = {};
      if (query.from) where.startsAt.gte = new Date(query.from);
      if (query.to) where.startsAt.lte = new Date(query.to);
    }
    const slots = await this.prisma.meetingSlot.findMany({
      where,
      orderBy: { startsAt: 'asc' },
      take: 500,
    });
    const slotIds = slots.map((s) => s.id);
    const booked = slotIds.length
      ? await this.prisma.meeting.groupBy({
          by: ['slotId'],
          where: { slotId: { in: slotIds }, status: { not: 'CANCELLED' } },
          _count: true,
        })
      : [];
    const bookedMap = new Map(booked.map((b) => [b.slotId, b._count]));
    return slots.map((s) => ({
      ...s,
      booked: bookedMap.get(s.id) || 0,
    }));
  }

  async createSlots(data: {
    startsAt?: string;
    durationMin?: number;
    capacity?: number;
    type?: string;
    // Bulk: generate range days × times
    days?: string[];          // ['2026-05-01', ...]
    times?: string[];         // ['10:00', '11:00', ...]
  }) {
    if (Array.isArray(data.days) && Array.isArray(data.times) && data.days.length && data.times.length) {
      const created: any[] = [];
      for (const day of data.days) {
        for (const time of data.times) {
          const [h, m] = time.split(':').map(Number);
          if (isNaN(h) || isNaN(m)) continue;
          // Слоты задаются админом в Europe/Moscow (UTC+3). Явный offset
          // нужен, чтобы серверная TZ (UTC в Docker) не сдвигала часы.
          const dt = new Date(
            `${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+03:00`,
          );
          if (isNaN(dt.getTime())) continue;
          // Skip duplicates
          const exists = await this.prisma.meetingSlot.findFirst({
            where: { startsAt: dt, type: data.type as any || null },
          });
          if (exists) continue;
          const slot = await this.prisma.meetingSlot.create({
            data: {
              startsAt: dt,
              durationMin: data.durationMin || 60,
              capacity: data.capacity || 1,
              type: (data.type as any) || null,
            },
          });
          created.push(slot);
        }
      }
      return { created: created.length, slots: created };
    }

    if (!data.startsAt) throw new BadRequestException('startsAt or days+times required');
    const dt = new Date(data.startsAt);
    if (isNaN(dt.getTime())) throw new BadRequestException('Invalid startsAt');

    const slot = await this.prisma.meetingSlot.create({
      data: {
        startsAt: dt,
        durationMin: data.durationMin || 60,
        capacity: data.capacity || 1,
        type: (data.type as any) || null,
      },
    });
    return { created: 1, slots: [slot] };
  }

  async updateSlot(id: string, data: { capacity?: number; durationMin?: number; isActive?: boolean; startsAt?: string }) {
    const slot = await this.prisma.meetingSlot.findUnique({ where: { id } });
    if (!slot) throw new NotFoundException('Slot not found');

    const update: any = {};
    if (data.capacity !== undefined) update.capacity = data.capacity;
    if (data.durationMin !== undefined) update.durationMin = data.durationMin;
    if (data.isActive !== undefined) update.isActive = data.isActive;
    if (data.startsAt) {
      const dt = new Date(data.startsAt);
      if (!isNaN(dt.getTime())) update.startsAt = dt;
    }

    return this.prisma.meetingSlot.update({ where: { id }, data: update });
  }

  async deleteSlot(id: string) {
    // Block delete if there are active meetings booked into this slot
    const booked = await this.prisma.meeting.count({
      where: { slotId: id, status: { not: 'CANCELLED' } },
    });
    if (booked > 0) {
      throw new BadRequestException(`Слот используется в ${booked} активных встречах`);
    }
    await this.prisma.meetingSlot.delete({ where: { id } });
    return { ok: true };
  }

  async signAct(id: string, brokerId: string) {
    const meeting = await this.prisma.meeting.findUnique({
      where: { id },
      include: { client: true },
    });

    if (!meeting) throw new NotFoundException('Meeting not found');
    if (meeting.brokerId !== brokerId) throw new BadRequestException('Not your meeting');

    const updatedMeeting = await this.prisma.meeting.update({
      where: { id },
      data: { actSigned: true, status: 'COMPLETED' },
    });

    // Update client fixation status when act is signed
    await this.prisma.client.update({
      where: { id: meeting.clientId },
      data: {
        fixationStatus: 'FIXED',
        fixationExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        inspectionActSigned: true,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        userId: brokerId,
        action: 'ACT_SIGNED',
        entity: 'Meeting',
        entityId: id,
        payload: { clientId: meeting.clientId },
      },
    });

    return { meeting: updatedMeeting, message: 'Act signed. Client fixation updated.' };
  }
}
