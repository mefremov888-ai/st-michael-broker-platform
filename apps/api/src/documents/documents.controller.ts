import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DocumentsService } from './documents.service';

@ApiTags('documents')
@Controller('documents')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get()
  @ApiOperation({ summary: 'Get documents' })
  @ApiResponse({ status: 200, description: 'List of documents' })
  async getDocuments(@Query() query: any) {
    return this.documentsService.getDocuments(query);
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Download document' })
  @ApiResponse({ status: 200, description: 'Document URL' })
  async downloadDocument(@Param('id') id: string) {
    return this.documentsService.getDownloadUrl(id);
  }
}