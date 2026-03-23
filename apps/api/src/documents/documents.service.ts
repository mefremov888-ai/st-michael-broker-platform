import { Injectable, Inject } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';

@Injectable()
export class DocumentsService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async getDocuments(filters: any) {
    const where: any = {};

    if (filters.category) where.category = filters.category;
    if (filters.project) where.project = filters.project;

    const documents = await this.prisma.document.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    return { documents, total: documents.length };
  }

  async getDownloadUrl(id: string) {
    const document = await this.prisma.document.findUnique({
      where: { id },
    });

    if (!document) {
      throw new Error('Document not found');
    }

    // TODO: Generate presigned S3 URL
    return { url: document.fileUrl };
  }
}