import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DocumentsService } from './documents.service';

@ApiTags('documents')
@Controller('documents')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get()
  @ApiOperation({ summary: 'Get documents (cabinet — sees all, public+private)' })
  async getDocuments(@Query() query: any) {
    return this.documentsService.getDocuments(query);
  }

  @Get('external')
  @ApiOperation({ summary: 'Legacy: scrape external broker page' })
  async getExternalDocuments() {
    return this.documentsService.getExternalDocuments();
  }

  @Get(':id/download')
  async downloadDocument(@Param('id') id: string) {
    return this.documentsService.getDownloadUrl(id);
  }
}
