// 2026-09-28: ночной синк «касаний» amoCRM → BrokerAmoContactSync (+ справочник
// AmoUser). Только ЧТЕНИЕ из amo, запись — в наши таблицы. Ничего в amo не
// пишет, Broker.assignedManagerId / lastCallAt / имена / почты не трогает.
//
// Фазы (см. docs/amo-integration.md «Ночной синк касаний»):
//   0 — сотрудники amo (GET /users) → AmoUser, автопривязка по email;
//   1 — контакты привязанных брокеров пачками по 250 → кто изменился
//       (contact.updated_at vs BrokerAmoContactSync.amoUpdatedAt);
//   2 — по изменившимся: примечания-звонки + выполненные задачи контакта и
//       его лидов, лид КЦ → lastCall*/lastTouch*/kc*;
//   3 — брокеры без amoContactId: точный поиск по телефону с квотой →
//       LINKED / AMBIGUOUS / NOT_FOUND / NOT_BROKER.
//
// Замок и аудит — LoyaltySyncRun(source=AMOCRM, ruleVersion='amo-touch-v1').
// dry-run: все чтения из amo делаются по-настоящему, записи выполняются
// внутри prisma.$transaction и откатываются броском DryRunRollback —
// ошибки записи (P2002, неверный тип поля) ловятся ДО боевого прогона.

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@st-michael/database';
import {
  AmoCallTouch,
  AmoContact,
  AmoCrmAdapter,
  AmoLead,
  AmoNote,
  AmoTask,
  AmoTaskTouch,
  AMO_CALL_NOTE_TYPES,
  AMO_CONTACT_FIELDS,
  AMO_NOTE_TYPES,
  AMO_PIPELINES,
  amoTouchSystemUserIds,
  getAmoRequestCount,
  isCallNote,
  pickLatestCallNote,
  pickLatestCompletedTask,
  pickLatestKcLead,
} from '@st-michael/integrations';
import { OpsAlertService } from '../ops-alert/ops-alert.service';

export const AMO_TOUCH_SYNC_RULE_VERSION = 'amo-touch-v1';
export const AMO_TOUCH_SYNC_STATE_KEY = 'AMO_TOUCH_SYNC_STATE';
export const AMO_TOUCH_SYNC_ALERT_KEY = 'amo-touch-sync';

const DEFAULT_MAX_CONTACTS = 2000;
const DEFAULT_LOOKUP_QUOTA = 300;
const LOOKUP_RETRY_DAYS = 30;
const STALE_RUN_MS = 4 * 60 * 60 * 1000;
const CONTACT_READ_BATCH = 250;
const TOUCH_BATCH = 50;
const MAX_LOOKUP_CANDIDATES = 10;
const MAX_CONSECUTIVE_429 = 5;
const DRY_RUN_TX_TIMEOUT_MS = 5 * 60 * 1000;
const DB_IN_CHUNK = 5000;
const ERROR_ALERT_SHARE = 0.05;
const SAMPLE_LIMIT = 5;

export type AmoTouchSyncMode = 'apply' | 'dry-run';
export type AmoTouchSyncPhase = 0 | 1 | 2 | 3;

export interface AmoTouchSyncOptions {
  mode: AmoTouchSyncMode;
  /** Сколько изменившихся контактов обработать в фазе 2 за прогон (2000). */
  maxContacts?: number;
  /** Какие фазы выполнять (по умолчанию все). Фаза 2 требует фазы 1. */
  phases?: AmoTouchSyncPhase[];
  /**
   * Принудительно перечитать касания у всех контактов (игнорировать
   * инкрементальный пропуск по updated_at/sourceHash). Ограничено maxContacts
   * в порядке Broker.id — для разового прогона после смены правил.
   */
  backfill?: boolean;
  /** Квота фазы 3 (AMO_TOUCH_LOOKUP_QUOTA, по умолчанию 300). */
  lookupQuota?: number;
}

export interface AmoTouchSyncStats {
  users: number;
  contactsTotal: number;
  contactsChanged: number;
  contactsSkipped: number;
  contactsMissing: number;
  contactsDeferred: number;
  touched: number;
  unchangedHash: number;
  calls: number;
  tasks: number;
  lookups: number;
  linked: number;
  ambiguous: number;
  notFound: number;
  notBroker: number;
  errors: number;
  requests: number;
  durationMs: number;
}

export interface AmoTouchSyncResult {
  status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
  mode: AmoTouchSyncMode;
  runId: string | null;
  stats: AmoTouchSyncStats;
  errorCode: string | null;
  reason: string | null;
  backfillDone: boolean | null;
  samples: string[];
}

export class DryRunRollback extends Error {
  readonly code = 'AMO_TOUCH_SYNC_DRY_RUN_ROLLBACK';
  constructor() {
    super('AMO_TOUCH_SYNC_DRY_RUN_ROLLBACK');
  }
}

export class AmoTouchSyncFatalError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message || code);
  }
}

type Db = Prisma.TransactionClient;

interface PlannedWrite {
  kind: string;
  sample: string | null;
  apply: (db: Db) => Promise<void>;
}

/** 'AUTH' — 401/403/нет токена; 'RATE_LIMIT' — 429 после ретраев адаптера. */
export function classifyAmoError(error: unknown): 'AUTH' | 'RATE_LIMIT' | 'OTHER' {
  const message = String((error as { message?: string })?.message ?? error ?? '');
  if (/\bamoCRM 40[13]\b/.test(message)) return 'AUTH';
  if (message.includes('AMO_ACCESS_TOKEN')) return 'AUTH';
  if (/\bamoCRM 429\b/.test(message)) return 'RATE_LIMIT';
  return 'OTHER';
}

/** Текст ошибки для syncError / логов: без токенов, query и тел ответов. */
export function safeErrorText(error: unknown): string {
  const raw = String((error as { message?: string })?.message ?? error ?? 'unknown');
  return raw
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/\?[^\s]*/g, '?…')
    .replace(/\d{10,}/g, (m) => (m.length > 12 ? '***' : m))
    .slice(0, 300);
}

