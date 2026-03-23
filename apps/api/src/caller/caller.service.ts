import { Injectable, Inject } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';

@Injectable()
export class CallerService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async getCalls() {
    // TODO: Implement with broker context
    return { calls: [], total: 0 };
  }

  async scheduleCalls(data: any) {
    // TODO: Implement BullMQ job scheduling
    return { message: 'Call campaign scheduled' };
  }
}