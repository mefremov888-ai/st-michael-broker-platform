import { Module } from '@nestjs/common';
import { DocumentsController } from './documents.controller';
import { DocumentsAdminController } from './documents.admin.controller';
import { DocumentsPublicController } from './documents.public.controller';
import { DocumentsService } from './documents.service';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [DocumentsController, DocumentsAdminController, DocumentsPublicController],
  providers: [DocumentsService],
})
export class DocumentsModule {}