/** "+7 92x ***-**-19" — маска телефона для очереди ручной привязки и логов. */
export function maskPhone(phone: unknown): string {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length < 10) return '***';
  const d = digits.slice(-10);
  return `+7 ${d[0]}${d[1]}x ***-**-${d[8]}${d[9]}`;
}

const last10 = (phone: unknown): string =>
  String(phone ?? '')
    .replace(/\D/g, '')
    .slice(-10);

const toInt = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
};

const unixToDate = (value: unknown): Date | null => {
  const n = toInt(value);
  return n !== null && n > 0 ? new Date(n * 1000) : null;
};

const toBigInt = (value: unknown): bigint | null => {
  const n = toInt(value);
  return n !== null && n > 0 ? BigInt(n) : null;
};

export function contactIsBroker(contact: AmoContact | null | undefined): boolean {
  const fields = Array.isArray(contact?.custom_fields_values)
    ? contact!.custom_fields_values!
    : [];
  const flag = fields.find(
    (f: any) => Number(f?.field_id) === AMO_CONTACT_FIELDS.IS_BROKER,
  );
  return flag?.values?.[0]?.value === true;
}

export function contactPhones(contact: AmoContact | null | undefined): string[] {
  const fields = Array.isArray(contact?.custom_fields_values)
    ? contact!.custom_fields_values!
    : [];
  const phoneField = fields.find(
    (f: any) =>
      Number(f?.field_id) === AMO_CONTACT_FIELDS.PHONE || f?.field_code === 'PHONE',
  );
  return (phoneField?.values || [])
    .map((v: any) => String(v?.value ?? ''))
    .filter((v: string) => v);
}

/**
 * Брокер присутствует в контактах лида в любой роли (main или второй).
 * Лид без сведений о контактах (нет _embedded.contacts) — считаем своим.
 * Так выбираются лид КЦ (ответственный «как назначил Морикит» на заявке
 * клиента, где брокер второй контакт) и лиды, откуда читаем звонки.
 */
export function leadHasContact(lead: AmoLead, contactId: number): boolean {
  const contacts: Array<{ id?: unknown }> | undefined = lead?._embedded?.contacts;
  if (!Array.isArray(contacts) || contacts.length === 0) return true;
  return contacts.some((c) => Number(c?.id) === contactId);
}

/**
 * Лид «про этого брокера»: брокер — главный контакт (is_main), либо
 * единственный. Лиды клиентов, где брокер прикреплён вторым контактом
 * (фиксации в воронке КЦ), сюда НЕ попадают: выполненные задачи там — про
 * клиента, и звонки без params.phone там тоже не считаем.
 * Лид без сведений о контактах (нет _embedded.contacts) — считаем своим.
 */
export function leadIsAboutContact(lead: AmoLead, contactId: number): boolean {
  const contacts: Array<{ id?: unknown; is_main?: unknown }> | undefined =
    lead?._embedded?.contacts;
  if (!Array.isArray(contacts) || contacts.length === 0) return true;
  const mine = contacts.find((c) => Number(c?.id) === contactId);
  if (!mine) return false;
  if (contacts.length === 1) return true;
  if (typeof mine.is_main === 'boolean') return mine.is_main;
  return Number(contacts[0]?.id) === contactId;
}

export interface ContactTouchInput {
  contact: AmoContact;
  /** Лиды контакта, которые удалось прочитать (getLeadsByIds). */
  leads: AmoLead[];
  contactNotes: AmoNote[];
  /** Примечания лидов по id лида. */
  leadNotes: Map<number, AmoNote[]>;
  contactTasks: AmoTask[];
  leadTasks: Map<number, AmoTask[]>;
  systemUserIds: Set<number>;
  /**
   * Телефоны брокера (последние 10 цифр: Broker.phone + BrokerPhone).
   * Примечание-звонок с params.phone считается звонком С БРОКЕРОМ, только
   * если номер совпал; иначе это звонок его клиенту по фиксации.
   */
  brokerPhoneKeys: Set<string>;
}

export interface ContactTouchSnapshot {
  amoContactId: bigint;
  amoResponsibleUserId: bigint | null;
  amoUpdatedAt: Date | null;
  amoClosestTaskAt: Date | null;
  kcLeadId: bigint | null;
  kcResponsibleUserId: bigint | null;
  kcLeadUpdatedAt: Date | null;
  lastTouchAt: Date | null;
  lastTouchKind: 'CALL_IN' | 'CALL_OUT' | 'TASK_COMPLETED' | null;
  lastTouchRef: string | null;
  lastTouchUserId: bigint | null;
  lastCallAt: Date | null;
  lastCallDirection: 'IN' | 'OUT' | null;
  lastCallStatus: number | null;
  lastCallResultText: string | null;
  lastCallDurationSec: number | null;
  lastCallUserId: bigint | null;
  sourceHash: string;
  /** Для статистики. */
  call: AmoCallTouch | null;
  task: AmoTaskTouch | null;
  /** Лиды, где брокер main/единственный (задачи, звонки без номера). */
  ownLeadIds: number[];
  /** Лиды, где брокер есть в любой роли (лид КЦ, звонки с номером). */
  linkedLeadIds: number[];
}

/** Телефон из params примечания-звонка → последние 10 цифр (или ''). */
function notePhoneKey(note: AmoNote): string {
  return last10((note as any)?.params?.phone);
}

/**
 * Звонок считается звонком с брокером, если params.phone совпал с одним из
 * его номеров; при пустом phone — только если примечание лежит на самом
 * контакте или на лиде, где брокер main/единственный.
 */
function callNoteIsWithBroker(
  note: AmoNote,
  brokerPhoneKeys: Set<string>,
  onOwnEntity: boolean,
): boolean {
  const key = notePhoneKey(note);
  if (key.length >= 10) return brokerPhoneKeys.has(key);
  return onOwnEntity;
}

function noteAuthor(note: AmoNote): number | null {
  return toInt(note?.created_by) ?? toInt(note?.responsible_user_id);
}

function isHumanNote(note: AmoNote, systemUserIds: Set<number>): boolean {
  if (!isCallNote(note)) return false;
  if ((note as any).note_type === AMO_NOTE_TYPES.SERVICE_MESSAGE) return false;
  const author = noteAuthor(note);
  if (author !== null && systemUserIds.has(author)) return false;
  const callResponsible = toInt((note as any)?.params?.call_responsible);
  if (callResponsible !== null && systemUserIds.has(callResponsible)) return false;
  return true;
}

