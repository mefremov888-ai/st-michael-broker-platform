// 2026-09-28: типы и чистые функции для ночного синка «касаний» из amoCRM
// (звонки-примечания, выполненные задачи, ответственные, лиды КЦ).
// Сюда — только то, что не ходит в сеть. Сетевые методы — в
// amo-crm.adapter.ts (getContactNotes / getNotesForContacts / …).

import {
  AMO_CALL_STATUS_TEXT,
  AMO_NOTE_TYPES,
  AMO_PIPELINES,
} from "./amo-crm.fields";

// === Примечания (notes) ===

/** Параметры примечания-звонка (note_type = call_in | call_out). */
export interface AmoCallNoteParams {
  uniq?: string;
  /** Длительность в секундах. */
  duration?: number;
  /** Источник (интеграция телефонии), напр. "mango". */
  source?: string;
  /** Ссылка на запись разговора. */
  link?: string;
  phone?: string;
  /** Код статуса — расшифровка в AMO_CALL_STATUS_TEXT. */
  call_status?: number;
  /** Текст результата звонка. */
  call_result?: string;
  /** id пользователя, ответственного за звонок (amo может слать строкой). */
  call_responsible?: number | string;
}

/** note_type = common — обычная текстовая заметка. */
export interface AmoCommonNoteParams {
  text?: string;
}

/** note_type = service_message — системное сообщение интеграции. */
export interface AmoServiceMessageNoteParams {
  service?: string;
  text?: string;
}

interface AmoNoteBase {
  id: number;
  entity_id: number;
  created_by?: number;
  updated_by?: number;
  responsible_user_id?: number;
  group_id?: number;
  created_at: number;
  updated_at: number;
  account_id?: number;
  is_pinned?: boolean;
}

export interface AmoCallNote extends AmoNoteBase {
  note_type: typeof AMO_NOTE_TYPES.CALL_IN | typeof AMO_NOTE_TYPES.CALL_OUT;
  params: AmoCallNoteParams;
}

export interface AmoCommonNote extends AmoNoteBase {
  note_type: typeof AMO_NOTE_TYPES.COMMON;
  params: AmoCommonNoteParams;
}

export interface AmoServiceMessageNote extends AmoNoteBase {
  note_type: typeof AMO_NOTE_TYPES.SERVICE_MESSAGE;
  params: AmoServiceMessageNoteParams;
}

/** Прочие типы (sms_in, attachment, geolocation, …) — params не типизируем. */
export interface AmoOtherNote extends AmoNoteBase {
  note_type: string;
  params?: Record<string, unknown>;
}

export type AmoNote =
  | AmoCallNote
  | AmoCommonNote
  | AmoServiceMessageNote
  | AmoOtherNote;

export type AmoNoteEntityType = "contacts" | "leads";

export interface AmoNotesListOptions {
  /** Фильтр по note_type (filter[note_type][]=…). Пусто — все типы. */
  noteTypes?: string[];
  /** Размер страницы, 1..250 (по умолчанию 250). */
  limit?: number;
  /**
   * Прочитать только одну конкретную страницу (без полной пагинации).
   * Если не задано — читаем все страницы до maxPages.
   */
  page?: number;
  /** Ограничитель пагинации (по умолчанию 40 страниц на пачку id). */
  maxPages?: number;
}

export function isCallNote(note: AmoNote | null | undefined): note is AmoCallNote {
  return (
    !!note &&
    (note.note_type === AMO_NOTE_TYPES.CALL_IN ||
      note.note_type === AMO_NOTE_TYPES.CALL_OUT)
  );
}

/** Нормализованный «последний звонок» для синка касаний. */
export interface AmoCallTouch {
  at: Date;
  direction: "IN" | "OUT";
  /** Код call_status из amo (1..7) или null, если не проставлен. */
  status: number | null;
  /** Расшифровка кода по AMO_CALL_STATUS_TEXT. */
  statusText: string | null;
  resultText: string | null;
  durationSec: number | null;
  /** Кто сделал/записал звонок: call_responsible → responsible_user_id → created_by. */
  userId: number | null;
  noteId: number;
  entityId: number;
  ref: `note:${number}`;
}

const toInt = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
};

