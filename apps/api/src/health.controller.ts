import {
  Controller,
  Get,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  check() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      // 2026-08-20: до этого поля не было способа быстро узнать, реально ли
      // последний push в master выложен на сервер, не копаясь в логах
      // workflow — деплой стал ручным (см. deploy.yml, confirm_production)
      // и молча пропускался несколько раз подряд, оставаясь незамеченным.
      deployedSha: process.env.GIT_SHA || 'unknown',
    };
  }

  @Get('ready')
  async checkReadiness() {
    const result = await this.healthService.checkReadiness();

    if (result.status !== 'ok') {
      throw new ServiceUnavailableException(result);
    }

    return result;
  }
}