function isHumanTask(task: AmoTask, systemUserIds: Set<number>): boolean {
  if (!task?.is_completed) return false;
  const executor = toInt(task.responsible_user_id);
  if (executor === null || executor <= 0) return false;
  return !systemUserIds.has(executor);
}

export function computeSourceHash(parts: unknown[]): string {
  return createHash('sha256')
    .update(parts.map((p) => (p === null || p === undefined ? '' : String(p))).join('|'))
    .digest('hex');
}

/** Чистая сборка среза по одному контакту (без сети и БД). */
export function buildContactTouchSnapshot(input: ContactTouchInput): ContactTouchSnapshot {
  const contactId = Number(input.contact.id);
  const brokerPhoneKeys = input.brokerPhoneKeys || new Set<string>();
  const linkedLeads = input.leads.filter((lead) => leadHasContact(lead, contactId));
  const ownLeadIdSet = new Set<number>(
    linkedLeads
      .filter((lead) => leadIsAboutContact(lead, contactId))
      .map((l) => Number(l.id)),
  );
  const linkedLeadIds = linkedLeads.map((l) => Number(l.id));
  const ownLeadIds = [...ownLeadIdSet];

  // Звонки: с контакта + со всех лидов, где брокер есть; чужой номер — мимо.
  const notes: AmoNote[] = [];
  for (const note of input.contactNotes || []) {
    if (!isHumanNote(note, input.systemUserIds)) continue;
    if (callNoteIsWithBroker(note, brokerPhoneKeys, true)) notes.push(note);
  }
  for (const leadId of linkedLeadIds) {
    const onOwnLead = ownLeadIdSet.has(leadId);
    for (const note of input.leadNotes.get(leadId) || []) {
      if (!isHumanNote(note, input.systemUserIds)) continue;
      if (callNoteIsWithBroker(note, brokerPhoneKeys, onOwnLead)) notes.push(note);
    }
  }
  const call = pickLatestCallNote(notes);

  // Задачи: с контакта + только с лидов, где брокер main/единственный.
  const tasks: AmoTask[] = [];
  for (const task of input.contactTasks || []) {
    if (isHumanTask(task, input.systemUserIds)) tasks.push(task);
  }
  for (const leadId of ownLeadIds) {
    for (const task of input.leadTasks.get(leadId) || []) {
      if (isHumanTask(task, input.systemUserIds)) tasks.push(task);
    }
  }
  const task = pickLatestCompletedTask(tasks);

  // Лид КЦ: среди всех лидов воронки КЦ, где брокер есть в любой роли.
  const kcLead = pickLatestKcLead(linkedLeads, AMO_PIPELINES.KC);

  let lastTouchAt: Date | null = null;
  let lastTouchKind: ContactTouchSnapshot['lastTouchKind'] = null;
  let lastTouchRef: string | null = null;
  let lastTouchUserId: bigint | null = null;
  if (call && (!task || call.at.getTime() >= task.at.getTime())) {
    lastTouchAt = call.at;
    lastTouchKind = call.direction === 'IN' ? 'CALL_IN' : 'CALL_OUT';
    lastTouchRef = call.ref;
    lastTouchUserId = toBigInt(call.userId);
  } else if (task) {
    lastTouchAt = task.at;
    lastTouchKind = 'TASK_COMPLETED';
    lastTouchRef = task.ref;
    lastTouchUserId = toBigInt(task.userId);
  }

  const responsible = toInt(input.contact.responsible_user_id);
  const kcResponsible = toInt(kcLead?.responsible_user_id);
  const sourceHash = computeSourceHash([
    input.contact.updated_at,
    responsible,
    call?.noteId,
    task?.taskId,
    kcLead?.id,
    kcLead?.updated_at,
    kcResponsible,
  ]);

  return {
    amoContactId: BigInt(contactId),
    amoResponsibleUserId: toBigInt(responsible),
    amoUpdatedAt: unixToDate(input.contact.updated_at),
    amoClosestTaskAt: unixToDate(input.contact.closest_task_at),
    kcLeadId: toBigInt(kcLead?.id),
    kcResponsibleUserId: toBigInt(kcResponsible),
    kcLeadUpdatedAt: unixToDate(kcLead?.updated_at),
    lastTouchAt,
    lastTouchKind,
    lastTouchRef,
    lastTouchUserId,
    lastCallAt: call?.at ?? null,
    lastCallDirection: call?.direction ?? null,
    lastCallStatus: call?.status ?? null,
    lastCallResultText: call?.resultText ?? null,
    lastCallDurationSec: call?.durationSec ?? null,
    lastCallUserId: toBigInt(call?.userId),
    sourceHash,
    call,
    task,
    ownLeadIds,
    linkedLeadIds,
  };
}

function snapshotToSyncData(snapshot: ContactTouchSnapshot, now: Date) {
  return {
    amoContactId: snapshot.amoContactId,
    amoResponsibleUserId: snapshot.amoResponsibleUserId,
    amoUpdatedAt: snapshot.amoUpdatedAt,
    amoClosestTaskAt: snapshot.amoClosestTaskAt,
    kcLeadId: snapshot.kcLeadId,
    kcResponsibleUserId: snapshot.kcResponsibleUserId,
    kcLeadUpdatedAt: snapshot.kcLeadUpdatedAt,
    lastTouchAt: snapshot.lastTouchAt,
    lastTouchKind: snapshot.lastTouchKind,
    lastTouchRef: snapshot.lastTouchRef,
    lastTouchUserId: snapshot.lastTouchUserId,
    lastCallAt: snapshot.lastCallAt,
    lastCallDirection: snapshot.lastCallDirection,
    lastCallStatus: snapshot.lastCallStatus,
    lastCallResultText: snapshot.lastCallResultText,
    lastCallDurationSec: snapshot.lastCallDurationSec,
    lastCallUserId: snapshot.lastCallUserId,
    amoLookupStatus: 'LINKED',
    amoLookupCandidates: Prisma.DbNull,
    syncedAt: now,
    syncError: null,
    sourceHash: snapshot.sourceHash,
  };
}

