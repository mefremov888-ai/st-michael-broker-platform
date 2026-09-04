import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RegistryDealsController } from './registry-deals.controller';
import { RegistryDealsService } from './registry-deals.service';

// 2026-09-04: read-only admin-аналитика по «Реестру сделок» (registry_deals).
@Module({
  imports: [DatabaseModule],
  controllers: [RegistryDealsController],
  providers: [RegistryDealsService],
})
export class RegistryDealsModule {}
