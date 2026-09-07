import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { YandexDiskPhotosService } from './yandex-disk-photos.service';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule],
  controllers: [CatalogController],
  providers: [CatalogService, YandexDiskPhotosService],
  exports: [CatalogService, YandexDiskPhotosService],
})
export class CatalogModule {}