const fmt = (d: Date | null | undefined): string => (d ? d.toISOString() : '-');

function emptyStats(): AmoTouchSyncStats {
  return {
    users: 0,
    contactsTotal: 0,
    contactsChanged: 0,
    contactsSkipped: 0,
    contactsMissing: 0,
    contactsDeferred: 0,
    touched: 0,
    unchangedHash: 0,
    calls: 0,
    tasks: 0,
    lookups: 0,
    linked: 0,
    ambiguous: 0,
    notFound: 0,
    notBroker: 0,
    errors: 0,
    requests: 0,
    durationMs: 0,
  };
}

export function formatAmoTouchSyncSummary(
  mode: AmoTouchSyncMode,
  status: string,
  s: AmoTouchSyncStats,
  errorCode?: string | null,
): string {
  return (
    `amo-touch-sync ${mode} ${status}` +
    (errorCode ? ` (${errorCode})` : '') +
    `: users=${s.users} contacts=${s.contactsTotal} changed=${s.contactsChanged}` +
    ` skipped=${s.contactsSkipped} missing=${s.contactsMissing} deferred=${s.contactsDeferred}` +
    ` touched=${s.touched} sameHash=${s.unchangedHash} calls=${s.calls} tasks=${s.tasks}` +
    ` lookups=${s.lookups} linked=${s.linked} ambiguous=${s.ambiguous}` +
    ` notFound=${s.notFound} notBroker=${s.notBroker} errors=${s.errors}` +
    ` requests=${s.requests} ${Math.round(s.durationMs / 1000)}s`
  );
}

/**
 * Копилка записей. apply — каждая запись выполняется сразу при flush()
 * (прогресс сохраняется даже если прогон оборвётся); dry-run — копятся и
 * в конце выполняются одной транзакцией с откатом.
 */
class WriteSink {
  private pending: PlannedWrite[] = [];
  readonly samples: string[] = [];
  planned = 0;

  constructor(
    private readonly mode: AmoTouchSyncMode,
    private readonly prisma: PrismaClient,
    private readonly stats: AmoTouchSyncStats,
    private readonly logger: Logger,
  ) {}

  add(write: PlannedWrite): void {
    this.planned += 1;
    if (write.sample && this.samples.length < SAMPLE_LIMIT) {
      this.samples.push(`[${write.kind}] ${write.sample}`);
    }
    this.pending.push(write);
  }

  async flush(): Promise<void> {
    if (this.mode !== 'apply') return;
    const batch = this.pending;
    this.pending = [];
    for (const write of batch) {
      try {
        await write.apply(this.prisma);
      } catch (error) {
        this.stats.errors += 1;
        this.logger.warn(
          `[amo-touch-sync] write ${write.kind} failed: ${safeErrorText(error)}`,
        );
      }
    }
  }

  /** dry-run: выполнить все записи в транзакции и откатить. */
  async rollbackDryRun(): Promise<void> {
    if (this.mode !== 'dry-run') return;
    const batch = this.pending;
    this.pending = [];
    if (batch.length === 0) return;
    try {
      await this.prisma.$transaction(
        async (tx) => {
          for (const write of batch) await write.apply(tx);
          throw new DryRunRollback();
        },
        { timeout: DRY_RUN_TX_TIMEOUT_MS, maxWait: 30_000 },
      );
    } catch (error) {
      if (error instanceof DryRunRollback) return;
      throw error;
    }
    throw new Error('AMO_TOUCH_SYNC_DRY_RUN_NOT_ROLLED_BACK');
  }
}

interface LinkedBrokerRow {
  id: string;
  amoContactId: bigint | null;
  phone?: string | null;
  phones?: Array<{ phone: string | null }>;
}

export function brokerPhoneKeys(broker: LinkedBrokerRow): Set<string> {
  const out = new Set<string>();
  for (const raw of [broker.phone, ...(broker.phones || []).map((p) => p?.phone)]) {
    const key = last10(raw);
    if (key.length >= 10) out.add(key);
  }
  return out;
}

interface SyncRowLite {
  brokerId: string;
  amoUpdatedAt: Date | null;
  sourceHash: string | null;
  syncError: string | null;
}

interface ChangedContact {
  broker: LinkedBrokerRow;
  contact: AmoContact;
  existing: SyncRowLite | undefined;
}

@Injectable()
export class AmoTouchSyncService {
  private readonly logger = new Logger(AmoTouchSyncService.name);
  private amo: AmoCrmAdapter = new AmoCrmAdapter();
  private consecutive429 = 0;

  constructor(
    @Inject('PrismaClient') private readonly prisma: PrismaClient,
    @Optional() private readonly opsAlerts?: OpsAlertService,
  ) {}

  /** Подмена адаптера (тесты, одноразовые скрипты). */
  setAdapter(amo: AmoCrmAdapter): void {
    this.amo = amo;
  }

  async run(opts: AmoTouchSyncOptions): Promise<AmoTouchSyncResult> {
    const mode: AmoTouchSyncMode = opts.mode === 'dry-run' ? 'dry-run' : 'apply';
    const phases = new Set<AmoTouchSyncPhase>(
      Array.isArray(opts.phases) && opts.phases.length ? opts.phases : [0, 1, 2, 3],
    );
    const stats = emptyStats();
    const startedAt = Date.now();
    const requestsBefore = getAmoRequestCount();
    const sink = new WriteSink(mode, this.prisma, stats, this.logger);
    this.consecutive429 = 0;

    const skipped = (reason: string): AmoTouchSyncResult => {
      this.logger.warn(`[amo-touch-sync] skip: ${reason}`);
      return {
        status: 'SKIPPED',
        mode,
        runId: null,
        stats,
        errorCode: null,
        reason,
        backfillDone: null,
        samples: [],
      };
    };

    // --- замок: один прогон AMOCRM одновременно ---
    const running = await this.prisma.loyaltySyncRun.findFirst({
      where: { source: 'AMOCRM', status: 'RUNNING' },
      select: { id: true, startedAt: true, ruleVersion: true },
      orderBy: { startedAt: 'asc' },
    });
    if (running) {
      const ageMs = Date.now() - new Date(running.startedAt).getTime();
      if (ageMs < STALE_RUN_MS) {
        return skipped(`already running (${running.ruleVersion}, ${Math.round(ageMs / 60000)} min)`);
      }
      await this.prisma.loyaltySyncRun.updateMany({
        where: { id: running.id, status: 'RUNNING' },
        data: { status: 'FAILED', errorCode: 'STALE_RUN', completedAt: new Date() },
      });
      await this.alert(
        `⚠️ amo-touch-sync: прошлый прогон ${running.ruleVersion} завис (> 4 ч), помечен FAILED`,
      );
    }

    const actorId = await this.resolveActorId();
    let runId: string;
    try {
      const run = await this.prisma.loyaltySyncRun.create({
        data: {
          source: 'AMOCRM',
          ruleVersion: AMO_TOUCH_SYNC_RULE_VERSION,
          sourceRefHash: computeSourceHash(['amo-touch-sync', mode]),
          requestedById: actorId,
        },
        select: { id: true },
      });
      runId = run.id;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return skipped('already running (P2002)');
      }
      throw error;
    }

