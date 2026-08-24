import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { Prisma, PrismaClient } from "@st-michael/database";
import { AmoCrmAdapter } from "@st-michael/integrations";
import { createHash } from "crypto";
import { google } from "googleapis";
import type { CurrentUserPayload } from "../auth/current-user.decorator";
import { LoyaltyPermissionService } from "../loyalty-workflow/loyalty-permission.service";
import {
  AmoLoyaltyDryRunDto,
  GoogleLoyaltyDryRunDto,
  LoyaltySyncRunsQueryDto,
} from "./loyalty-sync.dto";

const GOOGLE_RULE_VERSION = "loyalty-google-v1";
const AMO_RULE_VERSION = "loyalty-amo-coverage-v1";
const DEFAULT_SPREADSHEET_ID = "1HYiRxnRb0psYzKZmD7f34gdMgNR6gso8Swj8pj9cAC8";
const REQUIRED_TABS = [
  "БАЗА брокеров",
  "Координаторы",
  "НОВАЯ",
  "Коммерция",
] as const;
const MAX_GOOGLE_ROWS = 250_000;
const MAX_GOOGLE_CELLS = 2_000_000;
const MAX_GOOGLE_COLUMNS = 1_000;
const GOOGLE_CHUNK_CELLS = 1_000;
const GOOGLE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_CELL_CHARS = 20_000;

export interface SafeCounts {
  [key: string]: number | string | boolean | null | SafeCounts;
}

interface LoyaltySyncScanResult {
  contentHash: string;
  counts: SafeCounts;
  /**
   * Timestamp produced by the read operation itself. It is persisted inside
   * the signed-off counts so a later import cannot self-declare a coverage
   * horizon that is newer than the scan which attests it.
   */
  readAt?: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function updateHash(hash: ReturnType<typeof createHash>, value: unknown): void {
  const type =
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const text = value == null ? "" : String(value);
  hash.update(type);
  hash.update(":");
  hash.update(String(Buffer.byteLength(text, "utf8")));
  hash.update(":");
  hash.update(text);
  hash.update("\n");
}

function normalizedPhone(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("77")) return null;
  const normalized =
    digits.length === 12 && digits.startsWith("77")
      ? digits.slice(1)
      : digits.length === 11 && digits.startsWith("8")
        ? `7${digits.slice(1)}`
        : digits.length === 10
          ? `7${digits}`
          : digits;
  return normalized.length === 11 && normalized.startsWith("7")
    ? normalized
    : null;
}

function googleColumnName(column: number): string {
  if (!Number.isSafeInteger(column) || column <= 0) {
    throw new Error("GOOGLE_SCAN_LIMIT_EXCEEDED");
  }
  let current = column;
  let result = "";
  while (current > 0) {
    current -= 1;
    result = String.fromCharCode(65 + (current % 26)) + result;
    current = Math.floor(current / 26);
  }
  return result;
}

function googleA1Range(
  tab: string,
  endColumn: string,
  startRow: number,
  endRow: number,
): string {
  const quotedTab = `'${tab.replace(/'/g, "''")}'`;
  return `${quotedTab}!A${startRow}:${endColumn}${endRow}`;
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const known = [
    "GOOGLE_CREDENTIALS_MISSING",
    "GOOGLE_CREDENTIALS_INVALID",
    "GOOGLE_TABS_INCOMPLETE",
    "GOOGLE_SCAN_LIMIT_EXCEEDED",
    "GOOGLE_EMPTY_TAB",
    "AMO_READONLY_PAGE_BOUND_EXCEEDED",
    "AMO_READONLY_INVALID_ID",
    "AMO_READONLY_DUPLICATE_ID",
    "AMO_READONLY_ORDER_INVALID",
    "AMO_READONLY_RESPONSE_TOO_LARGE",
    "AMO_READONLY_RESPONSE_INVALID",
    "AMO_READONLY_PAGE_INVALID",
    "AMO_READONLY_PAGE_SIZE_INVALID",
    "LOYALTY_SYNC_RUN_FENCED",
    "AMO_ACCESS_TOKEN not configured",
  ];
  const match = known.find((value) => message.includes(value));
  if (match) return match.replace(/[^A-Z0-9_]/g, "_").slice(0, 100);
  if (message.includes("429")) return "SOURCE_RATE_LIMITED";
  if (/\b40[13]\b/.test(message)) return "SOURCE_AUTH_FAILED";
  if (/timeout|network/i.test(message)) return "SOURCE_NETWORK_FAILED";
  return "SOURCE_SCAN_FAILED";
}

