import { Module } from '@nestjs/common';
import { AmocrmController } from './amocrm.controller';
import { AmocrmService } from './amocrm.service';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule],
  controllers: [AmocrmController],
  providers: [AmocrmService],
  exports: [AmocrmService],
})
export class AmocrmModule {}
