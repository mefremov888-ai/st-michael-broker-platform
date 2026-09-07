import { Module, OnModuleInit } from '@nestjs/common';
import { CmsService } from './cms.service';
import { PublicCmsController } from './cms.public.controller';
import { AdminCmsController } from './cms.admin.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [PublicCmsController, AdminCmsController],
  providers: [CmsService],
  exports: [CmsService],
})
export class CmsModule implements OnModuleInit {
  constructor(private cms: CmsService) {}

  async onModuleInit() {
    try {
      await this.cms.seedDefaults();
    } catch (e) {
      console.warn('[CMS] seedDefaults failed (tables may not exist yet):', (e as any)?.message || e);
    }
  }
}
