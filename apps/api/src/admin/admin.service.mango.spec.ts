import { BadRequestException, ConflictException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import {
  getMangoConfig,
  MangoAdapter,
  normalizeMangoApiUrl,
  normalizeMangoCallbackUrl,
  setMangoConfig,
} from '@st-michael/integrations';
import { AdminService } from './admin.service';

function createHarness(broker: Record<string, unknown>) {
  const prisma: any = {
    broker: {
      findUnique: jest.fn().mockResolvedValue(broker),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({
          id: broker.id,
          fullName: broker.fullName,
          mangoEmployeeNum: data.mangoEmployeeNum,
        }),
      ),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    systemSetting: { upsert: jest.fn().mockResolvedValue({}) },
  };
  prisma.$transaction = jest.fn((callback: any) => callback(prisma));
  const mangoCallSafety = {
    execute: jest.fn((_request: unknown, action: () => Promise<unknown>) => action()),
  };
  const service = new AdminService(
    prisma,
    {} as any,
    {} as any,
    {} as any,
    mangoCallSafety as any,
  );
  return { prisma, service, mangoCallSafety };
}

describe('AdminService Mango EmployeeNUM', () => {
  const originalMangoConfig = getMangoConfig();

  afterEach(() => {
    setMangoConfig(originalMangoConfig);
  });

  it('keeps the Mango safety migration atomic and checks duplicates first', () => {
    const migrationPath = path.resolve(
      __dirname,
      '../../../../packages/database/prisma/migrations/20260818000200_mango_release_safety/migration.sql',
    );
    const sql = fs.readFileSync(migrationPath, 'utf8');
    const begin = sql.indexOf('BEGIN;');
    const preflight = sql.indexOf('IF EXISTS');
    const addSeq = sql.indexOf('ADD COLUMN "mango_event_seq"');
    const uniqueIndex = sql.indexOf('CREATE UNIQUE INDEX "brokers_mango_employee_num_key"');
    const commit = sql.indexOf('COMMIT;');

    expect(begin).toBeGreaterThanOrEqual(0);
    expect(preflight).toBeGreaterThan(begin);
    expect(addSeq).toBeGreaterThan(preflight);
    expect(uniqueIndex).toBeGreaterThan(addSeq);
    expect(commit).toBeGreaterThan(uniqueIndex);
    expect(sql).toMatch(/GROUP BY "mango_employee_num"[\s\S]+HAVING COUNT\(\*\) > 1/);
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).not.toMatch(/\b(?:DELETE|UPDATE)\s+"brokers"/i);
  });

  it('normalizes and stores a unique EmployeeNUM with a value-free audit event', async () => {
    const { prisma, service } = createHarness({
      id: 'manager-1',
      fullName: 'Manager One',
      role: 'MANAGER',
      mangoEmployeeNum: null,
    });

    await expect(
      service.updateBrokerMangoEmployeeNum('manager-1', ' 0017 ', 'admin-1'),
    ).resolves.toEqual({
      id: 'manager-1',
      fullName: 'Manager One',
      mangoEmployeeNum: '0017',
    });

    expect(prisma.broker.findFirst).toHaveBeenCalledWith({
      where: { mangoEmployeeNum: '0017', id: { not: 'manager-1' } },
      select: { id: true, fullName: true },
    });
    expect(prisma.broker.update).toHaveBeenCalledWith({
      where: { id: 'manager-1' },
      data: { mangoEmployeeNum: '0017' },
      select: { id: true, fullName: true, mangoEmployeeNum: true },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'admin-1',
        action: 'BROKER_MANGO_EMPLOYEE_NUM_UPDATED',
        entityId: 'manager-1',
        payload: { cleared: false },
      }),
    });
  });

  it('rejects an EmployeeNUM already assigned to another broker', async () => {
    const { prisma, service } = createHarness({
      id: 'manager-1',
      fullName: 'Manager One',
      role: 'MANAGER',
      mangoEmployeeNum: null,
    });
    prisma.broker.findFirst.mockResolvedValue({ id: 'manager-2', fullName: 'Manager Two' });

    await expect(
      service.updateBrokerMangoEmployeeNum('manager-1', '17', 'admin-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('maps the authoritative database P2002 race to a generic conflict', async () => {
    const { prisma, service } = createHarness({
      id: 'manager-1',
      fullName: 'Manager One',
      role: 'MANAGER',
      mangoEmployeeNum: null,
    });
    const uniqueError: any = new Error('unique constraint');
    uniqueError.code = 'P2002';
    uniqueError.meta = { target: ['mango_employee_num'] };
    prisma.broker.update.mockRejectedValue(uniqueError);

    await expect(
      service.updateBrokerMangoEmployeeNum('manager-1', '17', 'admin-1'),
    ).rejects.toThrow('Внутренний номер Mango уже назначен другому сотруднику');
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('supports clearing the mapping', async () => {
    const { prisma, service } = createHarness({
      id: 'manager-1',
      fullName: 'Manager One',
      role: 'MANAGER',
      mangoEmployeeNum: '17',
    });

    await service.updateBrokerMangoEmployeeNum('manager-1', null, 'admin-1');

    expect(prisma.broker.findFirst).not.toHaveBeenCalled();
    expect(prisma.broker.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { mangoEmployeeNum: null } }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ payload: { cleared: true } }),
    });
  });

  it.each(['17A', '1 7', '123456789012345678901'])(
    'rejects invalid EmployeeNUM %s before querying the database',
    async (value) => {
      const { prisma, service } = createHarness({
        id: 'manager-1',
        fullName: 'Manager One',
        role: 'MANAGER',
        mangoEmployeeNum: null,
      });

      await expect(
        service.updateBrokerMangoEmployeeNum('manager-1', value, 'admin-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.broker.findUnique).not.toHaveBeenCalled();
    },
  );

  it('does not assign an extension to a non-staff broker', async () => {
    const { service } = createHarness({
      id: 'broker-1',
      fullName: 'Broker One',
      role: 'BROKER',
      mangoEmployeeNum: null,
    });

    await expect(
      service.updateBrokerMangoEmployeeNum('broker-1', '17', 'admin-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('uses the env outbound-line fallback immediately after clearing its DB override', async () => {
    const previousEnvValue = process.env.MANGO_OUTBOUND_LINE;
    process.env.MANGO_OUTBOUND_LINE = '+7 (495) 123-45-67';
    setMangoConfig({ outboundLine: '74950000000' });
    const { service } = createHarness({
      id: 'manager-1',
      fullName: 'Manager One',
      role: 'MANAGER',
      mangoEmployeeNum: '17',
    });

    try {
      await service.updateIntegrationSetting(
        'MANGO_OUTBOUND_LINE',
        '',
        'admin-1',
      );
      expect(getMangoConfig().outboundLine).toBe('+7 (495) 123-45-67');
    } finally {
      if (previousEnvValue === undefined) delete process.env.MANGO_OUTBOUND_LINE;
      else process.env.MANGO_OUTBOUND_LINE = previousEnvValue;
    }
  });

  it.each([
    'http://app.mango-office.ru/vpbx',
    'https://127.0.0.1/vpbx',
    'https://app.mango-office.ru/vpbx/commands',
    'https://app.mango-office.ru/vpbx?next=https://127.0.0.1',
    'https://user@app.mango-office.ru/vpbx',
  ])('rejects a non-allowlisted Mango API URL before persistence: %s', async (value) => {
    const { prisma, service } = createHarness({
      id: 'manager-1',
      fullName: 'Manager One',
      role: 'MANAGER',
      mangoEmployeeNum: null,
    });

    await expect(
      service.updateIntegrationSetting('MANGO_API_URL', value, 'admin-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it('allows only the official callback host/path with both query placeholders', async () => {
    const callbackUrl =
      'https://integration-webhook.mango-office.ru/webhookapp/common'
      + '?code=test-code&Source=Other&API_key=test-key&Action=Callback'
      + '&EmployeeNUM={{Ответственный}}&TelNumbr={{Телефон}}';

    expect(normalizeMangoApiUrl('https://app.mango-office.ru/vpbx/')).toBe(
      'https://app.mango-office.ru/vpbx',
    );
    expect(normalizeMangoCallbackUrl(callbackUrl)).toBe(callbackUrl);
    expect(() =>
      normalizeMangoCallbackUrl(
        callbackUrl.replace('integration-webhook.mango-office.ru', '127.0.0.1'),
      ),
    ).toThrow();
    expect(() =>
      normalizeMangoCallbackUrl(callbackUrl.replace('&TelNumbr={{Телефон}}', '')),
    ).toThrow();

    const { prisma, service } = createHarness({
      id: 'manager-1',
      fullName: 'Manager One',
      role: 'MANAGER',
      mangoEmployeeNum: null,
    });
    await expect(
      service.updateIntegrationSetting(
        'MANGO_CALLBACK_URL',
        callbackUrl.replace('integration-webhook.mango-office.ru', 'localhost'),
        'admin-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it('keeps runtime config unchanged after a rejected URL and never follows redirects', async () => {
    const before = getMangoConfig();
    expect(() => setMangoConfig({ apiUrl: 'http://127.0.0.1/vpbx' })).toThrow();
    expect(getMangoConfig()).toEqual(before);

    const fetchBefore = global.fetch;
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as any;
    try {
      setMangoConfig({
        apiKey: 'test-key',
        apiSalt: 'test-salt',
        apiUrl: 'https://app.mango-office.ru/vpbx',
      });
      await new MangoAdapter().initiateCallbackFromExtension({
        extension: '17',
        to: '79990000000',
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://app.mango-office.ru/vpbx/commands/callback',
        expect.objectContaining({ method: 'POST', redirect: 'error' }),
      );
    } finally {
      global.fetch = fetchBefore;
    }
  });
});

describe('AdminService staff role activation boundary', () => {
  it.each(['MANAGER', 'ADMIN'] as const)(
    'rejects promotion to %s before account activation',
    async (role) => {
      const { prisma, service } = createHarness({
        id: 'broker-1',
        status: 'PENDING',
        passwordHash: null,
      });

      await expect(service.changeRole('broker-1', role))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.broker.update).not.toHaveBeenCalled();
    },
  );

  it('allows promotion of an ACTIVE account with a password', async () => {
    const { prisma, service } = createHarness({
      id: 'broker-1',
      status: 'ACTIVE',
      passwordHash: 'hash',
    });

    await service.changeRole('broker-1', 'MANAGER');
    expect(prisma.broker.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'broker-1' },
      data: { role: 'MANAGER' },
    }));
    const select = prisma.broker.update.mock.calls[0][0].select;
    expect(select.passwordHash).toBeUndefined();
    expect(select.passwordResetToken).toBeUndefined();
  });

  it('allows demotion to BROKER for an inactive passwordless record', async () => {
    const { prisma, service } = createHarness({
      id: 'broker-1',
      status: 'PENDING',
      passwordHash: null,
    });

    await service.changeRole('broker-1', 'BROKER');
    expect(prisma.broker.update).toHaveBeenCalled();
  });
});
