import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '@st-michael/shared';
import { CurrentUser, CurrentUserPayload } from '../auth/current-user.decorator';
import { DocumentsService } from './documents.service';

@ApiTags('admin-documents')
@Controller('admin/documents')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.MANAGER)
@ApiBearerAuth()
export class DocumentsAdminController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get()
  async list(@Query() query: any) {
    return this.documentsService.getDocuments(query);
  }

  @Get('folders')
  @ApiOperation({ summary: 'Materials folder grouping (landing + cabinet)' })
  async getFolders() {
    return this.documentsService.getMaterialsFolderLayout();
  }

  @Patch('folders')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Save materials folder grouping' })
  async saveFolders(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { layout?: unknown },
  ) {
    return this.documentsService.saveMaterialsFolderLayout(body.layout as any, user.id);
  }

  @Post('upload')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Upload file (multipart) to local storage' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 200 * 1024 * 1024 } }))
  async upload(@UploadedFile() file: Express.Multer.File, @Body() body: any) {
    return this.documentsService.uploadFile(file, {
      name: body.name,
      description: body.description,
      category: body.category,
      subcategory: body.subcategory,
      project: body.project,
      isPublic: body.isPublic === 'true' || body.isPublic === true,
      sortOrder: body.sortOrder,
    });
  }

  @Post('external')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Add external link as a document' })
  async createExternal(@Body() body: any) {
    return this.documentsService.createExternal(body);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  async update(@Param('id') id: string, @Body() body: any) {
    return this.documentsService.updateDocument(id, body);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  async remove(@Param('id') id: string) {
    return this.documentsService.deleteDocument(id);
  }
}
