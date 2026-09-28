// 2026-09-28: unit-тесты ночного синка касаний amo → BrokerAmoContactSync.
// Адаптер и prisma — моки; сети нет.
import {
  AmoTouchSyncService,
  brokerPhoneKeys,
  buildContactTouchSnapshot,
  classifyAmoError,
  leadHasContact,
  leadIsAboutContact,
  maskPhone,
} from './amo-touch-sync.service';
import { AMO_PIPELINES } from '../../../../packages/integrations/src/amo-crm.fields';

const SYSTEM_BOT = 6089620;
const HUMAN_A = 10771754;
const HUMAN_B = 10771800;
const BROKER_PHONE = '+79254259619';
const CLIENT_PHONE = '+79160000001';
const BROKER_KEYS = new Set(['9254259619']);

const callNote = (
  id: number,
  entityId: number,
  createdAt: number,
  createdBy: number,
  type: 'call_in' | 'call_out' = 'call_in',
  params: Record<string, unknown> = {},
) => ({
  id,
  entity_id: entityId,
  note_type: type,
  created_at: createdAt,
  updated_at: createdAt,
  created_by: createdBy,
  responsible_user_id: createdBy,
  params: { duration: 30, call_status: 4, ...params },
});

const task = (
  id: number,
  entityId: number,
  updatedAt: number,
  responsible: number,
  completed = true,
) => ({
  id,
  entity_id: entityId,
  entity_type: 'leads',
  task_type_id: 1908409,
  is_completed: completed,
  complete_till: updatedAt - 100,
  responsible_user_id: responsible,
  result: { text: 'уник, запись на 13.00' },
  updated_at: updatedAt,
  created_at: updatedAt - 1000,
});

const contact = (id: number, updatedAt: number, leadIds: number[] = [], extra: any = {}) => ({
  id,
  name: `Contact ${id}`,
  updated_at: updatedAt,
  responsible_user_id: HUMAN_B,
  _embedded: { leads: leadIds.map((lid) => ({ id: lid })) },
  ...extra,
});

const brokerContact = (id: number, phone: string, isBroker: boolean, updatedAt = 1_700_000_000) => ({
  id,
  name: `Broker ${id}`,
  updated_at: updatedAt,
  responsible_user_id: HUMAN_B,
  custom_fields_values: [
    { field_id: 557903, values: [{ value: phone }] },
    ...(isBroker ? [{ field_id: 835415, values: [{ value: true }] }] : []),
  ],
});

interface PrismaFixture {
  linked?: Array<{ id: string; amoContactId: bigint; phone?: string; phones?: Array<{ phone: string }> }>;
  syncRows?: Array<{ brokerId: string; amoUpdatedAt: Date | null; sourceHash: string | null; syncError?: string | null }>;
  unlinked?: Array<{ id: string; phone: string }>;
  takenIds?: bigint[];
  staff?: Array<{ id: string; email: string }>;
  amoUsers?: Array<{ id: bigint; brokerId: string | null; matchedBy: string | null }>;
  runningRun?: { id: string; startedAt: Date; ruleVersion: string } | null;
}

