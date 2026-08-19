import { Injectable, Inject, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';
import {
  MangoAdapter,
  AmoCrmAdapter,
  getMangoConfig,
} from '@st-michael/integrations';
import { PUBLIC_CALL_SELECT, toPublicCall } from '../common/public-call';
import { MangoCallSafetyService } from '../common/mango-call-safety.service';

@Injectable()
export class BrokerCallsService {
  private mango = new MangoAdapter();
  private amo = new AmoCrmAdapter();

  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    private readonly mangoCallSafety: MangoCallSafetyService,
  ) {}

  /**
   * Брокер инициирует callback клиенту через Mango.
   * 1. Mango звонит на broker.phone, брокер берёт трубку.
   * 2. Mango дозванивается до client.phone, соединяет.
   * 3. Финальный результат прилетит в /webhooks/mango/call-result —
   *    обновится duration, recording_url, status.
   *
   * Мы пишем запись Call СРАЗУ при инициации (со status=INITIATED),
   * чтобы у пользователя в журнале появилась строка «звоню сейчас…»,
   * даже если Mango/webhook задержатся.
   */
  async initiate(brokerId: string, clientId: string, idempotencyKey?: string) {
    return this.mangoCallSafety.execute(
      { actorId: brokerId, scope: 'client', targetId: clientId, idempotencyKey },
      async () => {
        const broker = await this.prisma.broker.findUnique({ where: { id: brokerId } });
        if (!broker) throw new NotFoundException('Broker not found');
        if (broker.doNotCall) {
          throw new BadRequestException('Брокер в чёрном списке (doNotCall)');
        }
        if (!broker.phone) {
          throw new BadRequestException('У вас не указан телефон в профиле');
        }

        const client = await this.prisma.client.findUnique({ where: { id: clientId } });
        if (!client) throw new NotFoundException('Client not found');
        if (client.brokerId !== brokerId) {
          throw new BadRequestException('Этот клиент привязан к другому брокеру');
        }
        if (!client.phone) {
          throw new BadRequestException('У клиента не указан телефон');
        }

    // При настроенных VPBX credentials используем подписанный callback и
    // передаём command_id в Mango: так status webhook надёжно коррелируется
    // с локальной записью. Старый integration-webhook остаётся fallback для
    // инсталляций, где задан только его URL.
        let callId: string;
        const mangoConfig = getMangoConfig();
        if (broker.mangoEmployeeNum && mangoConfig.apiKey && mangoConfig.apiSalt) {
          const r = await this.mango.initiateCallbackFromExtension({
            extension: broker.mangoEmployeeNum,
            to: client.phone,
          });
          callId = r.callId;
        } else if (broker.mangoEmployeeNum && mangoConfig.callbackUrl) {
          const r = await this.mango.initiateCallbackViaWebhook({
            employeeNum: broker.mangoEmployeeNum,
            phone: client.phone,
          });
          callId = r.callId;
        } else {
          const r = await this.mango.initiateCallback({
            from: broker.phone,
            to: client.phone,
          });
          callId = r.callId;
        }

    // Создаём запись Call со статусом «инициирован» — пользователь увидит её
    // в журнале сразу. Webhook позже допишет duration/recording/result.
        const call = await this.prisma.call.create({
          data: {
            brokerId,
            clientId,
            mangoCallId: callId,
            direction: 'OUTBOUND',
            status: 'INITIATED' as any,
            attemptNumber: 1,
            cycleDay: 0,
          },
        });

    // amo-sync: оставляем note в лиде клиента — менеджеру видно сразу,
    // что брокер пошёл звонить. Не критично если упало — звонок уже состоялся.
        if (client.amoLeadId) {
          const note = `📞 Брокер ${broker.fullName} инициировал звонок клиенту ${client.fullName} (${client.phone})`;
          this.amo.addNoteToLead(Number(client.amoLeadId), note).catch((e: any) => {
            console.error('[broker-calls] amo addNoteToLead failed:', e?.message || e);
          });
        }

        return {
          callId: call.id,
          mangoCallId: callId,
          message: 'Mango сейчас наберёт ваш мобильный, возьмите трубку — мы соединим с клиентом.',
        };
      },
    );
  }

  /**
   * Журнал звонков брокера, фильтр по клиенту (опционально).
   */
  async getCalls(brokerId: string, query: { clientId?: string; page?: number; limit?: number }) {
    const page = Number(query.page) || 1;
    const limit = Math.min(Number(query.limit) || 50, 100);
    const skip = (page - 1) * limit;

    const where: any = { brokerId };
    if (query.clientId) where.clientId = query.clientId;

    const [calls, total] = await Promise.all([
      this.prisma.call.findMany({
        where,
        orderBy: { initiatedAt: 'desc' },
        skip,
        take: limit,
        select: {
          ...PUBLIC_CALL_SELECT,
          client: { select: { id: true, fullName: true, phone: true } },
        },
      }),
      this.prisma.call.count({ where }),
    ]);

    return {
      calls: calls.map((call) => toPublicCall(call as any)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
}
