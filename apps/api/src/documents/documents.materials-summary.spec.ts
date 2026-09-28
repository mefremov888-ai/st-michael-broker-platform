import { DocumentsService } from './documents.service';

// 2026-09-28: счётчики «Материалы» для нового лендинга — проект по полю
// project или по префиксу подпапки, вид по расширению/типу.
describe('DocumentsService.getMaterialsSummary', () => {
  it('раскладывает публичные материалы по проектам и видам файлов', async () => {
    const prisma = {
      document: {
        findMany: jest.fn().mockResolvedValue([
          { subcategory: 'ЗОРГЕ 9/1. Фото/04. Апартаменты', type: 'JPG', fileUrl: '/files/a.jpg', project: null },
          { subcategory: 'ЗОРГЕ 9/2. Видео/reels', type: 'MP4', fileUrl: '/files/b.mp4', project: null },
          { subcategory: 'Зорге9 (фото)', type: '', fileUrl: '/files/c.png?x=1', project: null },
          { subcategory: 'КСБ/3. Reels', type: 'MOV', fileUrl: '/files/d.mov', project: null },
          { subcategory: 'Квартал Серебряный Бор рендеры/Рендеры', type: 'PDF', fileUrl: '/files/e.pdf', project: null },
          { subcategory: 'Прочее', type: 'DOCX', fileUrl: '/files/f.docx', project: 'SILVER_BOR' },
          { subcategory: 'Прочее', type: 'XLSX', fileUrl: '/files/g.xlsx', project: null },
        ]),
      },
    };
    const service = new DocumentsService(prisma as any);
    const { groups } = await service.getMaterialsSummary();
    expect(prisma.document.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { category: 'materials', isPublic: true } }));
    expect(groups.zorge9).toEqual({ photo: 2, video: 1, doc: 0, total: 3 });
    expect(groups['silver-bor']).toEqual({ photo: 0, video: 1, doc: 2, total: 3 });
    expect(groups.other).toEqual({ photo: 0, video: 0, doc: 1, total: 1 });
  });
});