    let backfillDone: boolean | null = null;
    let errorCode: string | null = null;
    let status: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED';
    try {
      const systemUserIds = amoTouchSystemUserIds();
      if (phases.has(0)) await this.phaseUsers(sink, stats);
      await sink.flush();

      let changed: ChangedContact[] = [];
      if (phases.has(1)) {
        const p1 = await this.phaseContacts(opts, sink, stats);
        changed = p1.changed;
        backfillDone = p1.backfillDone;
        await sink.flush();
      } else if (phases.has(2)) {
        this.logger.warn('[amo-touch-sync] фаза 2 без фазы 1 невозможна — пропуск');
      }

      if (phases.has(2) && changed.length > 0) {
        await this.phaseTouches(changed, systemUserIds, sink, stats);
      }

      if (phases.has(3)) {
        await this.phaseLookup(opts, sink, stats);
        await sink.flush();
      }

      if (mode === 'apply' && phases.has(1)) {
        await this.saveState(stats, backfillDone, startedAt);
      }
      await sink.rollbackDryRun();
    } catch (error) {
      status = 'FAILED';
      errorCode =
        error instanceof AmoTouchSyncFatalError
          ? error.code
          : error instanceof Prisma.PrismaClientKnownRequestError
            ? `DB_${error.code}`
            : 'AMO_TOUCH_SYNC_FAILED';
      this.logger.error(
        `[amo-touch-sync] ${errorCode}: ${safeErrorText(error)}`,
      );
    }

    stats.requests = getAmoRequestCount() - requestsBefore;
    stats.durationMs = Date.now() - startedAt;
    const counts = { mode, ...stats, backfillDone, plannedWrites: sink.planned };
    await this.prisma.loyaltySyncRun.updateMany({
      where: { id: runId, status: 'RUNNING' },
      data: {
        status,
        errorCode,
        counts: counts as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });

    const summary = formatAmoTouchSyncSummary(mode, status, stats, errorCode);
    this.logger.log(`[amo-touch-sync] ${summary}`);
    for (const sample of sink.samples) this.logger.log(`[amo-touch-sync] пример: ${sample}`);

    if (status === 'FAILED') {
      await this.alert(`🔴 ${summary}`);
    } else if (mode === 'apply') {
      const share = stats.contactsTotal > 0 ? stats.errors / stats.contactsTotal : 0;
      await this.alert(
        `${share > ERROR_ALERT_SHARE ? '⚠️' : '🟢'} ${summary}`,
        `${AMO_TOUCH_SYNC_ALERT_KEY}:summary`,
        0,
      );
    }

    return {
      status,
      mode,
      runId,
      stats,
      errorCode,
      reason: null,
      backfillDone,
      samples: sink.samples,
    };
  }

  // ─── Фаза 0: сотрудники amo ───────────────────────────────────────────

  private async phaseUsers(sink: WriteSink, stats: AmoTouchSyncStats): Promise<void> {
    const users = await this.amoCall(() => this.amo.getUsers());
    stats.users = users.length;
    if (users.length === 0) return;

    const staff = await this.prisma.broker.findMany({
      where: {
        role: { in: ['MANAGER', 'ADMIN'] },
        mergedIntoId: null,
        email: { not: null },
      },
      select: { id: true, email: true },
    });
    const staffByEmail = new Map<string, string[]>();
    for (const b of staff) {
      const key = String(b.email || '').trim().toLowerCase();
      if (!key) continue;
      const list = staffByEmail.get(key) || [];
      list.push(b.id);
      staffByEmail.set(key, list);
    }
    const existing = await this.prisma.amoUser.findMany({
      select: { id: true, brokerId: true, matchedBy: true },
    });
    const existingById = new Map(existing.map((u) => [Number(u.id), u]));
    const takenBrokerIds = new Set<string>();
    for (const u of existing) {
      if (u.brokerId && u.matchedBy === 'manual') takenBrokerIds.add(u.brokerId);
    }

    for (const user of users) {
      const id = Number(user.id);
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      const email = typeof user.email === 'string' && user.email.trim() ? user.email.trim() : null;
      const isActive = user.is_active !== false;
      const name = String(user.name || '').trim() || `amo user ${id}`;
      const prev = existingById.get(id);

      let brokerId: string | null = null;
      let matchedBy: string | null = null;
      if (prev?.matchedBy === 'manual') {
        brokerId = prev.brokerId;
        matchedBy = prev.matchedBy;
      } else {
        const candidates = email ? staffByEmail.get(email.toLowerCase()) || [] : [];
        const candidate = candidates.length === 1 ? candidates[0] : null;
        if (candidate && !takenBrokerIds.has(candidate)) {
          brokerId = candidate;
          matchedBy = 'email';
        }
      }
      if (brokerId) takenBrokerIds.add(brokerId);

      sink.add({
        kind: 'amoUser',
        sample: null,
        apply: async (db) => {
          await db.amoUser.upsert({
            where: { id: BigInt(id) },
            create: { id: BigInt(id), name, email, isActive, brokerId, matchedBy },
            update: { name, email, isActive, brokerId, matchedBy },
          });
        },
      });
    }
  }

  // ─── Фаза 1: контакты привязанных брокеров ───────────────────────────

