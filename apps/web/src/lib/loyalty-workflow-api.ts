import {
  api,
  apiDelete,
  apiGet,
  apiGetDownload,
  apiPatch,
  apiPost,
  apiUpload,
} from "./api";
import type {
  LoyaltyBaseKey,
  LoyaltyCallResult,
  LoyaltyCanonicalFilter,
  LoyaltyColumnFilters,
  LoyaltyEntityType,
  LoyaltySegment,
  LoyaltySortField,
} from "./loyalty-base-api";

const twoDigits = (value: number) => String(value).padStart(2, "0");

/** Format an absolute timestamp for a browser-local datetime-local control. */
export function toLocalDateTimeInput(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}T${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

/** Convert a datetime-local value back to the same absolute UTC contract. */
export function localDateTimeInputToIso(value: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function toLocalDateInput(value: string | Date = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
}

export interface LoyaltyOperator {
  id: string;
  name: string;
  role: string;
}

export interface LoyaltyCampaign {
  id: string;
  name: string;
  message: string;
  base: LoyaltyBaseKey;
  entityType: LoyaltyEntityType;
  status: "DRAFT" | "ACTIVE" | "COMPLETED" | "ARCHIVED";
  expectedCount: number;
  remainingCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  completedAt: string;
  archivedAt: string;
}

export type LoyaltyCampaignSelection =
  | { mode: "IDS"; ids: string[] }
  | {
      mode: "FILTER";
      filterHash: string;
      expectedCount: number;
      excludedIds?: string[];
    };

export interface LoyaltyCampaignAssignment {
  id: string;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  version: number;
  targetId: string;
  assignedTo: LoyaltyOperator | null;
  assignedAt: string;
  completedAt: string;
  cancelledAt: string;
  lastResult: string;
  lastAttemptAt: string;
}

export interface LoyaltyCampaignDetail extends LoyaltyCampaign {
  filterHash: string;
  selection: LoyaltyCampaignSelection | null;
  createdBy: LoyaltyOperator | null;
  assignments: LoyaltyCampaignAssignment[];
  assignmentCounts: Record<LoyaltyCampaignAssignment["status"], number>;
  assignmentPage: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface LoyaltyQueueItem {
  id: string;
  version: number;
  targetId: string;
  targetName: string;
  entityType: LoyaltyEntityType;
  phone: string;
  company: string;
  context: string;
  campaign: { id: string; name: string; message: string };
  assignedTo: LoyaltyOperator | null;
  assignedAt: string;
}

export interface LoyaltyQueuePage {
  items: LoyaltyQueueItem[];
  total: number;
  remaining: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface LoyaltyCallSubmissionResult {
  remaining: number;
  campaignRemaining: number;
}

export interface LoyaltyTask {
  id: string;
  version: number;
  title: string;
  description: string;
  dueAt: string;
  status: "OPEN" | "COMPLETED" | "CANCELLED";
  assignedTo: LoyaltyOperator | null;
  createdAt: string;
}

export interface LoyaltyEngagementEvent {
  id: string;
  version: number;
  type:
    | "GIFT"
    | "AWARD"
    | "PRIVATE_EVENT"
    | "INDIVIDUAL_TERMS"
    | "PERSONAL_DISCOUNT"
    | "PERSONAL_COMMISSION";
  occurredAt: string;
  employee: string;
  comment: string;
  amount: string | null;
  value: string;
  validUntil: string;
  attachmentUrl: string;
  basisUrl: string;
  correctionReason: string;
  archivedAt: string;
  current: boolean;
  effective: boolean;
  superseded: boolean;
  attachments: LoyaltyEventAttachment[];
}

export interface LoyaltyEventAttachment {
  id: string;
  eventId: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  version: number;
  createdAt: string;
  downloadUrl: string;
}

export const LOYALTY_PERMISSIONS = [
  "READ_ALL",
  "READ_OWN_QUEUE",
  "CALL_EXECUTE",
  "CALL_ASSIGN",
  "ENTITY_EDIT",
  "REFERENCE_MANAGE",
  "EXPORT",
  "IMPORT",
  "RECONCILE",
  "AUDIT_READ",
  "ANALYTICS_SYNC",
] as const;

export type LoyaltyPermission = (typeof LOYALTY_PERMISSIONS)[number];

export interface LoyaltyEffectivePermissions {
  role: string;
  permissions: LoyaltyPermission[];
  defaults: {
    ownQueue: boolean;
    ownAttempts: boolean;
    ownTasks: boolean;
  };
}

export interface LoyaltyGrant {
  id: string;
  userId: string;
  permission: LoyaltyPermission;
  grantedAt: string;
  revokedAt: string;
  user: LoyaltyOperator | null;
  grantedBy: LoyaltyOperator | null;
}

export async function getLoyaltyEffectivePermissions(): Promise<LoyaltyEffectivePermissions> {
  const raw = object(
    await apiGet<unknown>("/loyalty-workflow/permissions/effective"),
  );
  const permissions = Array.isArray(raw.permissions)
    ? raw.permissions
        .map(text)
        .filter((value): value is LoyaltyPermission =>
          LOYALTY_PERMISSIONS.includes(value as LoyaltyPermission),
        )
    : [];
  const defaults = object(raw.defaults);
  return {
    role: text(raw.role),
    permissions,
    defaults: {
      ownQueue: defaults.ownQueue === true,
      ownAttempts: defaults.ownAttempts === true,
      ownTasks: defaults.ownTasks === true,
    },
  };
}

export type LoyaltyManualContactType =
  | "PHONE"
  | "EMAIL"
  | "TELEGRAM"
  | "WHATSAPP"
  | "OTHER";

export function agencyContactPointsPatch<T>({
  isNew,
  initialPhones,
  initialEmails,
  phones,
  emails,
  contactPoints,
}: {
  isNew: boolean;
  initialPhones: string;
  initialEmails: string;
  phones: string;
  emails: string;
  contactPoints: T[];
}): { contactPoints?: T[] } {
  return isNew || phones !== initialPhones || emails !== initialEmails
    ? { contactPoints }
    : {};
}

export function agencyContactPersonRoleValue({
  isNew,
  role,
}: {
  isNew: boolean;
  role: string;
}): string | undefined {
  const normalized = role.trim();
  return isNew ? normalized || undefined : normalized;
}

export interface LoyaltyManualContactPoint {
  id: string;
  entityType: "BROKER" | "AGENCY";
  type: LoyaltyManualContactType;
  value: string;
  maskedValue: string;
  label: string;
  isPrimary: boolean;
  version: number;
  archivedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface LoyaltyAgencyContactPerson {
  id: string;
  organizationId: string;
  displayName: string;
  role: string;
  actualityStatus: "CURRENT" | "FORMER" | "UNKNOWN";
  contactPoints: Array<{
    id: string;
    type: LoyaltyManualContactType;
    value: string;
    maskedValue: string;
    label: string;
    isPrimary: boolean;
  }>;
  version: number;
  archivedAt: string;
  createdAt: string;
  updatedAt: string;
}

type JsonRecord = Record<string, unknown>;
const object = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
const integer = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const items = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  const root = object(value);
  if (Array.isArray(root.items)) return root.items;
  if (Array.isArray(root.data)) return root.data;
  return [];
};

const engagementEvent = (value: unknown): LoyaltyEngagementEvent => {
  const raw = object(value);
  return {
    id: text(raw.id),
    version: integer(raw.version) || 1,
    type: (text(raw.type) || "GIFT") as LoyaltyEngagementEvent["type"],
    occurredAt: text(raw.occurredAt || raw.date),
    employee: text(raw.employee || raw.createdByName),
    comment: text(raw.comment),
    amount:
      raw.amount === null || raw.amount === undefined ? null : text(raw.amount),
    value: text(raw.value),
    validUntil: text(raw.validUntil),
    attachmentUrl: text(raw.attachmentUrl),
    basisUrl: text(raw.basisUrl),
    correctionReason: text(raw.correctionReason),
    archivedAt: text(raw.archivedAt),
    current: raw.current !== false && raw.superseded !== true,
    effective: raw.effective !== false && raw.superseded !== true,
    superseded: raw.superseded === true,
    attachments: items(raw.attachments).map((attachment) => {
      const item = object(attachment);
      return {
        id: text(item.id),
        eventId: text(item.eventId || raw.id),
        fileName: text(item.fileName),
        mimeType: text(item.mimeType),
        size: integer(item.size),
        sha256: text(item.sha256),
        version: integer(item.version) || 1,
        createdAt: text(item.createdAt),
        downloadUrl: text(item.downloadUrl),
      };
    }),
  };
};

const operator = (value: unknown): LoyaltyOperator => {
  const raw = object(value);
  return {
    id: text(raw.id),
    name: text(raw.name || raw.fullName || raw.displayName) || "Без имени",
    role: text(raw.role),
  };
};

export async function getLoyaltyOperators() {
  return items(await apiGet<unknown>("/loyalty-workflow/operators"))
    .map(operator)
    .filter((item) => item.id);
}

export async function getLoyaltyCampaigns(filters?: {
  base?: LoyaltyBaseKey;
  entityType?: LoyaltyEntityType;
  status?: LoyaltyCampaign["status"];
  page?: number;
  limit?: number;
}) {
  const params = new URLSearchParams();
  if (filters?.base) params.set("base", filters.base);
  if (filters?.entityType) params.set("entityType", filters.entityType);
  if (filters?.status) params.set("status", filters.status);
  params.set("page", String(filters?.page || 1));
  params.set("limit", String(filters?.limit || 200));
  const query = params.size ? `?${params.toString()}` : "";
  return items(await apiGet<unknown>(`/loyalty-workflow/campaigns${query}`))
    .map(campaign)
    .filter((item) => item.id);
}

const campaign = (value: unknown): LoyaltyCampaign => {
  const raw = object(value);
  return {
    id: text(raw.id),
    name: text(raw.name),
    message: text(raw.message),
    base: text(raw.base).toLowerCase() === "ours" ? "ours" : "anna",
    entityType: ["AGENCY", "agencies"].includes(text(raw.entityType))
      ? "agencies"
      : "brokers",
    status: (text(raw.status) || "DRAFT") as LoyaltyCampaign["status"],
    expectedCount: integer(raw.expectedCount),
    remainingCount: integer(raw.remainingCount),
    version: integer(raw.version) || 1,
    createdAt: text(raw.createdAt),
    updatedAt: text(raw.updatedAt),
    startedAt: text(raw.startedAt),
    completedAt: text(raw.completedAt),
    archivedAt: text(raw.archivedAt),
  };
};

const campaignSelection = (value: unknown): LoyaltyCampaignSelection | null => {
  const raw = object(value);
  if (raw.mode === "IDS") {
    const ids = items(raw.ids).map(text).filter(Boolean);
    return ids.length ? { mode: "IDS", ids } : null;
  }
  if (raw.mode === "FILTER") {
    const filterHash = text(raw.filterHash);
    if (!filterHash) return null;
    const excludedIds = items(raw.excludedIds).map(text).filter(Boolean);
    return {
      mode: "FILTER",
      filterHash,
      expectedCount: integer(raw.expectedCount),
      ...(excludedIds.length ? { excludedIds } : {}),
    };
  }
  return null;
};

export async function getLoyaltyCampaign(
  campaignId: string,
  pagination: { page?: number; pageSize?: number } = {},
): Promise<LoyaltyCampaignDetail> {
  const params = new URLSearchParams({
    page: String(pagination.page || 1),
    limit: String(pagination.pageSize || 200),
  });
  const raw = object(
    await apiGet<unknown>(
      `/loyalty-workflow/campaigns/${encodeURIComponent(campaignId)}?${params.toString()}`,
    ),
  );
  const value = campaign(raw);
  if (!value.id) throw new Error("API не вернул кампанию");
  const counts = object(raw.assignmentCounts);
  const assignmentPage = object(raw.assignmentPage);
  return {
    ...value,
    filterHash: text(raw.filterHash),
    selection: campaignSelection(raw.selection),
    createdBy: Object.keys(object(raw.createdBy)).length
      ? operator(raw.createdBy)
      : null,
    assignments: items(raw.assignments).map((value) => {
      const assignment = object(value);
      const assignedTo = object(assignment.assignedTo);
      return {
        id: text(assignment.id),
        status: (text(assignment.status) ||
          "PENDING") as LoyaltyCampaignAssignment["status"],
        version: integer(assignment.version) || 1,
        targetId: text(assignment.targetId),
        assignedTo: Object.keys(assignedTo).length
          ? operator(assignedTo)
          : null,
        assignedAt: text(assignment.assignedAt),
        completedAt: text(assignment.completedAt),
        cancelledAt: text(assignment.cancelledAt),
        lastResult: text(assignment.lastResult),
        lastAttemptAt: text(assignment.lastAttemptAt),
      };
    }),
    assignmentCounts: {
      PENDING: integer(counts.PENDING),
      IN_PROGRESS: integer(counts.IN_PROGRESS),
      COMPLETED: integer(counts.COMPLETED),
      CANCELLED: integer(counts.CANCELLED),
    },
    assignmentPage: {
      page: integer(assignmentPage.page) || 1,
      pageSize: integer(assignmentPage.pageSize) || 200,
      total: integer(assignmentPage.total),
      totalPages: integer(assignmentPage.totalPages) || 1,
    },
  };
}

export async function exportLoyaltyCampaign(campaignId: string) {
  return apiGetDownload(
    `/loyalty-workflow/campaigns/${encodeURIComponent(campaignId)}/export`,
  );
}

export async function createLoyaltyCampaign(body: {
  name: string;
  message: string;
  base: LoyaltyBaseKey;
  entityType: LoyaltyEntityType;
  filterSnapshot?: {
    search: string;
    city?: string;
    hasAmo?: boolean;
    archived: "exclude" | "include" | "only";
    sortBy?: LoyaltySortField;
    sortOrder?: "asc" | "desc";
    filter: LoyaltyCanonicalFilter;
    columns?: LoyaltyColumnFilters;
    segment?: LoyaltySegment;
  };
  filterHash?: string;
  snapshotId: string | null;
  selection:
    | { mode: "IDS"; ids: string[] }
    | {
        mode: "FILTER";
        filterHash: string;
        expectedCount: number;
        excludedIds?: string[];
      };
}) {
  const response = object(
    await apiPost<unknown>("/loyalty-workflow/campaigns", body),
  );
  const nested = object(response.data);
  const id = text(response.id || nested.id);
  if (!id) throw new Error("API не вернул идентификатор кампании");
  return { id, version: integer(response.version ?? nested.version) || 1 };
}

export async function activateLoyaltyCampaign(
  campaignId: string,
  expectedVersion: number,
) {
  return apiPost<unknown>(
    `/loyalty-workflow/campaigns/${encodeURIComponent(campaignId)}/activate`,
    { expectedVersion },
  );
}

export async function archiveLoyaltyCampaign(
  campaignId: string,
  expectedVersion: number,
) {
  return apiPost<unknown>(
    `/loyalty-workflow/campaigns/${encodeURIComponent(campaignId)}/archive`,
    { expectedVersion },
  );
}

export async function previewLoyaltyCampaignAssignments(
  campaignId: string,
  body: {
    assigneeId: string;
    selection:
      | { mode: "IDS"; ids: string[] }
      | {
          mode: "FILTER";
          filterHash: string;
          expectedCount: number;
          excludedIds?: string[];
        };
  },
) {
  return apiPost<unknown>(
    `/loyalty-workflow/campaigns/${encodeURIComponent(campaignId)}/assignments/preview`,
    body,
  );
}

export async function assignLoyaltyCampaign(
  campaignId: string,
  body: {
    assigneeId: string;
    selection:
      | { mode: "IDS"; ids: string[] }
      | {
          mode: "FILTER";
          filterHash: string;
          expectedCount: number;
          excludedIds?: string[];
        };
  },
) {
  const response = object(
    await apiPost<unknown>(
      `/loyalty-workflow/campaigns/${encodeURIComponent(campaignId)}/assignments`,
      body,
    ),
  );
  return integer(response.campaignVersion ?? response.version) || undefined;
}

export async function getMyLoyaltyQueue(filters?: {
  assigneeId?: string;
  campaignId?: string;
  page?: number;
  pageSize?: number;
}): Promise<LoyaltyQueuePage> {
  const params = new URLSearchParams();
  if (filters?.assigneeId) params.set("assigneeId", filters.assigneeId);
  if (filters?.campaignId) params.set("campaignId", filters.campaignId);
  if (filters?.page) params.set("page", String(filters.page));
  if (filters?.pageSize) params.set("limit", String(filters.pageSize));
  const query = params.size ? `?${params.toString()}` : "";
  const response = await apiGet<unknown>(`/loyalty-workflow/queue${query}`);
  const root = object(response);
  const queueItems = items(response)
    .map((value): LoyaltyQueueItem => {
      const raw = object(value);
      const campaign = object(raw.campaign);
      const assignedTo = object(raw.assignedTo);
      return {
        id: text(raw.id),
        version: integer(raw.version),
        targetId: text(raw.targetId || raw.ownerId),
        targetName: text(raw.targetName || raw.name) || "Без названия",
        entityType: ["AGENCY", "agencies"].includes(text(raw.entityType))
          ? "agencies"
          : "brokers",
        phone: text(raw.phone),
        company: text(raw.company),
        context: text(raw.context),
        campaign: {
          id: text(campaign.id || raw.campaignId),
          name: text(campaign.name || raw.campaignName),
          message: text(campaign.message || raw.campaignMessage),
        },
        assignedTo: Object.keys(assignedTo).length
          ? operator(assignedTo)
          : null,
        assignedAt: text(raw.assignedAt),
      };
    })
    .filter((item) => item.id);
  return {
    items: queueItems,
    total: integer(root.total ?? queueItems.length),
    remaining: integer(root.remaining ?? root.total ?? queueItems.length),
    page: integer(root.page) || filters?.page || 1,
    pageSize: integer(root.pageSize) || filters?.pageSize || 100,
    totalPages:
      integer(root.totalPages) ||
      Math.ceil(
        integer(root.total ?? queueItems.length) /
          (integer(root.pageSize) || filters?.pageSize || 100),
      ),
  };
}

export async function submitLoyaltyCall(body: {
  assignmentId: string;
  expectedVersion: number;
  submissionId: string;
  result: LoyaltyCallResult;
  comment: string;
  nextStep?: string;
  nextActionAt?: string;
}): Promise<LoyaltyCallSubmissionResult> {
  const response = object(
    await apiPost<unknown>(
      `/loyalty-workflow/assignments/${encodeURIComponent(body.assignmentId)}/attempts`,
      body,
    ),
  );
  return {
    remaining: integer(response.remaining),
    campaignRemaining: integer(response.campaignRemaining),
  };
}

export async function correctLoyaltyCall(
  assignmentId: string,
  attemptId: string,
  body: {
    submissionId: string;
    correctionReason: string;
    result: LoyaltyCallResult;
    comment: string;
    nextStep?: string;
    nextActionAt?: string;
  },
) {
  return apiPost<unknown>(
    `/loyalty-workflow/assignments/${encodeURIComponent(assignmentId)}/attempts/${encodeURIComponent(attemptId)}/corrections`,
    body,
  );
}

export async function getLoyaltyTasks(owner: {
  base: LoyaltyBaseKey;
  entityType: LoyaltyEntityType;
  ownerId: string;
}) {
  const params = new URLSearchParams(owner);
  return items(
    await apiGet<unknown>(`/loyalty-workflow/tasks?${params.toString()}`),
  ).map((value): LoyaltyTask => {
    const raw = object(value);
    const assignedTo = object(raw.assignedTo);
    return {
      id: text(raw.id),
      version: integer(raw.version),
      title: text(raw.title),
      description: text(raw.description),
      dueAt: text(raw.dueAt),
      status: (text(raw.status) || "OPEN") as LoyaltyTask["status"],
      assignedTo: Object.keys(assignedTo).length ? operator(assignedTo) : null,
      createdAt: text(raw.createdAt),
    };
  });
}

export async function createLoyaltyTask(body: {
  base: LoyaltyBaseKey;
  entityType: LoyaltyEntityType;
  ownerId: string;
  title: string;
  description?: string;
  assignedToId?: string;
  dueAt?: string;
}) {
  return apiPost<unknown>("/loyalty-workflow/tasks", body);
}

export async function updateLoyaltyTask(
  id: string,
  body: {
    expectedVersion: number;
    status?: LoyaltyTask["status"];
    title?: string;
    description?: string | null;
    assignedToId?: string;
    dueAt?: string | null;
  },
) {
  return apiPatch<unknown>(
    `/loyalty-workflow/tasks/${encodeURIComponent(id)}`,
    body,
  );
}

export async function getLoyaltyEvents(owner: {
  base: LoyaltyBaseKey;
  entityType: LoyaltyEntityType;
  ownerId: string;
  includeArchived?: boolean;
}) {
  const params = new URLSearchParams({
    base: owner.base,
    entityType: owner.entityType,
    ownerId: owner.ownerId,
    ...(owner.includeArchived ? { includeArchived: "true" } : {}),
  });
  return items(
    await apiGet<unknown>(`/loyalty-workflow/events?${params.toString()}`),
  ).map(engagementEvent);
}

export async function createLoyaltyEvent(body: {
  base: LoyaltyBaseKey;
  entityType: LoyaltyEntityType;
  ownerId: string;
  type: LoyaltyEngagementEvent["type"];
  occurredAt: string;
  comment: string;
  amount?: string;
  value?: string;
  validUntil?: string;
  attachmentUrl?: string;
  basisUrl?: string;
}) {
  return engagementEvent(
    await apiPost<unknown>("/loyalty-workflow/events", body),
  );
}

export async function archiveLoyaltyEvent(id: string, expectedVersion: number) {
  return apiPost<unknown>(
    `/loyalty-workflow/events/${encodeURIComponent(id)}/archive`,
    { expectedVersion },
  );
}

export async function restoreLoyaltyEvent(id: string, expectedVersion: number) {
  return apiPost<unknown>(
    `/loyalty-workflow/events/${encodeURIComponent(id)}/restore`,
    { expectedVersion },
  );
}

export async function uploadLoyaltyEventAttachment(
  eventId: string,
  file: File,
) {
  const form = new FormData();
  form.set("file", file);
  return apiUpload<LoyaltyEventAttachment>(
    `/loyalty-attachments/events/${encodeURIComponent(eventId)}`,
    form,
  );
}

export async function downloadLoyaltyEventAttachment(id: string) {
  return apiGetDownload(`/loyalty-attachments/${encodeURIComponent(id)}`);
}

export async function archiveLoyaltyEventAttachment(
  id: string,
  expectedVersion: number,
) {
  return api<unknown>(`/loyalty-attachments/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: JSON.stringify({ expectedVersion }),
  });
}

export async function correctLoyaltyEvent(
  id: string,
  body: {
    type: LoyaltyEngagementEvent["type"];
    occurredAt: string;
    comment?: string;
    amount?: string;
    value?: string;
    validUntil?: string;
    attachmentUrl?: string;
    basisUrl?: string;
    correctionReason: string;
  },
) {
  return engagementEvent(
    await apiPost<unknown>(
      `/loyalty-workflow/events/${encodeURIComponent(id)}/corrections`,
      body,
    ),
  );
}

export async function getLoyaltyGrants(includeRevoked = false) {
  return items(
    await apiGet<unknown>(
      `/loyalty-workflow/grants?includeRevoked=${String(includeRevoked)}`,
    ),
  ).map((value): LoyaltyGrant => {
    const raw = object(value);
    const user = object(raw.user);
    const grantedBy = object(raw.grantedBy);
    return {
      id: text(raw.id),
      userId: text(raw.userId),
      permission: text(raw.permission) as LoyaltyPermission,
      grantedAt: text(raw.grantedAt),
      revokedAt: text(raw.revokedAt),
      user: Object.keys(user).length ? operator(user) : null,
      grantedBy: Object.keys(grantedBy).length ? operator(grantedBy) : null,
    };
  });
}

export async function getLoyaltyGrantTargets() {
  return items(await apiGet<unknown>("/loyalty-workflow/grant-targets"))
    .map(operator)
    .filter((item) => item.id && item.role === "MANAGER");
}

export const createLoyaltyGrant = (
  userId: string,
  permission: LoyaltyPermission,
) => apiPost<unknown>("/loyalty-workflow/grants", { userId, permission });

export const revokeLoyaltyGrant = (id: string) =>
  apiDelete<unknown>(`/loyalty-workflow/grants/${encodeURIComponent(id)}`);

export const replaceLoyaltyGrantProfile = (
  userId: string,
  permissions: readonly LoyaltyPermission[],
) =>
  apiPost<unknown>("/loyalty-workflow/grants/profile", {
    userId,
    permissions: [...permissions],
  });

export interface LoyaltySavedView {
  id: string;
  name: string;
  base: LoyaltyBaseKey;
  entityType: LoyaltyEntityType;
  filterHash: string;
  filterSnapshot: Record<string, unknown>;
  isShared: boolean;
  owner: LoyaltyOperator | null;
  createdAt: string;
  updatedAt: string;
}

export async function getLoyaltySavedViews(filters?: {
  base?: LoyaltyBaseKey;
  entityType?: LoyaltyEntityType;
}): Promise<LoyaltySavedView[]> {
  const params = new URLSearchParams();
  if (filters?.base) params.set("base", filters.base);
  if (filters?.entityType) params.set("entityType", filters.entityType);
  const query = params.size ? `?${params.toString()}` : "";
  return items(
    await apiGet<unknown>(`/loyalty-workflow/saved-views${query}`),
  ).map((value) => {
    const raw = object(value);
    const ownerRaw = object(raw.owner);
    return {
      id: text(raw.id),
      name: text(raw.name),
      base: text(raw.base).toLowerCase() === "ours" ? "ours" : "anna",
      entityType: ["AGENCY", "agencies"].includes(text(raw.entityType))
        ? "agencies"
        : "brokers",
      filterHash: text(raw.filterHash),
      filterSnapshot: object(raw.filters),
      isShared: raw.isShared === true,
      owner: Object.keys(ownerRaw).length ? operator(ownerRaw) : null,
      createdAt: text(raw.createdAt),
      updatedAt: text(raw.updatedAt),
    };
  });
}

export async function createLoyaltySavedView(body: {
  name: string;
  base: LoyaltyBaseKey;
  entityType: LoyaltyEntityType;
  filters: Record<string, unknown>;
  shared?: boolean;
}) {
  const { shared, ...request } = body;
  return apiPost<unknown>("/loyalty-workflow/saved-views", {
    ...request,
    isShared: shared,
  });
}

export async function updateLoyaltySavedView(
  id: string,
  body: {
    name?: string;
    filters?: Record<string, unknown>;
    shared?: boolean;
  },
) {
  const { shared, ...request } = body;
  return apiPatch<unknown>(
    `/loyalty-workflow/saved-views/${encodeURIComponent(id)}`,
    { ...request, ...(shared === undefined ? {} : { isShared: shared }) },
  );
}

export const deleteLoyaltySavedView = (id: string) =>
  apiDelete<unknown>(`/loyalty-workflow/saved-views/${encodeURIComponent(id)}`);

export async function addLoyaltyContact(body: {
  base: LoyaltyBaseKey;
  entityType: LoyaltyEntityType;
  name: string;
  phone?: string;
  email?: string;
  city?: string;
}) {
  return apiPost<unknown>("/loyalty-workflow/contacts", body);
}

const manualEntity = (entityType: LoyaltyEntityType) =>
  entityType === "brokers" ? "BROKER" : "AGENCY";

const manualPoint = (value: unknown): LoyaltyManualContactPoint => {
  const raw = object(value);
  return {
    id: text(raw.id),
    entityType: (text(raw.entityType) || "BROKER") as "BROKER" | "AGENCY",
    type: (text(raw.type) || "OTHER") as LoyaltyManualContactType,
    value: text(raw.value),
    maskedValue: text(raw.maskedValue),
    label: text(raw.label),
    isPrimary: raw.isPrimary === true,
    version: integer(raw.version),
    archivedAt: text(raw.archivedAt),
    createdAt: text(raw.createdAt),
    updatedAt: text(raw.updatedAt),
  };
};

export async function getLoyaltyManualContactPoints(
  entityType: LoyaltyEntityType,
  entityId: string,
  includeArchived = true,
) {
  const value = object(
    await apiGet<unknown>(
      `/loyalty-workflow/contacts/${manualEntity(entityType)}/${encodeURIComponent(entityId)}/points?includeArchived=${String(includeArchived)}`,
    ),
  );
  return items(value.items).map(manualPoint);
}

export const createLoyaltyManualContactPoint = (
  entityType: LoyaltyEntityType,
  entityId: string,
  body: {
    type: LoyaltyManualContactType;
    value: string;
    label?: string;
    isPrimary?: boolean;
  },
) =>
  apiPost<unknown>(
    `/loyalty-workflow/contacts/${manualEntity(entityType)}/${encodeURIComponent(entityId)}/points`,
    body,
  );

export const updateLoyaltyManualContactPoint = (
  entityType: LoyaltyEntityType,
  entityId: string,
  pointId: string,
  body: {
    expectedVersion: number;
    value?: string;
    label?: string;
    isPrimary?: boolean;
    archived?: boolean;
  },
) =>
  apiPatch<unknown>(
    `/loyalty-workflow/contacts/${manualEntity(entityType)}/${encodeURIComponent(entityId)}/points/${encodeURIComponent(pointId)}`,
    body,
  );

const agencyContactPerson = (value: unknown): LoyaltyAgencyContactPerson => {
  const raw = object(value);
  return {
    id: text(raw.id),
    organizationId: text(raw.organizationId),
    displayName: text(raw.displayName),
    role: text(raw.role),
    actualityStatus: (text(raw.actualityStatus) || "UNKNOWN") as
      | "CURRENT"
      | "FORMER"
      | "UNKNOWN",
    contactPoints: items(raw.contactPoints).map((entry) => {
      const point = object(entry);
      return {
        id: text(point.id),
        type: (text(point.type) || "OTHER") as LoyaltyManualContactType,
        value: text(point.value),
        maskedValue: text(point.maskedValue),
        label: text(point.label),
        isPrimary: point.isPrimary === true,
      };
    }),
    version: integer(raw.version),
    archivedAt: text(raw.archivedAt),
    createdAt: text(raw.createdAt),
    updatedAt: text(raw.updatedAt),
  };
};

export async function getLoyaltyAgencyContactPeople(
  agencyId: string,
  includeArchived = true,
) {
  const response = object(
    await apiGet<unknown>(
      `/loyalty-workflow/contacts/AGENCY/${encodeURIComponent(agencyId)}/people?includeArchived=${String(includeArchived)}`,
    ),
  );
  return items(response.items).map(agencyContactPerson);
}

export async function createLoyaltyAgencyContactPerson(
  agencyId: string,
  body: {
    displayName: string;
    role?: string;
    actualityStatus?: "CURRENT" | "FORMER" | "UNKNOWN";
    contactPoints?: Array<{
      id?: string;
      type: LoyaltyManualContactType;
      value: string;
      label?: string;
      isPrimary?: boolean;
    }>;
  },
) {
  return agencyContactPerson(
    await apiPost<unknown>(
      `/loyalty-workflow/contacts/AGENCY/${encodeURIComponent(agencyId)}/people`,
      body,
    ),
  );
}

export async function updateLoyaltyAgencyContactPerson(
  agencyId: string,
  contactPersonId: string,
  body: {
    expectedVersion: number;
    displayName?: string;
    role?: string;
    actualityStatus?: "CURRENT" | "FORMER" | "UNKNOWN";
    contactPoints?: Array<{
      id?: string;
      type: LoyaltyManualContactType;
      value: string;
      label?: string;
      isPrimary?: boolean;
    }>;
    archived?: boolean;
  },
) {
  return agencyContactPerson(
    await apiPatch<unknown>(
      `/loyalty-workflow/contacts/AGENCY/${encodeURIComponent(agencyId)}/people/${encodeURIComponent(contactPersonId)}`,
      body,
    ),
  );
}
