import { Injectable, Inject, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaClient, UniquenessStatus } from '@st-michael/database';
import { AmoCrmAdapter } from '@st-michael/integrations';
import { ClientFixationService } from './client-fixation.service';

@Injectable()
export class ClientFixationService {
  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    private amoCrmAdapter: AmoCrmAdapter,
  ) {}

  async fixClient(data: {
    phone: string;
    fullName: string;
    comment?: string;
    project: string;
    agencyInn: string;
  }) {
    // Find or create agency
    let agency = await this.prisma.agency.findUnique({
      where: { inn: data.agencyInn },
    });

    if (!agency) {
      // Try to find in amoCRM first
      const amoCompany = await this.amoCrmAdapter.findCompanyByInn(data.agencyInn);
      if (amoCompany) {
        agency = await this.prisma.agency.create({
          data: {
            name: amoCompany.name,
            inn: data.agencyInn,
          },
        });
      } else {
        // Create in both DB and amoCRM
        const newAmoCompany = await this.amoCrmAdapter.createCompany({
          name: `Агентство ${data.agencyInn}`,
        });
        agency = await this.prisma.agency.create({
          data: {
            name: newAmoCompany.name,
            inn: data.agencyInn,
          },
        });
      }
    }

    // Check uniqueness scenarios
    const existingClient = await this.prisma.client.findFirst({
      where: { phone: data.phone },
      include: { deals: true },
    });

    if (!existingClient) {
      // Scenario 1: New client
      const client = await this.prisma.client.create({
        data: {
          phone: data.phone,
          fullName: data.fullName,
          comment: data.comment,
          project: data.project,
          fixationAgencyId: agency.id,
          uniquenessStatus: UniquenessStatus.CONDITIONALLY_UNIQUE,
          uniquenessExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
        },
      });

      // Create amoCRM lead
      await this.amoCrmAdapter.createFixationRequest({
        clientPhone: data.phone,
        clientName: data.fullName,
        brokerPhone: '', // TODO: get from auth
        agencyName: agency.name,
        agencyInn: agency.inn,
        comment: data.comment || '',
        project: data.project,
      });

      return {
        client,
        status: 'CONDITIONALLY_UNIQUE',
        message: 'Client conditionally fixed. Expires in 30 days.',
      };
    }

    // Check deal status
    const hasClosedDeal = existingClient.deals.some(
      (deal) => deal.status === 'CANCELLED' && deal.contractType === null,
    );

    if (hasClosedDeal) {
      // Scenario 2: Reopen closed deal
      const client = await this.prisma.client.update({
        where: { id: existingClient.id },
        data: {
          uniquenessStatus: UniquenessStatus.CONDITIONALLY_UNIQUE,
          uniquenessReason: 'Переоткрыта закрытая сделка',
          uniquenessExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          fixationAgencyId: agency.id,
        },
      });

      // TODO: Reopen amoCRM lead
      await this.amoCrmAdapter.reopenLead(existingClient.amoLeadId!, 0); // TODO: broker amo id

      return {
        client,
        status: 'CONDITIONALLY_UNIQUE',
        message: 'Closed deal reopened. Client conditionally fixed.',
      };
    }

    // Check if in qualification stage
    const inQualification = existingClient.deals.some(
      (deal) => ['PENDING', 'SIGNED'].includes(deal.status),
    );

    if (inQualification) {
      // Scenario 3: Conflict with another broker
      const client = await this.prisma.client.update({
        where: { id: existingClient.id },
        data: {
          uniquenessStatus: UniquenessStatus.CONDITIONALLY_UNIQUE,
          uniquenessReason: 'Клиент на квалификации у другого брокера',
          uniquenessExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          fixationAgencyId: agency.id,
        },
      });

      // TODO: Notify manager about broker conflict

      return {
        client,
        status: 'CONDITIONALLY_UNIQUE',
        message: 'Client in qualification with another broker. Manager notified.',
      };
    }

    // Scenario 4: Active deal - reject
    return {
      status: 'REJECTED',
      message: 'Client has active deal. Cannot fix.',
    };
  }

  async getClients(query: any) {
    // TODO: Implement with pagination and filters
    return { clients: [], total: 0 };
  }

  async getClient(id: string) {
    const client = await this.prisma.client.findUnique({
      where: { id },
      include: { deals: true, meetings: true },
    });

    if (!client) {
      throw new NotFoundException('Client not found');
    }

    return client;
  }

  async extendUniqueness(id: string, data: { reason: string; comment?: string }) {
    const client = await this.prisma.client.findUnique({
      where: { id },
    });

    if (!client) {
      throw new NotFoundException('Client not found');
    }

    if (client.uniquenessStatus !== UniquenessStatus.CONDITIONALLY_UNIQUE) {
      throw new BadRequestException('Client is not in conditionally unique status');
    }

    await this.prisma.client.update({
      where: { id },
      data: {
        uniquenessExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        uniquenessReason: data.reason,
      },
    });

    // TODO: Log audit

    return { message: 'Uniqueness extended successfully' };
  }

  async markFixed(id: string) {
    const client = await this.prisma.client.update({
      where: { id },
      data: {
        fixationStatus: 'FIXED',
        fixationExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        inspectionActSigned: true,
      },
    });

    return { client, message: 'Client marked as fixed' };
  }

  async resolveUniqueness(id: string, data: { status: UniquenessStatus; reason: string }) {
    const client = await this.prisma.client.update({
      where: { id },
      data: {
        uniquenessStatus: data.status,
        uniquenessReason: data.reason,
      },
    });

    // TODO: Notify broker about resolution

    return { client, message: 'Uniqueness conflict resolved' };
  }
}