  private async phaseContacts(
    opts: AmoTouchSyncOptions,
    sink: WriteSink,
    stats: AmoTouchSyncStats,
  ): Promise<{ changed: ChangedContact[]; backfillDone: boolean }> {
    const maxContacts = this.positive(opts.maxContacts, DEFAULT_MAX_CONTACTS);
    const brokers = (await this.prisma.broker.findMany({
      where: { role: 'BROKER', mergedIntoId: null, amoContactId: { not: null } },
      select: {
        id: true,
        amoContactId: true,
        phone: true,
        phones: { select: { phone: true } },
      },
      orderBy: { id: 'asc' },
    })) as LinkedBrokerRow[];
    stats.contactsTotal = brokers.length;
    if (brokers.length === 0) return { changed: [], backfillDone: true };

    const rows = new Map<string, SyncRowLite>();
    for (let i = 0; i < brokers.length; i += DB_IN_CHUNK) {
      const chunk = brokers.slice(i, i + DB_IN_CHUNK).map((b) => b.id);
      const part = await this.prisma.brokerAmoContactSync.findMany({
        where: { brokerId: { in: chunk } },
        select: { brokerId: true, amoUpdatedAt: true, sourceHash: true, syncError: true },
      });
      for (const r of part) rows.set(r.brokerId, r);
    }

    const unprocessed: LinkedBrokerRow[] = [];
    const processed: LinkedBrokerRow[] = [];
    for (const b of brokers) {
      const row = rows.get(b.id);
      if (opts.backfill || !row || !row.sourceHash) unprocessed.push(b);
      else processed.push(b);
    }
    const selectedUnprocessed = unprocessed.slice(0, maxContacts);
    const toRead = [...selectedUnprocessed, ...processed];
    const now = new Date();

    const contacts = new Map<number, AmoContact>();
    for (let i = 0; i < toRead.length; i += CONTACT_READ_BATCH) {
      const ids = toRead
        .slice(i, i + CONTACT_READ_BATCH)
        .map((b) => Number(b.amoContactId))
        .filter((id) => Number.isSafeInteger(id) && id > 0);
      if (ids.length === 0) continue;
      const part = await this.amoCall(() =>
        this.amo.getContactsByIds(ids, { propagateErrors: true }),
      );
      for (const [id, c] of part) contacts.set(id, c);
    }

    const changed: ChangedContact[] = [];
    for (const b of toRead) {
      const contactId = Number(b.amoContactId);
      const contact = contacts.get(contactId);
      const row = rows.get(b.id);
      if (!contact) {
        stats.contactsMissing += 1;
        if (row?.syncError === 'CONTACT_NOT_FOUND_IN_AMO') continue;
        sink.add({
          kind: 'sync.missing',
          sample: `broker=${b.id.slice(0, 8)} contact=${contactId} → не найден в amo`,
          apply: async (db) => {
            await db.brokerAmoContactSync.upsert({
              where: { brokerId: b.id },
              create: {
                brokerId: b.id,
                amoContactId: BigInt(contactId),
                syncedAt: now,
                syncError: 'CONTACT_NOT_FOUND_IN_AMO',
              },
              update: { syncedAt: now, syncError: 'CONTACT_NOT_FOUND_IN_AMO' },
            });
          },
        });
        continue;
      }
      const updatedAt = unixToDate(contact.updated_at);
      const isProcessed = !opts.backfill && !!row?.sourceHash;
      if (
        isProcessed &&
        row?.amoUpdatedAt &&
        updatedAt &&
        row.amoUpdatedAt.getTime() === updatedAt.getTime()
      ) {
        stats.contactsSkipped += 1;
        continue;
      }
      changed.push({ broker: b, contact, existing: row });
    }

    if (changed.length > maxContacts) {
      stats.contactsDeferred = changed.length - maxContacts;
      changed.length = maxContacts;
    }
    stats.contactsChanged = changed.length;
    const backfillDone =
      unprocessed.length <= selectedUnprocessed.length && stats.contactsDeferred === 0;
    this.logger.log(
      `[amo-touch-sync] фаза 1: linked=${brokers.length} read=${toRead.length} fetched=${contacts.size} ` +
        `unprocessed=${unprocessed.length} changed=${changed.length} skipped=${stats.contactsSkipped} ` +
        `missing=${stats.contactsMissing} deferred=${stats.contactsDeferred}`,
    );
    return { changed, backfillDone };
  }

  // ─── Фаза 2: касания ──────────────────────────────────────────────────

