import type { LoyaltyReconciliationGroup } from "./loyalty-reconciliation-v2.dto";

export type ReconciliationBase = "anna" | "ours";
export type ReconciliationEntityType = "BROKER" | "AGENCY";

export interface ReconciliationParty {
  id: string;
  entityType: ReconciliationEntityType;
  displayName: string;
  city?: string | null;
  maskedContacts: Array<{ type: string; value: string }>;
  archived: boolean;
}

export interface ReconciliationGroupRow {
  key: string;
  base: ReconciliationBase;
  baseEntityKey: string;
  category: LoyaltyReconciliationGroup;
  caseId: string | null;
  expectedVersion: number | null;
  status: "OPEN" | "RESOLVED" | "DISMISSED";
  decision: string | null;
  matchCodes: string[];
  score: string | null;
  reasons: string[];
  anna: ReconciliationParty | null;
  ours: ReconciliationParty | null;
  linkSupplementEligible: boolean;
  searchable: string;
}

export interface ReconciliationUniverse {
  snapshotId: string | null;
  rowsByCategory: Map<LoyaltyReconciliationGroup, ReconciliationGroupRow[]>;
  entityKeys: Set<string>;
}
