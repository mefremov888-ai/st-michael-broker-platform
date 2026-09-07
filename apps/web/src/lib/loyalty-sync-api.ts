import { apiGet, apiPost } from "./api";

export type LoyaltySyncSource = "GOOGLE_SHEETS" | "AMOCRM";

export interface LoyaltySyncRun {
  id: string;
  source: LoyaltySyncSource;
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  ruleVersion: string;
  sourceRefHash: string;
  contentHash: string | null;
  counts: Record<string, unknown> | null;
  errorCode: string | null;
  requestedById: string;
  startedAt: string;
  completedAt: string | null;
}

export interface LoyaltyDryRunResult {
  runId: string;
  source: LoyaltySyncSource;
  status: "SUCCEEDED";
  ruleVersion: string;
  contentHash: string;
  counts: Record<string, unknown>;
  completedAt: string;
  published: false;
}

const BASE = "/loyalty-sync";

export const getLoyaltySyncRuns = (source?: LoyaltySyncSource, limit = 30) => {
  const query = new URLSearchParams({ limit: String(limit) });
  if (source) query.set("source", source);
  return apiGet<LoyaltySyncRun[]>(`${BASE}/runs?${query}`);
};

export const runGoogleLoyaltyDryRun = (spreadsheetId?: string) =>
  apiPost<LoyaltyDryRunResult>(`${BASE}/google/dry-run`, {
    ...(spreadsheetId ? { spreadsheetId } : {}),
  });

export const runAmoLoyaltyDryRun = (maxPages = 2000) =>
  apiPost<LoyaltyDryRunResult>(`${BASE}/amo/dry-run`, { maxPages });
