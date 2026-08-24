import { apiDownload, apiGet, apiPost } from "./api";

export const LOYALTY_RECONCILIATION_GROUPS = [
  "PHONE_MATCHED",
  "ANNA_ONLY",
  "CABINET_ONLY",
  "PHONE_TO_MULTIPLE_CARDS",
  "INVALID_PHONE",
  "NAME_OR_AGENCY_CONFLICT",
  "EXCLUDED_OR_STALE",
] as const;

export type LoyaltyReconciliationGroup =
  (typeof LOYALTY_RECONCILIATION_GROUPS)[number];
export type LoyaltyReconciliationBase = "anna" | "ours";
export type LoyaltyReconciliationEntityType = "BROKER" | "AGENCY";
export type LoyaltyReconciliationStatus = "OPEN" | "RESOLVED" | "DISMISSED";
export type LoyaltyReconciliationAction =
  | "LINK"
  | "KEEP_SEPARATE"
  | "SUPPLEMENT"
  | "ARCHIVE"
  | "UNLINK";

export interface LoyaltyReconciliationDefinition {
  label: string;
  calculation: string;
  paired: boolean;
}

export interface LoyaltyReconciliationDefinitionItem extends LoyaltyReconciliationDefinition {
  code: LoyaltyReconciliationGroup;
}

export interface LoyaltyReconciliationParty {
  id: string;
  entityType: LoyaltyReconciliationEntityType;
  displayName: string;
  city?: string | null;
  maskedContacts: Array<{ type: string; value: string }>;
  archived: boolean;
}

export interface LoyaltyReconciliationRow {
  key: string;
  base: LoyaltyReconciliationBase;
  category: LoyaltyReconciliationGroup;
  caseId: string | null;
  expectedVersion: number | null;
  status: LoyaltyReconciliationStatus;
  decision: string | null;
  matchCodes: string[];
  score: string | null;
  reasons: string[];
  anna: LoyaltyReconciliationParty | null;
  ours: LoyaltyReconciliationParty | null;
  actionable: boolean;
  allowedActions: LoyaltyReconciliationAction[];
}

export interface LoyaltyReconciliationCoverage {
  snapshotId: string | null;
  base: LoyaltyReconciliationBase;
  entityType: LoyaltyReconciliationEntityType | null;
  total: number;
  classified: number;
  unclassified: number;
  overlapEntities: number;
  coveragePercent: number;
  groups: Array<{
    category: LoyaltyReconciliationGroup;
    count: number;
    definition: LoyaltyReconciliationDefinition;
  }>;
  note: string;
}

export interface LoyaltyReconciliationSearchRequest {
  base: LoyaltyReconciliationBase;
  entityType?: LoyaltyReconciliationEntityType;
  category: LoyaltyReconciliationGroup;
  status?: LoyaltyReconciliationStatus;
  search?: string;
  page: number;
  pageSize: number;
}

export interface LoyaltyReconciliationSearchResponse {
  snapshotId: string | null;
  base: LoyaltyReconciliationBase;
  category: LoyaltyReconciliationGroup;
  definition: LoyaltyReconciliationDefinition;
  items: LoyaltyReconciliationRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface LoyaltyReconciliationDecisionRequest {
  caseId: string;
  action: LoyaltyReconciliationAction;
  expectedVersion: number;
  reason: string;
  fieldResolutions?: Record<string, unknown>;
  targetId?: string;
}

const BASE = "/loyalty-reconciliation-v2";

export const getLoyaltyReconciliationDefinitions = () =>
  apiGet<LoyaltyReconciliationDefinitionItem[]>(`${BASE}/definitions`);

export const getLoyaltyReconciliationCoverage = (
  base: LoyaltyReconciliationBase,
  entityType?: LoyaltyReconciliationEntityType,
) => {
  const query = new URLSearchParams({ base });
  if (entityType) query.set("entityType", entityType);
  return apiGet<LoyaltyReconciliationCoverage>(`${BASE}/coverage?${query}`);
};

export const searchLoyaltyReconciliationGroup = (
  body: LoyaltyReconciliationSearchRequest,
) =>
  apiPost<LoyaltyReconciliationSearchResponse>(`${BASE}/groups/search`, body);

export const exportLoyaltyReconciliationGroup = (
  body: LoyaltyReconciliationSearchRequest & { maxRows?: number },
) => apiDownload(`${BASE}/groups/export`, body);

export const decideLoyaltyReconciliation = (
  body: LoyaltyReconciliationDecisionRequest,
) => apiPost(`${BASE}/decisions`, body);
