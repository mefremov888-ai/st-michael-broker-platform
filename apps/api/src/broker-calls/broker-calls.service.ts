import {
  Injectable,
  Inject,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';
import {
  MangoAdapter,
  AmoCrmAdapter,
  getMangoConfig,
} from '@st-michael/integrations';
import { PUBLIC_CALL_SELECT, toPublicCall } from '../common/public-call';
import { MangoCallSafetyService } from '../common/mango-call-safety.service';
import { CurrentUserPayload } from '../auth/current-user.decorator';

const STAFF_ROLES = new Set(['ADMIN', 'MANAGER']);

@Injectable()
export class BrokerCallsService {
  private mango = new MangoAdapter();
  private amo = new AmoCrmAdapter();

  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    private readonly mangoCallSafety: MangoCallSafetyService,
  ) {}

  /**
   * Сотрудник КЦ звонит клиенту через Mango.
   * 1. Mango звонит на внутренний номер сотрудника (mangoEmployeeNum).
   * 2. Сотрудник берёт трубку — Mango дозванивается до клиента и соединяет.
   * 3. Финальный результат прилетит в /webhooks/mango/call-result.
   *
   * Обычные брокеры эту кнопку не получают: callback идёт только с линии КЦ.
   */
  async initiate(
    user: Pick<CurrentUserPayload, 'id' | 'role'>,
    clientId: string,
    idempotencyKey?: string,
  ) {
    if (!STAFF_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'Звонок клиенту через Mango доступен только сотрудникам колл-центра',
      );
    }

    return this.mangoCallSafety.execute(
      { actorId: user.id, scope: 'client', targetId: clientId, idempotencyKey },
      async () => {
        const operator = await this.prisma.broker.findUnique({
          where: { id: user.id },
        });
        if (!operator) throw new NotFoundException('Сотрудник не найден');
        if (!STAFF_ROLES.has(String(operator.role))) {
          throw new ForbiddenException(
            'Звонок клиенту через Mango доступен только сотрудникам колл-центра',
          );
        }
        if (!operator.mangoEmployeeNum) {
          throw new BadRequestException(
            'У вас не заполнен внутренний номер Mango (mangoEmployeeNum) — обратитесь к администратору',
          );
        }

        const client = await this.prisma.client.findUnique({
          where: { id: clientId },
        });
        if (!client) throw new NotFoundException('Client not found');
        if (!client.phone) {
          throw new BadRequestException('У клиента не указан телефон');
        }

        const mangoConfig = getMangoConfig();
        let callId: string;
        if (mangoConfig.apiKey && mangoConfig.apiSalt) {
          const r = await this.mango.initiateCallbackFromExtension({
            extension: operator.mangoEmployeeNum,
            to: client.phone,
          });
          callId = r.callId;
        } else if (mangoConfig.callbackUrl) {
          const r = await this.mango.initiateCallbackViaWebhook({
            employeeNum: operator.mangoEmployeeNum,
            phone: client.phone,
          });
          callId = r.callId;
        } else {
          throw new BadRequestException(
            'Mango не настроен: нужны VPBX ключи или callback URL',
          );
        }

        const call = await this.prisma.call.create({
          data: {
            brokerId: operator.id,
            clientId,
            mangoCallId: callId,
            direction: 'OUTBOUND',
            status: 'INITIATED' as any,
            attemptNumber: 1,
            cycleDay: 0,
          },
        });

        if (client.amoLeadId) {
          const note = `📞 КЦ ${operator.fullName} инициировал звонок клиенту ${client.fullName} (${client.phone})`;
          this.amo.addNoteToLead(Number(client.amoLeadId), note).catch((e: any) => {
            console.error('[broker-calls] amo addNoteToLead failed:', e?.message || e);
          });
        }

        return {
          callId: call.id,
          mangoCallId: callId,
          message:
            'Mango сейчас позвонит вам на рабочий телефон — возьмите трубку, соединим с клиентом.',
        };
      },
    );
  }

  /**
   * Журнал звонков сотрудника КЦ, фильтр по клиенту (опционально).
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
