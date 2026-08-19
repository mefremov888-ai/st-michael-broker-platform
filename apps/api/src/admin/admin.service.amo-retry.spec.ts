import { ConflictException } from '@nestjs/common';
import { AdminService } from './admin.service';

describe('AdminService.retryAmoSync', () => {
  function createService(client: any, updateCount = 1) {
    const prisma = {
      client: {
        findUnique: jest.fn().mockResolvedValue(client),
        updateMany: jest.fn().mockResolvedValue({ count: updateCount }),
      },
    };
    const service = Object.create(AdminService.prototype) as AdminService;
    (service as any).prisma = prisma;
    return { service, prisma };
  }

  it('requeues a dead-letter row instead of duplicating scheduler amo logic', async () => {
    const client = {
      id: 'client-id',
      amoLeadId: null,
      amoSyncStatus: 'FAILED',
      amoSyncError: 'amoCRM 403 /contacts: <html>raw</html>',
    };
    const { service, prisma } = createService(client);

    await expect(service.retryAmoSync(client.id)).resolves.toEqual({
      ok: true,
      queued: true,
      message: 'Заявка возвращена в очередь amoCRM',
    });
    expect(prisma.client.updateMany).toHaveBeenCalledWith({
      where: {
        id: client.id,
        amoLeadId: null,
        amoSyncStatus: 'FAILED',
      },
      data: {
        amoSyncStatus: 'PENDING',
        amoSyncAttempts: 0,
        amoSyncLastAttemptAt: new Date(0),
        amoSyncError: null,
      },
    });
  });

  it('keeps the uniqueness-recheck marker when manually requeued', async () => {
    const marker = 'AMO_UNIQUENESS_RECHECK_REQUIRED:previous-client';
    const client = {
      id: 'client-marker',
      amoLeadId: null,
      amoSyncStatus: 'FAILED',
      amoSyncError: marker,
    };
    const { service, prisma } = createService(client);

    await service.retryAmoSync(client.id);

    expect(prisma.client.updateMany.mock.calls[0][0].data.amoSyncError).toBe(
      marker,
    );
  });

  it('refuses a create retry when an amo lead id is already recorded', async () => {
    const client = {
      id: 'client-with-lead',
      amoLeadId: BigInt(123),
      amoSyncStatus: 'FAILED',
      amoSyncError: 'AMO_SYNC_FAILED',
    };
    const { service, prisma } = createService(client);

    await expect(service.retryAmoSync(client.id)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.client.updateMany).not.toHaveBeenCalled();
  });

  it('does not reset attempts for an application already in the queue', async () => {
    const client = {
      id: 'client-pending',
      amoLeadId: null,
      amoSyncStatus: 'PENDING',
      amoSyncError: null,
    };
    const { service, prisma } = createService(client);

    await expect(service.retryAmoSync(client.id)).resolves.toEqual({
      ok: true,
      queued: false,
      message: 'Заявка уже находится в очереди',
    });
    expect(prisma.client.updateMany).not.toHaveBeenCalled();
  });
});
