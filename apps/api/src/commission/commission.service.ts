import { Injectable, Inject } from '@nestjs/common';
import { PrismaClient, CommissionLevel } from '@st-michael/database';

@Injectable()
export class CommissionService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async getMyCommission() {
    // TODO: Implement with broker context
    return {
      level: CommissionLevel.START,
      rate: 5.0,
      progress: 0,
      bonus: 0,
    };
  }

  async calculateCommission(data: { amount: number; project: string; agencyInn: string; isInstallment?: boolean }) {
    // TODO: Get actual agency level
    const level = CommissionLevel.START;
    let rate = 5.0;

    // Зорге 9 rates
    if (data.project === 'ZORGE9') {
      switch (level) {
        case CommissionLevel.START: rate = 5.0; break;
        case CommissionLevel.BASIC: rate = 5.5; break;
        case CommissionLevel.STRONG: rate = 6.0; break;
        case CommissionLevel.PREMIUM: rate = 6.5; break;
        case CommissionLevel.ELITE: rate = 7.0; break;
        case CommissionLevel.CHAMPION: rate = 7.5; break;
        case CommissionLevel.LEGEND: rate = 8.0; break;
      }
    }

    if (data.isInstallment) {
      rate -= 0.5;
    }

    const commission = (data.amount * rate) / 100;

    return {
      amount: data.amount,
      rate,
      commission,
    };
  }
}