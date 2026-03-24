import { Injectable, Inject, BadRequestException, Logger } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';
import * as crypto from 'crypto';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  private verifyHmac(payload: string, signature: string, secret: string): boolean {
    if (!secret) return true; // Skip verification if no secret configured
    const computed = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
  }

  // ─── amoCRM Lead Update ─────────────────────────────
  async handleAmoLeadUpdate(data: any, headers: any) {
    const secret = process.env.AMO_WEBHOOK_SECRET || '';
    if (secret && headers['x-amo-signature']) {
      if (!this.verifyHmac(JSON.stringify(data), headers['x-amo-signature'], secret)) {
        throw new BadRequestException('Invalid signature');
      }
    }

    this.logger.log(`amoCRM lead update: lead_id=${data.id}, status_id=${data.status_id}`);

    // Find deal linked to this amoCRM lead
    const deal = await this.prisma.deal.findFirst({
      where: { amoDealId: BigInt(data.id) },
      include: { client: true },
    });

    if (!deal) {
      this.logger.warn(`No deal found for amo lead ${data.id}`);
      // Try to find client by amo lead ID
      const client = await this.prisma.client.findFirst({
        where: { amoLeadId: BigInt(data.id) },
      });
      if (client && data.status_id) {
        await this.prisma.client.update({
          where: { id: client.id },
          data: { comment: `amoCRM статус обновлён: ${data.status_id}` },
        });
      }
      return { status: 'processed', matched: false };
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
    if (data.status_id && statusMap[data.status_id]) {
      updateData.status = statusMap[data.status_id];
      if (updateData.status === 'SIGNED') updateData.signedAt = new Date();
      if (updateData.status === 'PAID') updateData.paidAt = new Date();
    }
    if (data.price) {
      updateData.amount = data.price;
      updateData.commissionAmount = (data.price * Number(deal.commissionRate)) / 100;
    }

    if (Object.keys(updateData).length > 0) {
      await this.prisma.deal.update({ where: { id: deal.id }, data: updateData });
    }

    // Update agency attachment on ДВОУ stage
    if (data.custom_fields) {
      const agencyField = data.custom_fields.find((f: any) => f.field_name === 'agency_id');
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
        payload: { amoLeadId: data.id, statusId: data.status_id },
      },
    });

    return { status: 'processed', dealId: deal.id };
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

    const updateData: any = {};
    if (data.name) updateData.fullName = data.name;

    // Extract phone from custom fields
    if (data.custom_fields_values) {
      const phoneField = data.custom_fields_values.find((f: any) => f.field_code === 'PHONE');
      if (phoneField?.values?.[0]?.value) {
        updateData.phone = phoneField.values[0].value;
      }
      const emailField = data.custom_fields_values.find((f: any) => f.field_code === 'EMAIL');
      if (emailField?.values?.[0]?.value) {
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

    // Find existing call record or create new
    const existingCall = await this.prisma.call.findFirst({
      where: { mangoCallId: data.call_id },
    });

    if (existingCall) {
      await this.prisma.call.update({
        where: { id: existingCall.id },
        data: {
          status: (statusMap[data.status] || 'COMPLETED') as any,
          durationSec: data.duration || 0,
          recordingUrl: data.recording_url,
        },
      });
      return { status: 'processed', callId: existingCall.id, action: 'updated' };
    }

    // Try to match broker by phone from call data
    if (data.to_number || data.from_number) {
      const brokerPhone = data.direction === 'outbound' ? data.from_number : data.to_number;
      const broker = await this.prisma.broker.findFirst({
        where: { phone: brokerPhone },
      });

      if (broker) {
        const call = await this.prisma.call.create({
          data: {
            brokerId: broker.id,
            mangoCallId: data.call_id,
            direction: data.direction === 'outbound' ? 'OUTBOUND' : 'INBOUND',
            status: (statusMap[data.status] || 'COMPLETED') as any,
            durationSec: data.duration || 0,
            recordingUrl: data.recording_url,
          },
        });
        return { status: 'processed', callId: call.id, action: 'created' };
      }
    }

    this.logger.warn(`No broker matched for call ${data.call_id}`);
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
}