const toUnix = (value: unknown): number | null => {
  const n = toInt(value);
  return n !== null && n > 0 ? n : null;
};

export function normalizeCallNote(note: AmoCallNote): AmoCallTouch | null {
  const createdAt = toUnix(note?.created_at);
  const noteId = toInt(note?.id);
  if (createdAt === null || noteId === null || noteId <= 0) return null;
  const params: AmoCallNoteParams = note.params || {};
  const status = toInt(params.call_status);
  const userId =
    toInt(params.call_responsible) ??
    toInt(note.responsible_user_id) ??
    toInt(note.created_by);
  const duration = toInt(params.duration);
  return {
    at: new Date(createdAt * 1000),
    direction: note.note_type === AMO_NOTE_TYPES.CALL_IN ? "IN" : "OUT",
    status,
    statusText:
      status !== null
        ? (AMO_CALL_STATUS_TEXT as Record<number, string>)[status] ?? null
        : null,
    resultText:
      typeof params.call_result === "string" && params.call_result.trim()
        ? params.call_result.trim()
        : null,
    durationSec: duration !== null && duration >= 0 ? duration : null,
    userId,
    noteId,
    entityId: toInt(note.entity_id) ?? 0,
    ref: `note:${noteId}`,
  };
}

/**
 * Самый свежий звонок (по created_at) среди примечаний. Не-звонки и записи
 * без даты игнорируются. При равном created_at берём больший id.
 */
export function pickLatestCallNote(
  notes: ReadonlyArray<AmoNote> | null | undefined,
): AmoCallTouch | null {
  if (!Array.isArray(notes)) return null;
  let best: AmoCallTouch | null = null;
  for (const note of notes) {
    if (!isCallNote(note)) continue;
    const touch = normalizeCallNote(note);
    if (!touch) continue;
    if (
      !best ||
      touch.at.getTime() > best.at.getTime() ||
      (touch.at.getTime() === best.at.getTime() && touch.noteId > best.noteId)
    ) {
      best = touch;
    }
  }
  return best;
}

// === Задачи (tasks) ===

export type AmoTaskEntityType = "leads" | "contacts";

export interface AmoTask {
  id: number;
  entity_id: number;
  entity_type: string;
  /** 1 — звонок, 2 — встреча (AMO_TASK_TYPES). */
  task_type_id: number;
  text?: string;
  is_completed: boolean;
  /** Срок (unix, сек). */
  complete_till: number;
  responsible_user_id: number;
  created_by?: number;
  updated_by?: number;
  result?: { text?: string } | null;
  updated_at: number;
  created_at: number;
}

export interface AmoTasksListOptions {
  /** filter[is_completed]=1|0. Не задано — все. */
  isCompleted?: boolean;
  /** Размер страницы, 1..250 (по умолчанию 250). */
  limit?: number;
  /** Ограничитель пагинации (по умолчанию 40 страниц на пачку id). */
  maxPages?: number;
  /** order[complete_till]=asc|desc (по умолчанию не задаём — как отдаёт amo). */
  order?: "asc" | "desc";
}

export function normalizeAmoTask(raw: any): AmoTask | null {
  const id = toInt(raw?.id);
  if (id === null || id <= 0) return null;
  return {
    id,
    entity_id: toInt(raw?.entity_id) ?? 0,
    entity_type: String(raw?.entity_type ?? ""),
    task_type_id: toInt(raw?.task_type_id) ?? 0,
    text: typeof raw?.text === "string" ? raw.text : undefined,
    is_completed: Boolean(raw?.is_completed),
    complete_till: toInt(raw?.complete_till) ?? 0,
    responsible_user_id: toInt(raw?.responsible_user_id) ?? 0,
    created_by: toInt(raw?.created_by) ?? undefined,
    updated_by: toInt(raw?.updated_by) ?? undefined,
    result:
      raw?.result && typeof raw.result === "object"
        ? { text: typeof raw.result.text === "string" ? raw.result.text : undefined }
        : null,
    updated_at: toInt(raw?.updated_at) ?? 0,
    created_at: toInt(raw?.created_at) ?? 0,
  };
}

