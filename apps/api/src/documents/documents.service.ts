import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@st-michael/database';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';

const UPLOADS_ROOT = process.env.UPLOADS_DIR || '/app/uploads';
const PUBLIC_PREFIX = '/files';
const VALID_CATEGORIES = new Set(['cooperation', 'analytics', 'marketing', 'materials']);

@Injectable()
export class DocumentsService {
  constructor(@Inject('PrismaClient') private prisma: PrismaClient) {}

  async getDocuments(filters: {
    category?: string;
    subcategory?: string;
    project?: string;
    onlyPublic?: boolean;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, Number(filters.page) || 1);
    const limit = Math.min(2000, Math.max(1, Number(filters.limit) || 100));
    const skip = (page - 1) * limit;

    const where: any = {};
    if (filters.category) where.category = filters.category;
    if (filters.subcategory) {
      where.OR = [
        { subcategory: filters.subcategory },
        { subcategory: { startsWith: `${filters.subcategory}/` } },
      ];
    }
    if (filters.project) where.project = filters.project;
    if (filters.onlyPublic) where.isPublic = true;

    const [documents, total] = await Promise.all([
      this.prisma.document.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.document.count({ where }),
    ]);

    return { documents, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getDocument(id: string) {
    const doc = await this.prisma.document.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('Document not found');
    return doc;
  }

  async uploadFile(file: Express.Multer.File, meta: {
    name?: string;
    description?: string;
    category: string;
    subcategory?: string;
    project?: string;
    isPublic?: boolean;
    sortOrder?: number;
  }) {
    if (!file) throw new BadRequestException('File required');
    if (!meta.category || !VALID_CATEGORIES.has(meta.category)) {
      throw new BadRequestException(`category must be one of: ${[...VALID_CATEGORIES].join(', ')}`);
    }

    // Multer decodes multipart filename as latin-1; re-decode to UTF-8 so Cyrillic survives.
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const ext = (path.extname(originalName) || '').toLowerCase();
    const fileName = `${randomUUID()}${ext}`;
    const targetDir = path.join(UPLOADS_ROOT, meta.category);
    const targetPath = path.join(targetDir, fileName);

    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(targetPath, file.buffer);

    const fileUrl = `${PUBLIC_PREFIX}/${meta.category}/${fileName}`;
    const typeLabel = (ext.replace('.', '').toUpperCase()) || (file.mimetype.split('/')[1] || 'FILE').toUpperCase();

    return this.prisma.document.create({
      data: {
        name: meta.name?.trim() || originalName,
        description: meta.description || null,
        type: typeLabel,
        category: meta.category,
        subcategory: meta.subcategory || null,
        project: (meta.project as any) || null,
        fileUrl,
        fileSize: file.size,
        isPublic: meta.isPublic !== false,
        sortOrder: Number(meta.sortOrder) || 0,
      },
    });
  }

  async createExternal(meta: {
    name: string;
    description?: string;
    url: string;
    category: string;
    subcategory?: string;
    project?: string;
    isPublic?: boolean;
    sortOrder?: number;
  }) {
    if (!meta.url) throw new BadRequestException('url required');
    if (!meta.category || !VALID_CATEGORIES.has(meta.category)) {
      throw new BadRequestException(`category must be one of: ${[...VALID_CATEGORIES].join(', ')}`);
    }

    return this.prisma.document.create({
      data: {
        name: meta.name,
        description: meta.description || null,
        type: 'URL',
        category: meta.category,
        subcategory: meta.subcategory || null,
        project: (meta.project as any) || null,
        fileUrl: meta.url,
        isPublic: meta.isPublic !== false,
        sortOrder: Number(meta.sortOrder) || 0,
      },
    });
  }

  async updateDocument(id: string, patch: any) {
    const data: any = {};
    for (const k of ['name', 'description', 'category', 'subcategory'] as const) {
      if (patch[k] !== undefined) data[k] = patch[k] || null;
    }
    if (data.name === null) delete data.name;
    if (patch.isPublic !== undefined) data.isPublic = !!patch.isPublic;
    if (patch.sortOrder !== undefined) data.sortOrder = Number(patch.sortOrder) || 0;
    if (patch.project !== undefined) data.project = patch.project || null;
    if (patch.category && !VALID_CATEGORIES.has(patch.category)) {
      throw new BadRequestException(`Invalid category`);
    }
    return this.prisma.document.update({ where: { id }, data });
  }

  async deleteDocument(id: string) {
    const doc = await this.prisma.document.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('Document not found');

    // If it's a local file, try to unlink it (best-effort)
    if (doc.fileUrl.startsWith(PUBLIC_PREFIX + '/')) {
      const relPath = doc.fileUrl.slice(PUBLIC_PREFIX.length + 1);
      const fullPath = path.join(UPLOADS_ROOT, relPath);
      // safety check: ensure path is inside UPLOADS_ROOT
      if (path.resolve(fullPath).startsWith(path.resolve(UPLOADS_ROOT))) {
        await fs.unlink(fullPath).catch(() => {});
      }
    }

    await this.prisma.document.delete({ where: { id } });
    return { deleted: true };
  }

  async getDownloadUrl(id: string) {
    const doc = await this.getDocument(id);
    return { url: doc.fileUrl, name: doc.name, type: doc.type };
  }

  /**
   * Legacy compatibility — old broker page scraper.
   */
  async getExternalDocuments() {
    const BROKER_PAGE = process.env.BROKER_DOCS_URL || 'https://old.zorge9.com/broker/index.html';
    try {
      const res = await fetch(BROKER_PAGE);
      if (!res.ok) return { documents: [], source: BROKER_PAGE, fetchedAt: new Date().toISOString() };
      const html = await res.text();

      const docs: { name: string; url: string; type: string }[] = [];
      const linkRegex = /<a[^>]+href=["']([^"']*files\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = linkRegex.exec(html)) !== null) {
        const href = match[1];
        const rawText = match[2].replace(/<[^>]+>/g, '').trim();
        if (!rawText || !href) continue;
        const url = href.startsWith('http') ? href : 'https://old.zorge9.com/' + href.replace(/^\.?\/?/, '');
        const ext = (href.split('.').pop() || '').toLowerCase();
        const type = ext === 'pdf' ? 'PDF' : ext === 'docx' ? 'DOCX' : ext === 'xlsx' ? 'XLSX' : ext.toUpperCase();
        docs.push({ name: rawText, url, type });
      }

      return { documents: docs, source: BROKER_PAGE, fetchedAt: new Date().toISOString() };
    } catch {
      return { documents: [], source: BROKER_PAGE, fetchedAt: new Date().toISOString() };
    }
  }
}