  private async phaseTouches(
    changed: ChangedContact[],
    systemUserIds: Set<number>,
    sink: WriteSink,
    stats: AmoTouchSyncStats,
  ): Promise<void> {
    const noteTypes = [...AMO_CALL_NOTE_TYPES];

    for (let i = 0; i < changed.length; i += TOUCH_BATCH) {
      const batch = changed.slice(i, i + TOUCH_BATCH);
      const now = new Date();
      const contactIds = batch.map((c) => Number(c.contact.id));

      try {
        const leadIdSet = new Set<number>();
        for (const item of batch) {
          for (const l of item.contact._embedded?.leads || []) {
            const id = Number(l?.id);
            if (Number.isSafeInteger(id) && id > 0) leadIdSet.add(id);
          }
        }
        const leadIds = [...leadIdSet];
        const leads = leadIds.length
          ? await this.amoCall(() => this.amo.getLeadsByIds(leadIds))
          : new Map<number, AmoLead>();

        // Звонки читаем со всех лидов, где брокер есть (любая роль); задачи —
        // только с лидов, где брокер main/единственный.
        const noteLeadIds = new Set<number>();
        const taskLeadIds = new Set<number>();
        const leadsByContact = new Map<number, AmoLead[]>();
        for (const item of batch) {
          const contactId = Number(item.contact.id);
          const linked: AmoLead[] = [];
          for (const l of item.contact._embedded?.leads || []) {
            const lead = leads.get(Number(l?.id));
            if (!lead || !leadHasContact(lead, contactId)) continue;
            linked.push(lead);
            noteLeadIds.add(Number(lead.id));
            if (leadIsAboutContact(lead, contactId)) taskLeadIds.add(Number(lead.id));
          }
          leadsByContact.set(contactId, linked);
        }
        const noteLeads = [...noteLeadIds];
        const taskLeads = [...taskLeadIds];

        const contactNotes = await this.amoCall(() =>
          this.amo.getNotesForContacts(contactIds, { noteTypes }),
        );
        const leadNotes = noteLeads.length
          ? await this.amoCall(() => this.amo.getNotesForLeads(noteLeads, { noteTypes }))
          : new Map<number, AmoNote[]>();
        const contactTasks = await this.amoCall(() =>
          this.amo.getTasksForEntities('contacts', contactIds, { isCompleted: true }),
        );
        const leadTasks = taskLeads.length
          ? await this.amoCall(() =>
              this.amo.getTasksForEntities('leads', taskLeads, { isCompleted: true }),
            )
          : new Map<number, AmoTask[]>();

        for (const item of batch) {
          const contactId = Number(item.contact.id);
          try {
            const snapshot = buildContactTouchSnapshot({
              contact: item.contact,
              leads: leadsByContact.get(contactId) || [],
              contactNotes: contactNotes.get(contactId) || [],
              leadNotes,
              contactTasks: contactTasks.get(contactId) || [],
              leadTasks,
              systemUserIds,
              brokerPhoneKeys: brokerPhoneKeys(item.broker),
            });
            if (item.existing?.sourceHash === snapshot.sourceHash) {
              stats.unchangedHash += 1;
              continue;
            }
            stats.touched += 1;
            if (snapshot.call) stats.calls += 1;
            if (snapshot.task) stats.tasks += 1;
            const data = snapshotToSyncData(snapshot, now);
            sink.add({
              kind: 'sync.touch',
              sample:
                `broker=${item.broker.id.slice(0, 8)} contact=${contactId} ` +
                `lastTouch=${fmt(snapshot.lastTouchAt)} ${snapshot.lastTouchKind || '-'} ` +
                `user=${snapshot.lastTouchUserId ?? '-'} lastCall=${fmt(snapshot.lastCallAt)} ` +
                `status=${snapshot.lastCallStatus ?? '-'} kcLead=${snapshot.kcLeadId ?? '-'} ` +
                `kcResp=${snapshot.kcResponsibleUserId ?? '-'} resp=${snapshot.amoResponsibleUserId ?? '-'}`,
              apply: async (db) => {
                await db.brokerAmoContactSync.upsert({
                  where: { brokerId: item.broker.id },
                  create: { brokerId: item.broker.id, ...data },
                  update: data,
                });
              },
            });
          } catch (error) {
            stats.errors += 1;
            this.planSyncError(sink, item, now, safeErrorText(error));
          }
        }
      } catch (error) {
        // Фатальные (401/403, 5×429) — стоп прогона; остальное — ошибки пачки.
        if (error instanceof AmoTouchSyncFatalError) throw error;
        stats.errors += batch.length;
        const text = safeErrorText(error);
        this.logger.warn(`[amo-touch-sync] фаза 2: пачка ${i / TOUCH_BATCH + 1} не прочитана: ${text}`);
        for (const item of batch) this.planSyncError(sink, item, now, text);
      }
      await sink.flush();
    }
    this.logger.log(
      `[amo-touch-sync] фаза 2: touched=${stats.touched} sameHash=${stats.unchangedHash} ` +
        `calls=${stats.calls} tasks=${stats.tasks} errors=${stats.errors}`,
    );
  }

  private planSyncError(sink: WriteSink, item: ChangedContact, now: Date, text: string): void {
    sink.add({
      kind: 'sync.error',
      sample: null,
      apply: async (db) => {
        await db.brokerAmoContactSync.upsert({
          where: { brokerId: item.broker.id },
          create: {
            brokerId: item.broker.id,
            amoContactId: BigInt(Number(item.contact.id)),
            syncedAt: now,
            syncError: text,
          },
          update: { syncedAt: now, syncError: text },
        });
      },
    });
  }

  // ─── Фаза 3: брокеры без amoContactId ────────────────────────────────

