import { Injectable, Inject } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';

@Injectable()
export class MeetingsService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async getMeetings() {
    // TODO: Implement with broker context
    return { meetings: [], total: 0 };
  }

  async createMeeting(data: any) {
    const meeting = await this.prisma.meeting.create({
      data,
    });

    return meeting;
  }

  async updateMeeting(id: string, data: any) {
    const meeting = await this.prisma.meeting.update({
      where: { id },
      data,
    });

    return meeting;
  }

  async signAct(id: string) {
    const meeting = await this.prisma.meeting.update({
      where: { id },
      data: { actSigned: true },
    });

    // TODO: Update client fixation status

    return { meeting, message: 'Act signed successfully' };
  }
}