/** Нормализованная «последняя выполненная задача». */
export interface AmoTaskTouch {
  /**
   * Момент выполнения. У amo нет отдельного completed_at — берём updated_at
   * (меняется при закрытии), а если его нет — complete_till.
   */
  at: Date;
  taskId: number;
  taskTypeId: number;
  entityId: number;
  userId: number | null;
  resultText: string | null;
  text: string | null;
  ref: `task:${number}`;
}

export function normalizeCompletedTask(task: AmoTask): AmoTaskTouch | null {
  if (!task || !task.is_completed) return null;
  const taskId = toInt(task.id);
  if (taskId === null || taskId <= 0) return null;
  const at = toUnix(task.updated_at) ?? toUnix(task.complete_till);
  if (at === null) return null;
  const resultText =
    typeof task.result?.text === "string" && task.result.text.trim()
      ? task.result.text.trim()
      : null;
  return {
    at: new Date(at * 1000),
    taskId,
    taskTypeId: toInt(task.task_type_id) ?? 0,
    entityId: toInt(task.entity_id) ?? 0,
    userId: toInt(task.responsible_user_id),
    resultText,
    text: typeof task.text === "string" && task.text.trim() ? task.text.trim() : null,
    ref: `task:${taskId}`,
  };
}

/**
 * Самая свежая ВЫПОЛНЕННАЯ задача (по updated_at, fallback complete_till).
 * Невыполненные игнорируются. При равном времени — больший id.
 */
export function pickLatestCompletedTask(
  tasks: ReadonlyArray<AmoTask> | null | undefined,
): AmoTaskTouch | null {
  if (!Array.isArray(tasks)) return null;
  let best: AmoTaskTouch | null = null;
  for (const task of tasks) {
    const touch = normalizeCompletedTask(task);
    if (!touch) continue;
    if (
      !best ||
      touch.at.getTime() > best.at.getTime() ||
      (touch.at.getTime() === best.at.getTime() && touch.taskId > best.taskId)
    ) {
      best = touch;
    }
  }
  return best;
}

// === Лиды ===

/**
 * Лид воронки КЦ с максимальным updated_at. По умолчанию воронка
 * AMO_PIPELINES.KC. Лиды без pipeline_id/updated_at не рассматриваются.
 * При равном updated_at — больший id.
 */
export function pickLatestKcLead<
  T extends { id?: unknown; pipeline_id?: unknown; updated_at?: unknown },
>(
  leads: ReadonlyArray<T> | null | undefined,
  kcPipelineId: number = AMO_PIPELINES.KC,
): T | null {
  if (!Array.isArray(leads)) return null;
  let best: T | null = null;
  let bestUpdated = -1;
  let bestId = -1;
  for (const lead of leads) {
    if (toInt(lead?.pipeline_id) !== kcPipelineId) continue;
    const updated = toUnix(lead?.updated_at);
    const id = toInt(lead?.id) ?? 0;
    if (updated === null) continue;
    if (updated > bestUpdated || (updated === bestUpdated && id > bestId)) {
      best = lead;
      bestUpdated = updated;
      bestId = id;
    }
  }
  return best;
}

// === Пользователи (сотрудники amo) ===

export interface AmoUserRights {
  is_active?: boolean;
  is_admin?: boolean;
  is_free?: boolean;
  group_id?: number | null;
  role_id?: number | null;
  [key: string]: unknown;
}

export interface AmoUser {
  id: number;
  name: string;
  email?: string;
  lang?: string;
  /** Телефон приходит только с ?with=phone_number; исторически код читает u.phone. */
  phone?: string;
  phone_number?: string;
  role_id?: number | null;
  rights?: AmoUserRights;
  /** Плоская копия rights.is_active — удобнее в синке. */
  is_active?: boolean;
  [key: string]: unknown;
}

export function normalizeAmoUser(raw: any): AmoUser | null {
  const id = toInt(raw?.id);
  if (id === null || id <= 0) return null;
  const rights =
    raw?.rights && typeof raw.rights === "object" ? raw.rights : undefined;
  const isActive =
    typeof rights?.is_active === "boolean"
      ? rights.is_active
      : typeof raw?.is_active === "boolean"
        ? raw.is_active
        : undefined;
  return {
    ...raw,
    id,
    name: String(raw?.name ?? ""),
    rights,
    is_active: isActive,
  };
}
