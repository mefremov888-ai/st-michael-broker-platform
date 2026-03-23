import { Injectable, Inject, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@st-michael/database';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    private jwtService: JwtService,
  ) {}

  async register(data: { phone: string }) {
    // Check if broker already exists
    const existingBroker = await this.prisma.broker.findUnique({
      where: { phone: data.phone },
    });

    if (existingBroker) {
      throw new BadRequestException('Broker with this phone already exists');
    }

    // Create broker with PENDING status
    const broker = await this.prisma.broker.create({
      data: {
        phone: data.phone,
        status: 'PENDING',
      },
    });

    // TODO: Send SMS OTP
    // For now, return success
    return {
      message: 'Registration initiated. Please check SMS for OTP.',
      brokerId: broker.id,
    };
  }

  async login(data: { phone: string; otp: string }) {
    // TODO: Verify OTP
    // For now, accept any OTP for registered brokers

    const broker = await this.prisma.broker.findUnique({
      where: { phone: data.phone },
    });

    if (!broker) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (broker.status === 'BLOCKED') {
      throw new UnauthorizedException('Account is blocked');
    }

    // Update status to ACTIVE on first login
    if (broker.status === 'PENDING') {
      await this.prisma.broker.update({
        where: { id: broker.id },
        data: { status: 'ACTIVE' },
      });
    }

    const payload = { sub: broker.id, phone: broker.phone, role: broker.role };
    const accessToken = this.jwtService.sign(payload);
    const refreshToken = this.jwtService.sign(payload, {
      expiresIn: process.env.JWT_REFRESH_TTL || '7d',
    });

    return {
      accessToken,
      refreshToken,
      broker: {
        id: broker.id,
        fullName: broker.fullName,
        phone: broker.phone,
        role: broker.role,
        status: broker.status,
      },
    };
  }

  async refreshToken(refreshToken: string) {
    try {
      const payload = this.jwtService.verify(refreshToken);
      const broker = await this.prisma.broker.findUnique({
        where: { id: payload.sub },
      });

      if (!broker || broker.status === 'BLOCKED') {
        throw new UnauthorizedException('Invalid refresh token');
      }

      const newPayload = { sub: broker.id, phone: broker.phone, role: broker.role };
      const accessToken = this.jwtService.sign(newPayload);

      return { accessToken };
    } catch (error) {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async validateBroker(brokerId: string) {
    const broker = await this.prisma.broker.findUnique({
      where: { id: brokerId },
    });

    if (!broker || broker.status === 'BLOCKED') {
      return null;
    }

    return broker;
  }
}