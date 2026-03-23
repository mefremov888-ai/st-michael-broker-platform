import { Injectable, Inject } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaClient } from '@st-michael/database';
import { AuthService } from './auth.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    @Inject('PrismaClient') private prisma: PrismaClient,
    private authService: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET,
    });
  }

  async validate(payload: any) {
    const broker = await this.authService.validateBroker(payload.sub);
    if (!broker) {
      return null;
    }

    return {
      id: broker.id,
      phone: broker.phone,
      role: broker.role,
      fullName: broker.fullName,
    };
  }
}