function makePrisma(fx: PrismaFixture = {}) {
  const state = { inTx: false };
  const prisma: any = {
    __state: state,
    loyaltySyncRun: {
      findFirst: jest.fn().mockResolvedValue(fx.runningRun ?? null),
      create: jest.fn().mockResolvedValue({ id: 'run-1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    broker: {
      findFirst: jest.fn().mockResolvedValue({ id: 'admin-1' }),
      findMany: jest.fn().mockImplementation(async (args: any) => {
        const where = args?.where || {};
        if (where.role && typeof where.role === 'object' && where.role.in) return fx.staff ?? [];
        if (where.amoContactId === null) {
          const rows = fx.unlinked ?? [];
          return typeof args.take === 'number' ? rows.slice(0, args.take) : rows;
        }
        if (args?.select?.id) return fx.linked ?? [];
        return (fx.takenIds ?? []).map((amoContactId) => ({ amoContactId }));
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    brokerAmoContactSync: {
      findMany: jest.fn().mockResolvedValue(fx.syncRows ?? []),
      upsert: jest.fn().mockResolvedValue({}),
    },
    amoUser: {
      findMany: jest.fn().mockResolvedValue(fx.amoUsers ?? []),
      upsert: jest.fn().mockResolvedValue({}),
    },
    systemSetting: {
      upsert: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn().mockImplementation(async (fn: any) => {
      state.inTx = true;
      try {
        return await fn(prisma);
      } finally {
        state.inTx = false;
      }
    }),
  };
  return prisma;
}

function makeAmo(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    getUsers: jest.fn().mockResolvedValue([]),
    getContactsByIds: jest.fn().mockResolvedValue(new Map()),
    getLeadsByIds: jest.fn().mockResolvedValue(new Map()),
    getNotesForContacts: jest.fn().mockResolvedValue(new Map()),
    getNotesForLeads: jest.fn().mockResolvedValue(new Map()),
    getTasksForEntities: jest.fn().mockResolvedValue(new Map()),
    findContactsByPhoneExact: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeService(prisma: any, amo: any, opsAlerts?: any) {
  const service = new AmoTouchSyncService(prisma, opsAlerts);
  service.setAdapter(amo);
  jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
  jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
  return service;
}

const upsertDataFor = (prisma: any, brokerId: string) =>
  prisma.brokerAmoContactSync.upsert.mock.calls
    .map((c: any[]) => c[0])
    .filter((a: any) => a.where.brokerId === brokerId)
    .map((a: any) => a.update);

describe('buildContactTouchSnapshot (чистая логика)', () => {
  const systemUserIds = new Set([SYSTEM_BOT]);

  it('последний звонок — с учётом системных авторов и звонков на лидах брокера', () => {
    const c = contact(47242693, 1_700_000_500, [32323569, 32323585]);
    const kcLeadOld = { id: 32323569, pipeline_id: AMO_PIPELINES.KC, updated_at: 1_700_000_100, responsible_user_id: HUMAN_B, _embedded: { contacts: [{ id: 47242693, is_main: true }] } };
    const kcLeadNew = { id: 32323585, pipeline_id: AMO_PIPELINES.KC, updated_at: 1_700_000_400, responsible_user_id: HUMAN_A, _embedded: { contacts: [{ id: 47242693, is_main: true }] } };
    const snapshot = buildContactTouchSnapshot({
      contact: c as any,
      leads: [kcLeadOld, kcLeadNew] as any,
      contactNotes: [
        callNote(1, 47242693, 1_700_000_900, SYSTEM_BOT), // системный, новее — не считать
        callNote(2, 47242693, 1_700_000_200, HUMAN_B, 'call_out'),
      ] as any,
      leadNotes: new Map([[32323569, [callNote(3, 32323569, 1_700_000_300, HUMAN_A)]]]) as any,
      contactTasks: [],
      leadTasks: new Map(),
      systemUserIds,
      brokerPhoneKeys: BROKER_KEYS,
    });
    expect(snapshot.lastCallAt?.getTime()).toBe(1_700_000_300 * 1000);
    expect(snapshot.lastCallDirection).toBe('IN');
    expect(snapshot.lastCallUserId).toBe(BigInt(HUMAN_A));
    expect(snapshot.lastTouchKind).toBe('CALL_IN');
    expect(snapshot.lastTouchRef).toBe('note:3');
    // лид КЦ — последний по updated_at среди воронки КЦ
    expect(snapshot.kcLeadId).toBe(BigInt(32323585));
    expect(snapshot.kcResponsibleUserId).toBe(BigInt(HUMAN_A));
    expect(snapshot.amoResponsibleUserId).toBe(BigInt(HUMAN_B));
  });

  it('выполненная задача новее звонка → lastTouch = TASK_COMPLETED; системный исполнитель не считается', () => {
    const c = contact(1, 1_700_000_000, [10]);
    const lead = { id: 10, pipeline_id: AMO_PIPELINES.BROKERS, updated_at: 1_700_000_000, _embedded: { contacts: [{ id: 1, is_main: true }] } };
    const snapshot = buildContactTouchSnapshot({
      contact: c as any,
      leads: [lead] as any,
      contactNotes: [callNote(1, 1, 1_700_000_100, HUMAN_A)] as any,
      leadNotes: new Map(),
      contactTasks: [],
      leadTasks: new Map([[10, [
        task(100, 10, 1_700_000_900, SYSTEM_BOT), // системный исполнитель
        task(101, 10, 1_700_000_500, HUMAN_B),
        task(102, 10, 1_700_000_800, HUMAN_B, false), // не выполнена
      ]]]) as any,
      systemUserIds,
      brokerPhoneKeys: BROKER_KEYS,
    });
    expect(snapshot.lastTouchKind).toBe('TASK_COMPLETED');
    expect(snapshot.lastTouchRef).toBe('task:101');
    expect(snapshot.lastTouchAt?.getTime()).toBe(1_700_000_500 * 1000);
    expect(snapshot.lastTouchUserId).toBe(BigInt(HUMAN_B));
    expect(snapshot.lastCallAt?.getTime()).toBe(1_700_000_100 * 1000);
    expect(snapshot.kcLeadId).toBeNull();
  });

  it('лид КЦ выбирается среди ВСЕХ лидов КЦ с брокером — даже когда брокер не main (заявка клиента, ответственный от Морикита)', () => {
    // Факт с живого аккаунта: контакт 47242693, лид 32323585 — заявка на уникальность
    // клиента (contacts = [47242703 клиент main, 47242693 брокер]), отв. Корнева (КЦ).
    const c = contact(47242693, 1_700_000_500, [32323569, 32323585]);
    const oldOwnLead = { id: 32323569, pipeline_id: AMO_PIPELINES.KC, updated_at: 1_700_000_100, responsible_user_id: HUMAN_B, _embedded: { contacts: [{ id: 47242693, is_main: true }] } };
    const clientLead = { id: 32323585, pipeline_id: AMO_PIPELINES.KC, updated_at: 1_700_000_400, responsible_user_id: HUMAN_A, _embedded: { contacts: [{ id: 47242703, is_main: true }, { id: 47242693, is_main: false }] } };
    const foreignLead = { id: 32323599, pipeline_id: AMO_PIPELINES.KC, updated_at: 1_700_000_900, responsible_user_id: SYSTEM_BOT, _embedded: { contacts: [{ id: 47242703, is_main: true }] } };
    expect(leadHasContact(clientLead as any, 47242693)).toBe(true);
    expect(leadIsAboutContact(clientLead as any, 47242693)).toBe(false);
    expect(leadHasContact(foreignLead as any, 47242693)).toBe(false);
    const snapshot = buildContactTouchSnapshot({
      contact: c as any,
      leads: [oldOwnLead, clientLead, foreignLead] as any,
      contactNotes: [],
      leadNotes: new Map(),
      contactTasks: [],
      leadTasks: new Map(),
      systemUserIds,
      brokerPhoneKeys: BROKER_KEYS,
    });
    expect(snapshot.kcLeadId).toBe(BigInt(32323585));
    expect(snapshot.kcResponsibleUserId).toBe(BigInt(HUMAN_A));
    expect(snapshot.linkedLeadIds).toEqual([32323569, 32323585]);
    expect(snapshot.ownLeadIds).toEqual([32323569]);
  });

  it('звонок на клиентском лиде: с чужим номером не считается, с номером брокера — считается; без номера — только на своих сущностях', () => {
    const c = contact(1, 1_700_000_000, [10, 11]);
    const clientLead = { id: 10, pipeline_id: AMO_PIPELINES.KC, updated_at: 1_700_000_900, responsible_user_id: HUMAN_B, _embedded: { contacts: [{ id: 2, is_main: true }, { id: 1, is_main: false }] } };
    const ownLead = { id: 11, pipeline_id: AMO_PIPELINES.BROKERS, updated_at: 1_700_000_100, responsible_user_id: HUMAN_A, _embedded: { contacts: [{ id: 1, is_main: true }] } };
    const base = {
      contact: c as any,
      leads: [clientLead, ownLead] as any,
      contactNotes: [],
      contactTasks: [],
      leadTasks: new Map(),
      systemUserIds,
      brokerPhoneKeys: BROKER_KEYS,
    };
    // (а) звонок клиенту по фиксации — чужой номер → не касание брокера
    const foreign = buildContactTouchSnapshot({
      ...base,
      leadNotes: new Map([[10, [callNote(1, 10, 1_700_000_950, HUMAN_B, 'call_out', { phone: CLIENT_PHONE })]]]) as any,
    });
    expect(foreign.lastCallAt).toBeNull();
    expect(foreign.lastTouchAt).toBeNull();
    // (б) на том же клиентском лиде звонок на номер брокера (в другом формате) → считается
    const mine = buildContactTouchSnapshot({
      ...base,
      leadNotes: new Map([[10, [
        callNote(1, 10, 1_700_000_950, HUMAN_B, 'call_out', { phone: CLIENT_PHONE }),
        callNote(2, 10, 1_700_000_940, HUMAN_A, 'call_in', { phone: '8 (925) 425-96-19' }),
      ]]]) as any,
    });
    expect(mine.lastCallAt?.getTime()).toBe(1_700_000_940 * 1000);
    expect(mine.lastTouchRef).toBe('note:2');
    expect(mine.lastTouchKind).toBe('CALL_IN');
    // (в) без phone: на клиентском лиде — мимо, на своём лиде и на контакте — считается
    const noPhone = buildContactTouchSnapshot({
      ...base,
      contactNotes: [callNote(5, 1, 1_700_000_300, HUMAN_A, 'call_out', { phone: '' })] as any,
      leadNotes: new Map([
        [10, [callNote(3, 10, 1_700_000_960, HUMAN_B, 'call_out', { phone: undefined })]],
        [11, [callNote(4, 11, 1_700_000_500, HUMAN_A, 'call_in', { phone: '' })]],
      ]) as any,
    });
    expect(noPhone.lastCallAt?.getTime()).toBe(1_700_000_500 * 1000);
    expect(noPhone.lastTouchRef).toBe('note:4');
    // (г) звонок на самом контакте с чужим номером — тоже мимо
    const contactForeign = buildContactTouchSnapshot({
      ...base,
      leadNotes: new Map(),
      contactNotes: [callNote(6, 1, 1_700_000_300, HUMAN_A, 'call_out', { phone: CLIENT_PHONE })] as any,
    });
    expect(contactForeign.lastCallAt).toBeNull();
  });

  it('выполненная задача на клиентском лиде (брокер не main) не считается, на своём лиде — считается', () => {
    const c = contact(1, 1_700_000_000, [10, 11]);
    const clientLead = { id: 10, pipeline_id: AMO_PIPELINES.KC, updated_at: 1_700_000_900, responsible_user_id: HUMAN_B, _embedded: { contacts: [{ id: 2, is_main: true }, { id: 1, is_main: false }] } };
    const ownLead = { id: 11, pipeline_id: AMO_PIPELINES.BROKERS, updated_at: 1_700_000_100, _embedded: { contacts: [{ id: 1 }] } };
    const snapshot = buildContactTouchSnapshot({
      contact: c as any,
      leads: [clientLead, ownLead] as any,
      contactNotes: [],
      leadNotes: new Map(),
      contactTasks: [],
      leadTasks: new Map([
        [10, [task(100, 10, 1_700_000_950, HUMAN_B)]], // клиентская фиксация — про клиента
        [11, [task(101, 11, 1_700_000_400, HUMAN_A)]],
      ]) as any,
      systemUserIds,
      brokerPhoneKeys: BROKER_KEYS,
    });
    expect(snapshot.lastTouchKind).toBe('TASK_COMPLETED');
    expect(snapshot.lastTouchRef).toBe('task:101');
    expect(snapshot.lastTouchAt?.getTime()).toBe(1_700_000_400 * 1000);
    expect(snapshot.kcLeadId).toBe(BigInt(10)); // лид КЦ при этом — клиентский, где брокер есть
  });

  it('brokerPhoneKeys: Broker.phone + BrokerPhone, нормализация до 10 цифр', () => {
    expect([...brokerPhoneKeys({ id: 'b', amoContactId: null, phone: '+7 (925) 425-96-19', phones: [{ phone: '89160000001' }, { phone: 'tg:123' }, { phone: null }] })]).toEqual(['9254259619', '9160000001']);
    expect(brokerPhoneKeys({ id: 'b', amoContactId: null }).size).toBe(0);
  });

  it('хэш стабилен и меняется при новом касании', () => {
    const c = contact(1, 1_700_000_000, []);
    const base = { contact: c as any, leads: [], leadNotes: new Map(), contactTasks: [], leadTasks: new Map(), systemUserIds, brokerPhoneKeys: BROKER_KEYS };
    const a = buildContactTouchSnapshot({ ...base, contactNotes: [callNote(1, 1, 1_700_000_100, HUMAN_A)] as any });
    const b = buildContactTouchSnapshot({ ...base, contactNotes: [callNote(1, 1, 1_700_000_100, HUMAN_A)] as any });
    const d = buildContactTouchSnapshot({ ...base, contactNotes: [callNote(2, 1, 1_700_000_200, HUMAN_A)] as any });
    expect(a.sourceHash).toBe(b.sourceHash);
    expect(a.sourceHash).not.toBe(d.sourceHash);
  });

  it('classifyAmoError / maskPhone', () => {
    expect(classifyAmoError(new Error('amoCRM 403 /contacts?…'))).toBe('AUTH');
    expect(classifyAmoError(new Error('amoCRM 401 /users'))).toBe('AUTH');
    expect(classifyAmoError(new Error('AMO_ACCESS_TOKEN not configured'))).toBe('AUTH');
    expect(classifyAmoError(new Error('amoCRM 429 /leads?…'))).toBe('RATE_LIMIT');
    expect(classifyAmoError(new Error('amoCRM 500 /leads?…'))).toBe('OTHER');
    expect(maskPhone('+79254259619')).toBe('+7 92x ***-**-19');
    expect(maskPhone('123')).toBe('***');
  });
});

describe('AmoTouchSyncService.run', () => {
  it('инкрементальный пропуск: updated_at совпал и sourceHash есть → контакт не читается в фазе 2', async () => {
    const same = 1_700_000_000;
    const prisma = makePrisma({
      linked: [
        { id: 'b-same', amoContactId: BigInt(101), phone: BROKER_PHONE, phones: [] },
        { id: 'b-changed', amoContactId: BigInt(102), phone: BROKER_PHONE, phones: [] },
        { id: 'b-new', amoContactId: BigInt(103), phone: BROKER_PHONE, phones: [] },
      ],
      syncRows: [
        { brokerId: 'b-same', amoUpdatedAt: new Date(same * 1000), sourceHash: 'h1' },
        { brokerId: 'b-changed', amoUpdatedAt: new Date((same - 10) * 1000), sourceHash: 'h2' },
      ],
    });
    const amo = makeAmo({
      getContactsByIds: jest.fn().mockResolvedValue(new Map([
        [101, contact(101, same)],
        [102, contact(102, same)],
        [103, contact(103, same)],
      ])),
      getNotesForContacts: jest.fn().mockResolvedValue(new Map([
        [102, [callNote(1, 102, same - 5, HUMAN_A, 'call_in', { phone: BROKER_PHONE })]],
        [103, [callNote(2, 103, same - 5, HUMAN_A, 'call_out', { phone: '8-925-425-96-19' })]],
      ])),
    });
    const service = makeService(prisma, amo);
    const r = await service.run({ mode: 'apply', phases: [1, 2] });

    expect(r.status).toBe('SUCCEEDED');
    expect(amo.getContactsByIds).toHaveBeenCalledWith([103, 101, 102], { propagateErrors: true });
    expect(r.stats.contactsTotal).toBe(3);
    expect(r.stats.contactsSkipped).toBe(1);
    expect(r.stats.contactsChanged).toBe(2);
    expect(amo.getNotesForContacts.mock.calls[0][0]).toEqual([103, 102]);
    expect(prisma.broker.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: { id: true, amoContactId: true, phone: true, phones: { select: { phone: true } } },
    }));
    expect(upsertDataFor(prisma, 'b-same')).toHaveLength(0);
    const changed = upsertDataFor(prisma, 'b-changed')[0];
    expect(changed.lastTouchKind).toBe('CALL_IN');
    expect(changed.amoUpdatedAt).toEqual(new Date(same * 1000));
    expect(changed.amoLookupStatus).toBe('LINKED');
    expect(changed.syncError).toBeNull();
    expect(upsertDataFor(prisma, 'b-new')[0].lastTouchKind).toBe('CALL_OUT');
    expect(prisma.loyaltySyncRun.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'SUCCEEDED',
          // check-констрейнт loyalty_sync_runs_state_check: у SUCCEEDED
          // content_hash обязателен (упало на проде 28.09)
          contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          completedAt: expect.any(Date),
        }),
      }),
    );
    expect(prisma.systemSetting.upsert).toHaveBeenCalled();
  });

  it('одинаковый sourceHash → запись не трогаем; maxContacts ограничивает и откладывает остаток', async () => {
    const t = 1_700_000_000;
    const prisma = makePrisma({
      linked: [
        { id: 'b-1', amoContactId: BigInt(1) },
        { id: 'b-2', amoContactId: BigInt(2) },
        { id: 'b-3', amoContactId: BigInt(3) },
      ],
      syncRows: [],
    });
    const amo = makeAmo({
      getContactsByIds: jest.fn().mockResolvedValue(new Map([[1, contact(1, t)], [2, contact(2, t)]])),
    });
    const service = makeService(prisma, amo);
    const r = await service.run({ mode: 'apply', phases: [1, 2], maxContacts: 2 });
    expect(amo.getContactsByIds).toHaveBeenCalledWith([1, 2], { propagateErrors: true });
    expect(r.stats.contactsChanged).toBe(2);
    expect(r.backfillDone).toBe(false);
    expect(prisma.brokerAmoContactSync.upsert).toHaveBeenCalledTimes(2);

    // Второй прогон: те же хэши → 0 записей
    const hash = upsertDataFor(prisma, 'b-1')[0].sourceHash;
    const prisma2 = makePrisma({
      linked: [{ id: 'b-1', amoContactId: BigInt(1) }],
      syncRows: [{ brokerId: 'b-1', amoUpdatedAt: new Date((t - 1) * 1000), sourceHash: hash }],
    });
    const service2 = makeService(prisma2, amo);
    const r2 = await service2.run({ mode: 'apply', phases: [1, 2] });
    expect(r2.stats.unchangedHash).toBe(1);
    expect(prisma2.brokerAmoContactSync.upsert).not.toHaveBeenCalled();
  });

  it('фаза 2: примечания читаются со всех лидов с брокером, задачи — только с лидов, где брокер main', async () => {
    const t = 1_700_000_000;
    const prisma = makePrisma({
      linked: [{ id: 'b-1', amoContactId: BigInt(1), phone: BROKER_PHONE, phones: [] }],
    });
    const clientLead = { id: 10, pipeline_id: AMO_PIPELINES.KC, updated_at: t, responsible_user_id: HUMAN_A, _embedded: { contacts: [{ id: 2, is_main: true }, { id: 1, is_main: false }] } };
    const ownLead = { id: 11, pipeline_id: AMO_PIPELINES.BROKERS, updated_at: t, _embedded: { contacts: [{ id: 1, is_main: true }] } };
    const foreignLead = { id: 12, pipeline_id: AMO_PIPELINES.KC, updated_at: t + 5, _embedded: { contacts: [{ id: 3, is_main: true }] } };
    const amo = makeAmo({
      getContactsByIds: jest.fn().mockResolvedValue(new Map([[1, contact(1, t, [10, 11, 12])]])),
      getLeadsByIds: jest.fn().mockResolvedValue(new Map<number, any>([[10, clientLead], [11, ownLead], [12, foreignLead]])),
      getNotesForLeads: jest.fn().mockResolvedValue(new Map([[10, [callNote(7, 10, t - 1, HUMAN_A, 'call_out', { phone: CLIENT_PHONE })]]])),
    });
    const service = makeService(prisma, amo);
    const r = await service.run({ mode: 'apply', phases: [1, 2] });
    expect(r.status).toBe('SUCCEEDED');
    expect(amo.getLeadsByIds).toHaveBeenCalledWith([10, 11, 12]);
    expect(amo.getNotesForLeads.mock.calls[0][0]).toEqual([10, 11]);
    const taskCalls = amo.getTasksForEntities.mock.calls.filter((c: any[]) => c[0] === 'leads');
    expect(taskCalls[0][1]).toEqual([11]);
    const data = upsertDataFor(prisma, 'b-1')[0];
    expect(data.kcLeadId).toBe(BigInt(10));
    expect(data.kcResponsibleUserId).toBe(BigInt(HUMAN_A));
    expect(data.lastCallAt).toBeNull(); // звонок клиенту по фиксации — не касание брокера
  });

  it('фаза 3: квота и правила LINKED / AMBIGUOUS / NOT_FOUND / NOT_BROKER / занятый id', async () => {
    const prisma = makePrisma({
      unlinked: [
        { id: 'u-linked', phone: '+79250000001' },
        { id: 'u-ambig', phone: '+79250000002' },
        { id: 'u-none', phone: '+79250000003' },
        { id: 'u-notbroker', phone: '+79250000004' },
        { id: 'u-taken', phone: '+79250000005' },
        { id: 'u-over-quota', phone: '+79250000006' },
      ],
      takenIds: [BigInt(555)],
    });
    const byPhone: Record<string, any[]> = {
      '+79250000001': [brokerContact(11, '+7 925 000-00-01', true)],
      '+79250000002': [brokerContact(21, '+79250000002', true), brokerContact(22, '89250000002', true)],
      '+79250000003': [],
      '+79250000004': [brokerContact(41, '+79250000004', false)],
      '+79250000005': [brokerContact(555, '+79250000005', true)],
    };
    const amo = makeAmo({
      findContactsByPhoneExact: jest.fn().mockImplementation(async (phone: string) => byPhone[phone] ?? []),
    });
    const service = makeService(prisma, amo);
    const r = await service.run({ mode: 'apply', phases: [3], lookupQuota: 5 });

    expect(r.status).toBe('SUCCEEDED');
    expect(prisma.broker.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 5 }));
    expect(amo.findContactsByPhoneExact).toHaveBeenCalledTimes(5);
    expect(r.stats).toEqual(expect.objectContaining({ lookups: 5, linked: 1, ambiguous: 2, notFound: 1, notBroker: 1 }));

    expect(prisma.broker.update).toHaveBeenCalledTimes(1);
    expect(prisma.broker.update).toHaveBeenCalledWith({ where: { id: 'u-linked' }, data: { amoContactId: BigInt(11) } });
    expect(upsertDataFor(prisma, 'u-linked')[0]).toEqual(expect.objectContaining({ amoLookupStatus: 'LINKED', amoContactId: BigInt(11) }));

    const ambig = upsertDataFor(prisma, 'u-ambig')[0];
    expect(ambig.amoLookupStatus).toBe('AMBIGUOUS');
    expect(ambig.amoLookupCandidates).toHaveLength(2);
    expect(ambig.amoLookupCandidates[0]).toEqual(expect.objectContaining({ id: 21, phoneMasked: '+7 92x ***-**-02', isBroker: true }));
    expect(JSON.stringify(ambig.amoLookupCandidates)).not.toContain('9250000002');

    expect(upsertDataFor(prisma, 'u-none')[0].amoLookupStatus).toBe('NOT_FOUND');
    const nb = upsertDataFor(prisma, 'u-notbroker')[0];
    expect(nb.amoLookupStatus).toBe('NOT_BROKER');
    expect(nb.amoLookupCandidates[0].isBroker).toBe(false);
    const taken = upsertDataFor(prisma, 'u-taken')[0];
    expect(taken.amoLookupStatus).toBe('AMBIGUOUS');
    expect(taken.syncError).toBe('AMO_CONTACT_ID_TAKEN');
    expect(upsertDataFor(prisma, 'u-over-quota')).toHaveLength(0);
    for (const call of prisma.brokerAmoContactSync.upsert.mock.calls) {
      expect(call[0].update.amoLookupAt).toBeInstanceOf(Date);
    }
  });

  it('фаза 3: один и тот же контакт не привязывается двум брокерам в одном прогоне', async () => {
    const prisma = makePrisma({
      unlinked: [
        { id: 'u-a', phone: '+79250000009' },
        { id: 'u-b', phone: '+79250000009' },
      ],
    });
    const amo = makeAmo({
      findContactsByPhoneExact: jest.fn().mockResolvedValue([brokerContact(99, '+79250000009', true)]),
    });
    const service = makeService(prisma, amo);
    const r = await service.run({ mode: 'apply', phases: [3] });
    expect(r.stats.linked).toBe(1);
    expect(r.stats.ambiguous).toBe(1);
    expect(prisma.broker.update).toHaveBeenCalledTimes(1);
  });

  it('dry-run: чтения из amo выполняются, записи идут в $transaction и откатываются', async () => {
    const t = 1_700_000_000;
    const prisma = makePrisma({
      linked: [{ id: 'b-1', amoContactId: BigInt(1) }],
      unlinked: [{ id: 'u-1', phone: '+79250000001' }],
      staff: [{ id: 'mgr-1', email: 'Manager@Example.com' }],
    });
    const amo = makeAmo({
      getUsers: jest.fn().mockResolvedValue([{ id: 10771754, name: 'Корнева', email: 'manager@example.com', is_active: true }]),
      getContactsByIds: jest.fn().mockResolvedValue(new Map([[1, contact(1, t)]])),
      findContactsByPhoneExact: jest.fn().mockResolvedValue([brokerContact(11, '+79250000001', true)]),
    });
    const writesInTx: boolean[] = [];
    prisma.brokerAmoContactSync.upsert.mockImplementation(async () => { writesInTx.push(prisma.__state.inTx); return {}; });
    prisma.broker.update.mockImplementation(async () => { writesInTx.push(prisma.__state.inTx); return {}; });
    prisma.amoUser.upsert.mockImplementation(async () => { writesInTx.push(prisma.__state.inTx); return {}; });

    const service = makeService(prisma, amo);
    const r = await service.run({ mode: 'dry-run' });

    expect(r.status).toBe('SUCCEEDED');
    expect(r.mode).toBe('dry-run');
    expect(amo.getUsers).toHaveBeenCalled();
    expect(amo.getContactsByIds).toHaveBeenCalled();
    expect(amo.findContactsByPhoneExact).toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(writesInTx.length).toBe(4); // amoUser + sync.touch + broker.link + lookup.LINKED
    expect(writesInTx.every(Boolean)).toBe(true);
    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
    expect(prisma.amoUser.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ brokerId: 'mgr-1', matchedBy: 'email' }),
    }));
    expect(r.samples.length).toBeGreaterThan(0);
    expect(r.samples.join('\n')).not.toContain('9250000001');
    // Аудит прогона всё равно записан
    expect(prisma.loyaltySyncRun.create).toHaveBeenCalled();
    expect(prisma.loyaltySyncRun.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SUCCEEDED', counts: expect.objectContaining({ mode: 'dry-run' }) }) }),
    );
  });

  it('dry-run: ошибка записи внутри транзакции → FAILED (сухой прогон доходит до записи)', async () => {
    const prisma = makePrisma({
      linked: [{ id: 'b-1', amoContactId: BigInt(1) }],
    });
    prisma.brokerAmoContactSync.upsert.mockRejectedValue(new Error('column does not exist'));
    const amo = makeAmo({
      getContactsByIds: jest.fn().mockResolvedValue(new Map([[1, contact(1, 1_700_000_000)]])),
    });
    const service = makeService(prisma, amo);
    const r = await service.run({ mode: 'dry-run', phases: [1, 2] });
    expect(r.status).toBe('FAILED');
    expect(r.errorCode).toBe('AMO_TOUCH_SYNC_FAILED');
  });

  it('403 от amo останавливает прогон: FAILED + ops-алерт с dedup-ключом', async () => {
    const prisma = makePrisma({
      linked: [{ id: 'b-1', amoContactId: BigInt(1) }],
      unlinked: [{ id: 'u-1', phone: '+79250000001' }],
    });
    const amo = makeAmo({
      getContactsByIds: jest.fn().mockRejectedValue(new Error('amoCRM 403 /contacts?…')),
    });
    const opsAlerts = { sendSafely: jest.fn().mockResolvedValue(true) };
    const service = makeService(prisma, amo, opsAlerts);
    const r = await service.run({ mode: 'apply', phases: [1, 2, 3] });

    expect(r.status).toBe('FAILED');
    expect(r.errorCode).toBe('AMO_AUTH_FAILED');
    expect(amo.findContactsByPhoneExact).not.toHaveBeenCalled(); // фаза 3 не стартовала
    expect(prisma.loyaltySyncRun.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED', errorCode: 'AMO_AUTH_FAILED' }) }),
    );
    expect(opsAlerts.sendSafely).toHaveBeenCalledWith(
      expect.stringContaining('AMO_AUTH_FAILED'),
      expect.objectContaining({ dedupKey: 'amo-touch-sync' }),
    );
  });

  it('5 подряд 429 → остановка; одиночный 429 в пачке — только ошибки пачки', async () => {
    const t = 1_700_000_000;
    const linked = Array.from({ length: 6 }, (_, i) => ({ id: `b-${i}`, amoContactId: BigInt(i + 1) }));
    const contacts = new Map(linked.map((b, i) => [i + 1, contact(i + 1, t)]));
    const prisma = makePrisma({ linked });
    const amo = makeAmo({
      getContactsByIds: jest.fn().mockResolvedValue(contacts),
      getNotesForContacts: jest.fn().mockRejectedValue(new Error('amoCRM 429 /contacts/notes?…')),
    });
    const service = makeService(prisma, amo);
    // 6 контактов → пачки по 50: одна пачка, один 429 → ошибки пачки, прогон жив
    const r = await service.run({ mode: 'apply', phases: [1, 2] });
    expect(r.status).toBe('SUCCEEDED');
    expect(r.stats.errors).toBe(6);
    expect(upsertDataFor(prisma, 'b-0')[0].syncError).toContain('429');

    // 5 пачек подряд с 429 → фатально
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `c-${i}`, amoContactId: BigInt(i + 1) }));
    const manyContacts = new Map(many.map((b, i) => [i + 1, contact(i + 1, t)]));
    const prisma2 = makePrisma({ linked: many });
    const amo2 = makeAmo({
      getContactsByIds: jest.fn().mockResolvedValue(manyContacts),
      getNotesForContacts: jest.fn().mockRejectedValue(new Error('amoCRM 429 /contacts/notes?…')),
    });
    const opsAlerts = { sendSafely: jest.fn().mockResolvedValue(true) };
    const r2 = await makeService(prisma2, amo2, opsAlerts).run({ mode: 'apply', phases: [1, 2] });
    expect(r2.status).toBe('FAILED');
    expect(r2.errorCode).toBe('AMO_RATE_LIMITED');
    expect(amo2.getNotesForContacts).toHaveBeenCalledTimes(5);
  });

  it('замок: уже RUNNING < 4 ч → SKIPPED; зависший > 4 ч → FAILED и продолжаем', async () => {
    const fresh = makePrisma({ runningRun: { id: 'old', startedAt: new Date(Date.now() - 10 * 60 * 1000), ruleVersion: 'amo-touch-v1' } });
    const r = await makeService(fresh, makeAmo()).run({ mode: 'apply' });
    expect(r.status).toBe('SKIPPED');
    expect(fresh.loyaltySyncRun.create).not.toHaveBeenCalled();

    const stale = makePrisma({ runningRun: { id: 'old', startedAt: new Date(Date.now() - 5 * 60 * 60 * 1000), ruleVersion: 'amo-touch-v1' } });
    const opsAlerts = { sendSafely: jest.fn().mockResolvedValue(true) };
    const r2 = await makeService(stale, makeAmo(), opsAlerts).run({ mode: 'apply' });
    expect(r2.status).toBe('SUCCEEDED');
    expect(stale.loyaltySyncRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'old', status: 'RUNNING' }, data: expect.objectContaining({ status: 'FAILED', errorCode: 'STALE_RUN' }) }),
    );
    expect(opsAlerts.sendSafely).toHaveBeenCalledWith(expect.stringContaining('завис'), expect.anything());
  });

  it('фаза 0: ручная привязка (matchedBy=manual) не перезаписывается, email-привязка ставится', async () => {
    const prisma = makePrisma({
      staff: [{ id: 'mgr-1', email: 'a@x.ru' }, { id: 'mgr-2', email: 'b@x.ru' }],
      amoUsers: [{ id: BigInt(1), brokerId: 'mgr-2', matchedBy: 'manual' }],
    });
    const amo = makeAmo({
      getUsers: jest.fn().mockResolvedValue([
        { id: 1, name: 'Один', email: 'a@x.ru', is_active: true },
        { id: 2, name: 'Два', email: 'b@x.ru', is_active: false },
        { id: 3, name: 'Три', email: 'nobody@x.ru', is_active: true },
      ]),
    });
    const r = await makeService(prisma, amo).run({ mode: 'apply', phases: [0] });
    expect(r.stats.users).toBe(3);
    const updates = prisma.amoUser.upsert.mock.calls.map((c: any[]) => c[0]);
    expect(updates[0].update).toEqual(expect.objectContaining({ brokerId: 'mgr-2', matchedBy: 'manual' }));
    // mgr-2 занят ручной привязкой → второму пользователю не достаётся
    expect(updates[1].update).toEqual(expect.objectContaining({ brokerId: null, matchedBy: null, isActive: false }));
    expect(updates[2].update).toEqual(expect.objectContaining({ brokerId: null, matchedBy: null }));
  });
});
