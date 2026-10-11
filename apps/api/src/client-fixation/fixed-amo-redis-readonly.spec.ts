import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';

describe('approved case readonly Redis lease evidence', () => {
  const path = resolve(__dirname, '../../../../scripts/inspect-fixed-amo-fixation-case.js');
  const NodeModule = jest.requireActual('module') as any;
  const loaded = new NodeModule(path, module);
  loaded.filename = path; loaded.paths = NodeModule._nodeModulePaths(dirname(path));
  loaded._compile(readFileSync(path, 'utf8'), path);
  const inspector = loaded.exports;
  const key = 'client-fixation:semantic:' + 'a'.repeat(64);
  const row = { id: inspector.CLIENT_ID, brokerId: inspector.EXPECTED_BROKER_ID, responsibleBrokerId: null,
    broker: { id: inspector.EXPECTED_BROKER_ID, phone: '+79990001122', role: 'BROKER', status: 'ACTIVE', mergedIntoId: null, amoContactId: 47267177n, brokerAgencies: [] },
    phone: '+79995556677', fullName: 'private-name', project: 'ZORGE9', fixationAgencyId: null,
    amoSyncAttempts: 10, amoSyncStatus: 'FAILED', uniquenessStatus: 'CONDITIONALLY_UNIQUE', fixationStatus: 'NOT_FIXED', status: 'NEW',
    createdAt: new Date('2026-10-08T14:18:19.203Z'), updatedAt: new Date('2026-10-08T14:18:19.467Z'),
    amoCreatedAt: null, amoUpdatedAt: null, amoSyncLastAttemptAt: null, uniquenessExpiresAt: null, fixationExpiresAt: null, amoLeadId: null };
  const raw = JSON.stringify({ status: 'uncertain', fingerprint: 'b'.repeat(64), owner: 'private-owner', private: '+79995556677' });
  const redis = (value: any = raw, ttl = 7000, exists = 1) => ({ get: jest.fn(async () => value), pttl: jest.fn(async () => ttl), exists: jest.fn(async () => exists) });
  const inspect = (client: any, selected: any = row) => inspector.collectReadOnlyRedisLease(client, selected, () => key, () => 1000);
  it('only reads one exact private key with GET/PTTL/EXISTS and never exposes raw values', async () => {
    const client = redis();
    const result = await inspect(client);
    expect(result).toEqual({ performed: true, lockPresent: true, ttlMs: 7000, uncertainPresent: true, uncertainTtlMs: 7000,
      bounded: true, identitySafe: true, stableReadback: true, mutationAttempted: false });
    for (const method of [client.get, client.pttl, client.exists]) { expect(method).toHaveBeenCalledTimes(2); expect(method).toHaveBeenCalledWith(key); }
    expect(JSON.stringify(result)).not.toMatch(/private|79995556677|aaaaaa|bbbbbb/);
    expect(client).not.toHaveProperty('set'); expect(client).not.toHaveProperty('eval');
  });
  it('observes no lock, processing and persistent uncertain states without inferring ownership', async () => {
    expect(await inspect(redis(null, -2, 0))).toMatchObject({ lockPresent: false, ttlMs: -2, uncertainPresent: false, stableReadback: true });
    expect(await inspect(redis(JSON.stringify({ status: 'processing' }), 7000))).toMatchObject({ uncertainPresent: false, uncertainTtlMs: null });
    expect(await inspect(redis(raw, -1))).toMatchObject({ uncertainPresent: true, uncertainTtlMs: -1 });
  });
  it.each([[raw, -3, 1], [raw, 86400001, 1], [raw, 7000.5, 1], [raw, 7000, 2], ['malformed', 7000, 1], ['x'.repeat(4097), 7000, 1], [JSON.stringify({ status: 'secret-status' }), 7000, 1]])('refuses malformed, oversized, TTL or existence evidence %#', async (value, ttl, exists) => {
    await expect(inspect(redis(value, ttl as number, exists as number))).rejects.toHaveProperty('safeCode', 'REDIS_LEASE_OBSERVATION_INVALID');
  });
  it('marks expiration or replacement across paired samples unstable and never claims lock ownership', async () => {
    const client = redis(); client.get.mockResolvedValueOnce(raw).mockResolvedValueOnce(null);
    client.pttl.mockResolvedValueOnce(1).mockResolvedValueOnce(-2); client.exists.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    expect(await inspect(client)).toMatchObject({ stableReadback: false, lockPresent: false });
    const changed = redis(); changed.get.mockResolvedValueOnce(raw).mockResolvedValueOnce(JSON.stringify({ status: 'uncertain', owner: 'new-private-owner' }));
    expect(await inspect(changed)).toMatchObject({ stableReadback: false });
  });
  it('rejects foreign case, malformed key, provider failure and invalid Redis identity before reading/writing', async () => {
    const client = redis(); await expect(inspect(client, { ...row, id: 'other' })).rejects.toThrow();
    expect(client.get).not.toHaveBeenCalled();
    await expect(inspector.collectReadOnlyRedisLease(client, row, () => 'other-key')).rejects.toThrow();
    client.get.mockRejectedValueOnce(new Error('private provider value'));
    await expect(inspect(client)).rejects.toThrow();
    const Constructor = jest.fn();
    expect(() => inspector.createReadOnlyRedis(Constructor, { REDIS_HOST: 'other', REDIS_PORT: '6379' })).toThrow();
    expect(Constructor).not.toHaveBeenCalled();
    inspector.createReadOnlyRedis(Constructor, { REDIS_HOST: 'redis', REDIS_PORT: '6379' });
    expect(Constructor).toHaveBeenCalledWith(expect.objectContaining({ db: 0, lazyConnect: true, enableReadyCheck: false, maxRetriesPerRequest: 0, commandTimeout: 3000 }));
  });
  it('refuses unattested runtime helper without loading its exports', () => {
    const originalRequire = loaded.require;
    try {
      loaded.require = (name: string) => name === 'node:fs' ? {
        lstatSync: (p: string) => ({ isSymbolicLink: () => false, isFile: () => p.endsWith('.js'), isDirectory: () => !p.endsWith('.js'), size: 100 }),
        realpathSync: (p: string) => p, readFileSync: () => Buffer.from('module.exports={secret:"private"}'),
      } : originalRequire.call(loaded, name);
      expect(() => inspector.attestedRuntimePhoneLock()).toThrow();
    } finally { loaded.require = originalRequire; }
  });
  it('loads only the exact reviewed compiled helper bytes in an I/O-free VM', () => {
    const bytes = readFileSync(resolve(__dirname, '../../../../packages/integrations/dist/amo-fixation-phone-lock.js'));
    const originalRequire = loaded.require;
    try {
      loaded.require = (name: string) => name === 'node:fs' ? {
        lstatSync: (p: string) => ({ isSymbolicLink: () => false, isFile: () => p.endsWith('.js'), isDirectory: () => !p.endsWith('.js'), size: bytes.length }),
        realpathSync: (p: string) => p, readFileSync: () => bytes,
      } : originalRequire.call(loaded, name);
      const helper = inspector.attestedRuntimePhoneLock();
      expect(helper('+79995556677')).toMatch(/^client-fixation:semantic:[0-9a-f]{64}$/);
      expect(helper('89995556677')).toBe(helper('+79995556677'));
    } finally { loaded.require = originalRequire; }
  });
});