  private async phaseLookup(
    opts: AmoTouchSyncOptions,
    sink: WriteSink,
    stats: AmoTouchSyncStats,
  ): Promise<void> {
    const quota = this.positive(
      opts.lookupQuota ?? toInt(process.env.AMO_TOUCH_LOOKUP_QUOTA) ?? undefined,
      DEFAULT_LOOKUP_QUOTA,
    );
    const retryBefore = new Date(Date.now() - LOOKUP_RETRY_DAYS * 24 * 60 * 60 * 1000);
    const candidates = await this.prisma.broker.findMany({
      where: {
        role: 'BROKER',
        mergedIntoId: null,
        amoContactId: null,
        NOT: { phone: { startsWith: 'tg:' } },
        OR: [
          { amoContactSync: { is: null } },
          { amoContactSync: { is: { amoLookupAt: null } } },
          { amoContactSync: { is: { amoLookupAt: { lt: retryBefore } } } },
        ],
      },
      select: { id: true, phone: true },
      orderBy: { id: 'asc' },
      take: quota,
    });
    if (candidates.length === 0) return;

    const taken = new Set<string>();
    const linkedRows = await this.prisma.broker.findMany({
      where: { amoContactId: { not: null } },
      select: { amoContactId: true },
    });
    for (const r of linkedRows) if (r.amoContactId !== null) taken.add(String(r.amoContactId));

    for (const broker of candidates) {
      const now = new Date();
      const digits = last10(broker.phone);
      if (digits.length < 10) {
        this.planLookup(sink, broker.id, now, 'NOT_FOUND', null, null, 'INVALID_PHONE');
        stats.notFound += 1;
        continue;
      }
      stats.lookups += 1;
      let matches: AmoContact[];
      try {
        matches = await this.amoCall(() => this.amo.findContactsByPhoneExact(broker.phone));
      } catch (error) {
        if (error instanceof AmoTouchSyncFatalError) throw error;
        stats.errors += 1;
        this.logger.warn(
          `[amo-touch-sync] фаза 3: поиск ${maskPhone(broker.phone)} не удался: ${safeErrorText(error)}`,
        );
        continue; // amoLookupAt не ставим — повторим следующей ночью
      }

      const toCandidate = (c: AmoContact) => ({
        id: Number(c.id),
        name: String(c.name || '').slice(0, 120),
        phoneMasked: maskPhone(contactPhones(c).find((p) => last10(p) === digits) ?? broker.phone),
        responsibleUserId: toInt(c.responsible_user_id),
        updatedAt: fmt(unixToDate(c.updated_at)),
        isBroker: contactIsBroker(c),
      });
      const sample = `broker=${broker.id.slice(0, 8)} phone=${maskPhone(broker.phone)}`;

      if (matches.length === 0) {
        stats.notFound += 1;
        this.planLookup(sink, broker.id, now, 'NOT_FOUND', null, null, null, `${sample} → NOT_FOUND`);
        continue;
      }
      if (matches.length > 1) {
        stats.ambiguous += 1;
        this.planLookup(
          sink,
          broker.id,
          now,
          'AMBIGUOUS',
          null,
          matches.slice(0, MAX_LOOKUP_CANDIDATES).map(toCandidate),
          null,
          `${sample} → AMBIGUOUS (${matches.length})`,
        );
        continue;
      }
      const only = matches[0];
      const onlyId = Number(only.id);
      if (!contactIsBroker(only)) {
        stats.notBroker += 1;
        this.planLookup(sink, broker.id, now, 'NOT_BROKER', null, [toCandidate(only)], null, `${sample} → NOT_BROKER contact=${onlyId}`);
        continue;
      }
      if (taken.has(String(onlyId))) {
        stats.ambiguous += 1;
        this.planLookup(sink, broker.id, now, 'AMBIGUOUS', null, [toCandidate(only)], 'AMO_CONTACT_ID_TAKEN', `${sample} → AMBIGUOUS contact=${onlyId} занят`);
        continue;
      }
      taken.add(String(onlyId));
      stats.linked += 1;
      sink.add({
        kind: 'broker.link',
        sample: `${sample} → LINKED contact=${onlyId}`,
        apply: async (db) => {
          await db.broker.update({
            where: { id: broker.id },
            data: { amoContactId: BigInt(onlyId) },
          });
        },
      });
      this.planLookup(sink, broker.id, now, 'LINKED', BigInt(onlyId), null, null);
    }
    this.logger.log(
      `[amo-touch-sync] фаза 3: quota=${quota} candidates=${candidates.length} lookups=${stats.lookups} ` +
        `linked=${stats.linked} ambiguous=${stats.ambiguous} notFound=${stats.notFound} notBroker=${stats.notBroker}`,
    );
  }

  private planLookup(
    sink: WriteSink,
    brokerId: string,
    now: Date,
    status: 'LINKED' | 'AMBIGUOUS' | 'NOT_FOUND' | 'NOT_BROKER',
    amoContactId: bigint | null,
    candidates: Array<Record<string, unknown>> | null,
    syncError: string | null,
    sample: string | null = null,
  ): void {
    const candidatesJson = candidates
      ? (candidates as Prisma.InputJsonValue)
      : Prisma.DbNull;
    sink.add({
      kind: `lookup.${status}`,
      sample,
      apply: async (db) => {
        await db.brokerAmoContactSync.upsert({
          where: { brokerId },
          create: {
            brokerId,
            amoContactId,
            amoLookupAt: now,
            amoLookupStatus: status,
            amoLookupCandidates: candidatesJson,
            syncedAt: now,
            syncError,
          },
          update: {
            ...(amoContactId ? { amoContactId } : {}),
            amoLookupAt: now,
            amoLookupStatus: status,
            amoLookupCandidates: candidatesJson,
            syncedAt: now,
            syncError,
          },
        });
      },
    });
  }

  // ─── Служебное ────────────────────────────────────────────────────────

  /** Все вызовы amo идут здесь: фон (светофор в адаптере), стоп на 401/403 и 5×429. */
  private async amoCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      this.consecutive429 = 0;
      return result;
    } catch (error) {
      if (error instanceof AmoTouchSyncFatalError) throw error;
      const kind = classifyAmoError(error);
      if (kind === 'AUTH') {
        throw new AmoTouchSyncFatalError('AMO_AUTH_FAILED', safeErrorText(error));
      }
      if (kind === 'RATE_LIMIT') {
        this.consecutive429 += 1;
        if (this.consecutive429 >= MAX_CONSECUTIVE_429) {
          throw new AmoTouchSyncFatalError('AMO_RATE_LIMITED', safeErrorText(error));
        }
      }
      throw error;
    }
  }

  private async resolveActorId(): Promise<string> {
    const fromEnv = String(process.env.AMO_TOUCH_SYNC_ACTOR_ID || '').trim();
    if (fromEnv) return fromEnv;
    const admin = await this.prisma.broker.findFirst({
      where: { role: 'ADMIN', mergedIntoId: null },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!admin) throw new AmoTouchSyncFatalError('AMO_TOUCH_SYNC_ACTOR_NOT_FOUND');
    return admin.id;
  }

  private async saveState(
    stats: AmoTouchSyncStats,
    backfillDone: boolean | null,
    startedAt: number,
  ): Promise<void> {
    const value = JSON.stringify({
      lastRunAt: new Date(startedAt).toISOString(),
      lastRunStats: { ...stats, durationMs: Date.now() - startedAt },
      backfillDone: backfillDone === true,
    });
    try {
      await this.prisma.systemSetting.upsert({
        where: { key: AMO_TOUCH_SYNC_STATE_KEY },
        create: { key: AMO_TOUCH_SYNC_STATE_KEY, value, updatedBy: 'amo-touch-sync' },
        update: { value, updatedBy: 'amo-touch-sync' },
      });
    } catch (error) {
      this.logger.warn(`[amo-touch-sync] state not saved: ${safeErrorText(error)}`);
    }
  }

  private async alert(
    message: string,
    dedupKey: string = AMO_TOUCH_SYNC_ALERT_KEY,
    cooldownMs: number = 60 * 60 * 1000,
  ): Promise<void> {
    try {
      await this.opsAlerts?.sendSafely(message, { dedupKey, cooldownMs });
    } catch {
      this.logger.error('[amo-touch-sync] ops alert delivery failed');
    }
  }

  private positive(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fallback;
  }
}
