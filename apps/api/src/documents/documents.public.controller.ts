import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { DocumentsService } from './documents.service';

@ApiTags('public-documents')
@Controller('public/documents')
export class DocumentsPublicController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get()
  @ApiOperation({ summary: 'Public landing documents (only isPublic=true)' })
  async listPublic(@Query('category') category?: string, @Query('subcategory') subcategory?: string) {
    const data = await this.documentsService.getDocuments({
      category,
      subcategory,
      onlyPublic: true,
      limit: 2000,
    });
    return data.documents;
  }
}