@Injectable()
export class LoyaltySyncService {
  constructor(
    @Inject("PrismaClient") private readonly prisma: PrismaClient,
    private readonly permissions: LoyaltyPermissionService,
  ) {}

  async runs(query: LoyaltySyncRunsQueryDto, user: CurrentUserPayload) {
    await this.permissions.require(user, "AUDIT_READ");
    return this.prisma.loyaltySyncRun.findMany({
      where: query.source ? { source: query.source } : undefined,
      orderBy: { startedAt: "desc" },
      take: query.limit,
      select: {
        id: true,
        source: true,
        status: true,
        ruleVersion: true,
        sourceRefHash: true,
        contentHash: true,
        counts: true,
        errorCode: true,
        requestedById: true,
        startedAt: true,
        completedAt: true,
      },
    });
  }

  async googleDryRun(body: GoogleLoyaltyDryRunDto, user: CurrentUserPayload) {
    await this.permissions.require(user, "ANALYTICS_SYNC");
    const spreadsheetId =
      body.spreadsheetId ||
      process.env.LOYALTY_GOOGLE_SPREADSHEET_ID ||
      DEFAULT_SPREADSHEET_ID;
    return this.withRun(
      "GOOGLE_SHEETS",
      GOOGLE_RULE_VERSION,
      sha256(`google-sheets:${spreadsheetId}`),
      user.id,
      async () => this.readGoogle(spreadsheetId),
    );
  }

  async amoDryRun(body: AmoLoyaltyDryRunDto, user: CurrentUserPayload) {
    await this.permissions.require(user, "ANALYTICS_SYNC");
    return this.withRun(
      "AMOCRM",
      AMO_RULE_VERSION,
      sha256("amo:stmichael:contacts+companies+leads"),
      user.id,
      async () => this.readAmo(body.maxPages),
    );
  }

  private async withRun(
    source: "GOOGLE_SHEETS" | "AMOCRM",
    ruleVersion: string,
    sourceRefHash: string,
    actorId: string,
    scan: () => Promise<LoyaltySyncScanResult>,
  ) {
    let run: { id: string };
    try {
      run = await this.prisma.loyaltySyncRun.create({
        data: { source, ruleVersion, sourceRefHash, requestedById: actorId },
        select: { id: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException("LOYALTY_SYNC_ALREADY_RUNNING");
      }
      throw error;
    }

    try {
      const result = await scan();
      const completedAt = new Date();
      const suppliedReadAt = result.readAt ? new Date(result.readAt) : null;
      const trustedReadAt =
        suppliedReadAt &&
        Number.isFinite(suppliedReadAt.getTime()) &&
        suppliedReadAt.getTime() <= completedAt.getTime()
          ? suppliedReadAt
          : completedAt;
      const counts: SafeCounts = {
        ...result.counts,
        readAt: trustedReadAt.toISOString(),
      };
      const completion = await this.prisma.loyaltySyncRun.updateMany({
        where: { id: run.id, status: "RUNNING" },
        data: {
          status: "SUCCEEDED",
          contentHash: result.contentHash,
          counts,
          completedAt,
        },
      });
      if (completion.count !== 1) {
        throw new Error("LOYALTY_SYNC_RUN_FENCED");
      }
      return {
        runId: run.id,
        source,
        status: "SUCCEEDED" as const,
        ruleVersion,
        contentHash: result.contentHash,
        counts,
        completedAt,
        published: false,
      };
    } catch (error) {
      const errorCode = safeErrorCode(error);
      await this.prisma.loyaltySyncRun.updateMany({
        where: { id: run.id, status: "RUNNING" },
        data: { status: "FAILED", errorCode, completedAt: new Date() },
      });
      throw new BadGatewayException(errorCode);
    }
  }

  private credentials(): Record<string, unknown> {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error("GOOGLE_CREDENTIALS_MISSING");
    if (Buffer.byteLength(raw, "utf8") > 100_000) {
      throw new Error("GOOGLE_CREDENTIALS_INVALID");
    }
    try {
      const credentials = JSON.parse(raw) as Record<string, unknown>;
      if (
        credentials.type !== "service_account" ||
        typeof credentials.client_email !== "string" ||
        !String(credentials.client_email).endsWith(
          ".iam.gserviceaccount.com",
        ) ||
        typeof credentials.private_key !== "string" ||
        !String(credentials.private_key).includes("BEGIN PRIVATE KEY") ||
        credentials.token_uri !== "https://oauth2.googleapis.com/token"
      ) {
        throw new Error("GOOGLE_CREDENTIALS_INVALID");
      }
      return credentials;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "GOOGLE_CREDENTIALS_INVALID"
      ) {
        throw error;
      }
      throw new Error("GOOGLE_CREDENTIALS_INVALID");
    }
  }

  private async readGoogle(spreadsheetId: string) {
    const auth = new google.auth.GoogleAuth({
      credentials: this.credentials(),
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    // Metadata also defines the later A1 bounds. Capture the conservative
    // horizon before that first source read so concurrent grid expansion can
    // never appear covered by a timestamp taken after the metadata snapshot.
    const scanStartedAt = new Date().toISOString();
    const metadata = await sheets.spreadsheets.get({
      spreadsheetId,
      includeGridData: false,
      fields:
        "sheets.properties(title,sheetId,gridProperties(rowCount,columnCount))",
    });
    const grids = new Map<string, { rowCount: number; columnCount: number }>();
    for (const sheet of metadata.data.sheets || []) {
      const title = sheet.properties?.title;
      if (!title) continue;
      grids.set(title, {
        rowCount: Number(sheet.properties?.gridProperties?.rowCount),
        columnCount: Number(sheet.properties?.gridProperties?.columnCount),
      });
    }
    if (REQUIRED_TABS.some((tab) => !grids.has(tab))) {
      throw new Error("GOOGLE_TABS_INCOMPLETE");
    }

    let allocatedRows = 0;
    let allocatedCells = 0;
    for (const tab of REQUIRED_TABS) {
      const grid = grids.get(tab)!;
      if (
        !Number.isSafeInteger(grid.rowCount) ||
        grid.rowCount <= 0 ||
        !Number.isSafeInteger(grid.columnCount) ||
        grid.columnCount <= 0 ||
        grid.columnCount > MAX_GOOGLE_COLUMNS ||
        grid.rowCount > MAX_GOOGLE_ROWS - allocatedRows ||
        grid.rowCount >
          Math.floor((MAX_GOOGLE_CELLS - allocatedCells) / grid.columnCount)
      ) {
        throw new Error("GOOGLE_SCAN_LIMIT_EXCEEDED");
      }
      allocatedRows += grid.rowCount;
      allocatedCells += grid.rowCount * grid.columnCount;
    }

    const hash = createHash("sha256");
    let totalRows = 0;
    let totalCells = 0;
    let validPhones = 0;
    let invalidPhones = 0;
    const tabs: SafeCounts = {};

    for (const tab of REQUIRED_TABS) {
      const grid = grids.get(tab)!;
      const endColumn = googleColumnName(grid.columnCount);
      const rowsPerChunk = Math.max(
        1,
        Math.floor(GOOGLE_CHUNK_CELLS / grid.columnCount),
      );
      let headers: string[] = [];
      let phoneColumns: number[] = [];
      let nonEmptyRows = 0;
      let tabValidPhones = 0;
      let tabInvalidPhones = 0;
      let chunks = 0;
      let sawRows = false;
      updateHash(hash, tab);

      for (
        let startRow = 1;
        startRow <= grid.rowCount;
        startRow += rowsPerChunk
      ) {
        const endRow = Math.min(grid.rowCount, startRow + rowsPerChunk - 1);
        const response = await sheets.spreadsheets.values.get(
          {
            spreadsheetId,
            range: googleA1Range(tab, endColumn, startRow, endRow),
            majorDimension: "ROWS",
            valueRenderOption: "UNFORMATTED_VALUE",
            dateTimeRenderOption: "FORMATTED_STRING",
          },
          { maxContentLength: GOOGLE_MAX_RESPONSE_BYTES },
        );
        const rows = (response.data.values || []) as unknown[][];
        if (!Array.isArray(rows) || rows.length > endRow - startRow + 1) {
          throw new Error("GOOGLE_SCAN_LIMIT_EXCEEDED");
        }
        chunks += 1;
        sawRows ||= rows.length > 0;
        if (startRow === 1) {
          const headerRow = rows[0] || [];
          if (!Array.isArray(headerRow)) {
            throw new Error("GOOGLE_SCAN_LIMIT_EXCEEDED");
          }
          headers = headerRow.map((value) =>
            String(value ?? "")
              .trim()
              .toLocaleLowerCase("ru-RU"),
          );
          phoneColumns = headers
            .map((value, column) => (/телефон|phone/.test(value) ? column : -1))
            .filter((column) => column >= 0);
        }

        for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
          const row = rows[rowIndex];
          if (
            !Array.isArray(row) ||
            row.length > grid.columnCount ||
            row.length > MAX_GOOGLE_COLUMNS
          ) {
            throw new Error("GOOGLE_SCAN_LIMIT_EXCEEDED");
          }
          const absoluteRow = startRow + rowIndex;
          updateHash(hash, `row:${absoluteRow}`);
          updateHash(hash, `row-length:${row.length}`);
          if (row.some((cell) => String(cell ?? "").trim().length > 0)) {
            nonEmptyRows += 1;
          }
          totalCells += row.length;
          if (totalCells > MAX_GOOGLE_CELLS) {
            throw new Error("GOOGLE_SCAN_LIMIT_EXCEEDED");
          }
          for (
            let columnIndex = 0;
            columnIndex < row.length;
            columnIndex += 1
          ) {
            const cell = row[columnIndex];
            if (String(cell ?? "").length > MAX_CELL_CHARS) {
              throw new Error("GOOGLE_SCAN_LIMIT_EXCEEDED");
            }
            updateHash(hash, `column:${columnIndex + 1}`);
            updateHash(hash, cell);
          }
          if (absoluteRow === 1) continue;
          for (const column of phoneColumns) {
            const value = row[column];
            if (!String(value ?? "").trim()) continue;
            if (normalizedPhone(value)) tabValidPhones += 1;
            else tabInvalidPhones += 1;
          }
        }
      }
      if (!sawRows) throw new Error("GOOGLE_EMPTY_TAB");
      totalRows += nonEmptyRows;
      if (totalRows > MAX_GOOGLE_ROWS) {
        throw new Error("GOOGLE_SCAN_LIMIT_EXCEEDED");
      }
      validPhones += tabValidPhones;
      invalidPhones += tabInvalidPhones;
      tabs[tab] = {
        nonEmptyRows,
        columns: headers.length,
        gridRows: grid.rowCount,
        gridColumns: grid.columnCount,
        chunks,
        validPhoneCells: tabValidPhones,
        invalidPhoneCells: tabInvalidPhones,
      };
    }

    return {
      contentHash: hash.digest("hex"),
      readAt: scanStartedAt,
      counts: {
        completeTraversal: true,
        transactionalSnapshot: false,
        eventCoverageComplete: false,
        semantics: "SEQUENTIAL_BOUNDED_TRAVERSAL_NOT_POINT_IN_TIME",
        requiredTabs: REQUIRED_TABS.length,
        allocatedGridRows: allocatedRows,
        allocatedGridCells: allocatedCells,
        totalNonEmptyRows: totalRows,
        totalCells,
        validPhoneCells: validPhones,
        invalidPhoneCells: invalidPhones,
        tabs,
      },
    };
  }

  private async readAmo(maxPages: number) {
    const adapter = new AmoCrmAdapter();
    const hash = createHash("sha256");
    const scan = async (
      kind: "contacts" | "companies" | "leads",
      withRelations: string,
    ) => {
      let count = 0;
      updateHash(hash, kind);
      const result = await adapter.consumeReadonlyPages<any>(
        kind,
        ({ items }) => {
          for (const item of items) {
            const id = Number(item?.id);
            const updatedAt = Number(item?.updated_at || 0);
            const pipelineId = Number(item?.pipeline_id || 0);
            const statusId = Number(item?.status_id || 0);
            updateHash(hash, `${id}:${updatedAt}:${pipelineId}:${statusId}`);
          }
          count += items.length;
        },
        { maxPages, with: withRelations },
      );
      if (result.itemsRead !== count) {
        throw new Error("AMO_READONLY_PAGE_COUNT_INVALID");
      }
      return { ...result, count };
    };
    // Sequential scans stay below amoCRM's shared request budget; a partial
    // response is never recorded as success if any resource fails. Since the
    // pages are not a transactional snapshot, coverage cannot be newer than
    // the instant immediately before the first resource request.
    const scanStartedAt = new Date().toISOString();
    const contacts = await scan("contacts", "leads,companies");
    const companies = await scan("companies", "contacts,leads");
    const leads = await scan("leads", "contacts,companies");
    return {
      contentHash: hash.digest("hex"),
      readAt: scanStartedAt,
      counts: {
        complete: true,
        contacts: contacts.count,
        contactPages: contacts.pagesRead,
        companies: companies.count,
        companyPages: companies.pagesRead,
        leads: leads.count,
        leadPages: leads.pagesRead,
      },
    };
  }
}
