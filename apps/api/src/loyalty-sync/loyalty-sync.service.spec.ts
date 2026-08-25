import "reflect-metadata";
import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { Prisma } from "@st-michael/database";
import { AmoCrmAdapter, setAmoTokens } from "@st-michael/integrations";
import { UserRole } from "@st-michael/shared";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import * as googleSheetsApi from "googleapis/build/src/apis/sheets";
import { LoyaltySyncController } from "./loyalty-sync.controller";
import {
  AmoLoyaltyDryRunDto,
  GoogleLoyaltyDryRunDto,
} from "./loyalty-sync.dto";
import { LoyaltySyncService } from "./loyalty-sync.service";
import { LoyaltyPermissionService } from "../loyalty-workflow/loyalty-permission.service";

const admin = { id: "actor-1", role: "ADMIN", phone: "", fullName: "Admin" };
const manager = {
  id: "manager-1",
  role: "MANAGER",
  phone: "",
  fullName: "Manager",
};
const broker = {
  id: "broker-1",
  role: "BROKER",
  phone: "",
  fullName: "Broker",
};
const requiredGoogleTabs = [
  "БАЗА брокеров",
  "Координаторы",
  "НОВАЯ",
  "Коммерция",
];
const validGoogleCredentials = JSON.stringify({
  type: "service_account",
  client_email: "loyalty@example.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\ntest",
  token_uri: "https://oauth2.googleapis.com/token",
});

function harness() {
  const prisma: any = {
    loyaltySyncRun: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue({ id: "run-1" }),
      update: jest.fn().mockResolvedValue({}),
    },
    loyaltyUserGrant: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  return {
    prisma,
    service: new LoyaltySyncService(
      prisma,
      new LoyaltyPermissionService(prisma),
    ),
  };
}

describe("LoyaltySyncService", () => {
  it("stores only a PII-free Google dry-run attestation", async () => {
    const { prisma, service } = harness();
    jest.spyOn(service as any, "readGoogle").mockResolvedValue({
      contentHash: "a".repeat(64),
      counts: { complete: true, totalNonEmptyRows: 100 },
    });

    const result = await service.googleDryRun(
      { spreadsheetId: "1HYiRxnRb0psYzKZmD7f34gdMgNR6gso8Swj8pj9cAC8" },
      admin,
    );

    expect(result).toMatchObject({
      status: "SUCCEEDED",
      published: false,
      contentHash: "a".repeat(64),
    });
    const serializedWrites = JSON.stringify(
      prisma.loyaltySyncRun.mock?.calls || [
        prisma.loyaltySyncRun.create.mock.calls,
        prisma.loyaltySyncRun.updateMany.mock.calls,
      ],
    );
    expect(serializedWrites).not.toContain("@example");
    expect(prisma.loyaltySyncRun.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: "run-1", status: "RUNNING" },
        data: expect.objectContaining({
          status: "SUCCEEDED",
          counts: expect.objectContaining({
            complete: true,
            totalNonEmptyRows: 100,
            readAt: expect.any(String),
          }),
        }),
      }),
    );
  });

  it("persists the source read timestamp as the trusted coverage horizon", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    try {
      const { prisma, service } = harness();
      jest.spyOn(service as any, "readGoogle").mockResolvedValue({
        contentHash: "c".repeat(64),
        readAt: "2026-08-24T11:59:00.000Z",
        counts: { complete: true, totalNonEmptyRows: 1 },
      });

      const result = await service.googleDryRun({}, admin);

      expect(result.counts).toMatchObject({
        complete: true,
        readAt: "2026-08-24T11:59:00.000Z",
      });
      expect(prisma.loyaltySyncRun.updateMany).toHaveBeenCalledWith({
        where: { id: "run-1", status: "RUNNING" },
        data: expect.objectContaining({
          completedAt: new Date("2026-08-24T12:00:00.000Z"),
          counts: expect.objectContaining({
            readAt: "2026-08-24T11:59:00.000Z",
          }),
        }),
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it("persists only a bounded safe error code", async () => {
    const { prisma, service } = harness();
    jest
      .spyOn(service as any, "readGoogle")
      .mockRejectedValue(
        new Error("403 raw person@example.test +79990001122 secret body"),
      );

    await expect(service.googleDryRun({}, admin)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(prisma.loyaltySyncRun.updateMany).toHaveBeenLastCalledWith({
      where: { id: "run-1", status: "RUNNING" },
      data: expect.objectContaining({ errorCode: "SOURCE_AUTH_FAILED" }),
    });
    expect(
      JSON.stringify(prisma.loyaltySyncRun.updateMany.mock.calls),
    ).not.toContain("person@example.test");
  });

  it("bounds scan DTOs and keeps spreadsheet identifiers syntactic", async () => {
    const badAmo = plainToInstance(AmoLoyaltyDryRunDto, { maxPages: 2001 });
    expect(await validate(badAmo)).not.toHaveLength(0);
    const badGoogle = plainToInstance(GoogleLoyaltyDryRunDto, {
      spreadsheetId: "https://docs.google.com/private?token=x",
    });
    expect(await validate(badGoogle)).not.toHaveLength(0);
  });

  it("lets ADMIN/MANAGER reach endpoints so service grants are enforced", () => {
    expect(Reflect.getMetadata("roles", LoyaltySyncController)).toEqual([
      UserRole.ADMIN,
      UserRole.MANAGER,
    ]);
  });

  it("denies MANAGER without ANALYTICS_SYNC and always denies BROKER", async () => {
    const { prisma, service } = harness();
    await expect(service.googleDryRun({}, manager)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      service.amoDryRun({ maxPages: 2_000 }, broker),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.loyaltySyncRun.create).not.toHaveBeenCalled();
  });

  it("accepts an active ANALYTICS_SYNC grant for a manager", async () => {
    const { prisma, service } = harness();
    prisma.loyaltyUserGrant.findFirst.mockResolvedValue({ id: "grant-1" });
    jest.spyOn(service as any, "readGoogle").mockResolvedValue({
      contentHash: "b".repeat(64),
      counts: { complete: true, totalNonEmptyRows: 10 },
    });
    await expect(service.googleDryRun({}, manager)).resolves.toMatchObject({
      status: "SUCCEEDED",
      published: false,
    });
    expect(prisma.loyaltyUserGrant.findFirst).toHaveBeenCalledWith({
      where: {
        userId: manager.id,
        permission: "ANALYTICS_SYNC",
        revokedAt: null,
      },
      select: { id: true },
    });
  });

  it("uses AUDIT_READ independently for sync-run history", async () => {
    const { prisma, service } = harness();
    await expect(service.runs({ limit: 20 }, manager)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    prisma.loyaltyUserGrant.findFirst.mockResolvedValue({ id: "audit-grant" });
    await expect(service.runs({ limit: 20 }, manager)).resolves.toEqual([]);
    expect(prisma.loyaltyUserGrant.findFirst).toHaveBeenLastCalledWith({
      where: {
        userId: manager.id,
        permission: "AUDIT_READ",
        revokedAt: null,
      },
      select: { id: true },
    });
  });

  it("never auto-recovers an old RUNNING row when the unique guard rejects overlap", async () => {
    const { prisma, service } = harness();
    prisma.loyaltySyncRun.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    await expect(service.googleDryRun({}, admin)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.loyaltySyncRun.updateMany).not.toHaveBeenCalled();
  });

  it("fences both terminal writes when the RUNNING lease was lost", async () => {
    const { prisma, service } = harness();
    prisma.loyaltySyncRun.updateMany.mockResolvedValue({ count: 0 });
    jest.spyOn(service as any, "readGoogle").mockResolvedValue({
      contentHash: "f".repeat(64),
      counts: { complete: true, totalNonEmptyRows: 1 },
    });

    await expect(service.googleDryRun({}, admin)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(prisma.loyaltySyncRun.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.loyaltySyncRun.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: "run-1", status: "RUNNING" },
      data: { status: "SUCCEEDED" },
    });
    expect(prisma.loyaltySyncRun.updateMany.mock.calls[1][0]).toMatchObject({
      where: { id: "run-1", status: "RUNNING" },
      data: { status: "FAILED", errorCode: "LOYALTY_SYNC_RUN_FENCED" },
    });
    expect(prisma.loyaltySyncRun.update).not.toHaveBeenCalled();
  });

  it("streams ordered amoCRM pages without retaining the legacy item array", async () => {
    const adapter = new AmoCrmAdapter();
    const request = jest
      .spyOn(adapter as any, "request")
      .mockResolvedValueOnce({
        _embedded: { contacts: [{ id: 1 }, { id: 2 }] },
      })
      .mockResolvedValueOnce({ _embedded: { contacts: [{ id: 3 }] } });
    const consumed: number[][] = [];

    const result = await adapter.consumeReadonlyPages(
      "contacts",
      ({ items }) => {
        consumed.push(items.map((item: any) => item.id));
      },
      { limit: 2, maxPages: 3, with: "leads" },
    );

    expect(consumed).toEqual([[1, 2], [3]]);
    expect(result).toMatchObject({
      itemsRead: 3,
      pagesRead: 2,
      complete: true,
    });
    for (const [path] of request.mock.calls) {
      const query = new URL(`https://amo.invalid${path}`).searchParams;
      expect(query.get("order[id]")).toBe("asc");
    }
  });

  it.each([
    ["AMO_READONLY_INVALID_ID", [{ id: 0 }]],
    ["AMO_READONLY_DUPLICATE_ID", [{ id: 1 }, { id: 1 }]],
    ["AMO_READONLY_ORDER_INVALID", [{ id: 2 }, { id: 1 }]],
  ])(
    "fails closed with %s before consuming a malformed amoCRM page",
    async (code, items) => {
      const adapter = new AmoCrmAdapter();
      jest
        .spyOn(adapter as any, "request")
        .mockResolvedValue({ _embedded: { contacts: items } });
      const consume = jest.fn();

      await expect(
        adapter.consumeReadonlyPages("contacts", consume, {
          limit: 2,
          maxPages: 2,
        }),
      ).rejects.toThrow(code);
      expect(consume).not.toHaveBeenCalled();
    },
  );

  it("rejects readonly amoCRM content-length above the hard body cap", async () => {
    const originalFetch = global.fetch;
    setAmoTokens("test-token", "");
    global.fetch = jest.fn().mockResolvedValue(
      new Response('{"_embedded":{"contacts":[]}}', {
        status: 200,
        headers: { "Content-Length": String(16 * 1024 * 1024 + 1) },
      }),
    ) as any;
    const consume = jest.fn();
    try {
      await expect(
        new AmoCrmAdapter().consumeReadonlyPages("contacts", consume, {
          limit: 2,
          maxPages: 2,
        }),
      ).rejects.toThrow("AMO_READONLY_RESPONSE_TOO_LARGE");
      expect(consume).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
      setAmoTokens("", "");
    }
  });

  it("cancels a chunked readonly amoCRM stream before JSON parse when it crosses the cap", async () => {
    const originalFetch = global.fetch;
    setAmoTokens("test-token", "");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024));
        controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
        controller.close();
      },
    });
    global.fetch = jest.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as any;
    const consume = jest.fn();
    try {
      await expect(
        new AmoCrmAdapter().consumeReadonlyPages("contacts", consume, {
          limit: 2,
          maxPages: 2,
        }),
      ).rejects.toThrow("AMO_READONLY_RESPONSE_TOO_LARGE");
      expect(consume).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
      setAmoTokens("", "");
    }
  });

  it.each([
    ["AMO_READONLY_PAGE_INVALID", { _embedded: { contacts: {} } }],
    [
      "AMO_READONLY_PAGE_SIZE_INVALID",
      { _embedded: { contacts: [{ id: 1 }, { id: 2 }, { id: 3 }] } },
    ],
  ])(
    "rejects malformed readonly amoCRM page shape with %s",
    async (code, body) => {
      const originalFetch = global.fetch;
      setAmoTokens("test-token", "");
      global.fetch = jest.fn().mockResolvedValue(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ) as any;
      const consume = jest.fn();
      try {
        await expect(
          new AmoCrmAdapter().consumeReadonlyPages("contacts", consume, {
            limit: 2,
            maxPages: 2,
          }),
        ).rejects.toThrow(code);
        expect(consume).not.toHaveBeenCalled();
      } finally {
        global.fetch = originalFetch;
        setAmoTokens("", "");
      }
    },
  );

  it("hashes amoCRM inside each page consumer and never calls the accumulating scanner", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-24T09:00:00.000Z"));
    const { service } = harness();
    const legacy = jest.spyOn(AmoCrmAdapter.prototype, "scanReadonly");
    const streamed = jest
      .spyOn(AmoCrmAdapter.prototype, "consumeReadonlyPages")
      .mockImplementation(async (resource, consume) => {
        jest.setSystemTime(new Date(Date.now() + 1_000));
        const offset =
          resource === "contacts" ? 0 : resource === "companies" ? 10 : 20;
        await consume({
          items: [
            { id: offset + 1, updated_at: 100 },
            { id: offset + 2, updated_at: 200 },
          ],
          page: 1,
          limit: 250,
        });
        return {
          itemsRead: 2,
          pagesRead: 1,
          complete: true as const,
          readAt: "2026-08-24T10:00:00.000Z",
        };
      });
    try {
      await expect((service as any).readAmo(10)).resolves.toMatchObject({
        contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        readAt: "2026-08-24T09:00:00.000Z",
        counts: {
          contacts: 2,
          companies: 2,
          leads: 2,
        },
      });
      expect(streamed).toHaveBeenCalledTimes(3);
      expect(legacy).not.toHaveBeenCalled();
    } finally {
      streamed.mockRestore();
      legacy.mockRestore();
      jest.useRealTimers();
    }
  });

  it("checks Google grid bounds first, then reads sequential chunks of at most 1000 cells", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-24T10:00:00.000Z"));
    const { service } = harness();
    const previousCredentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = validGoogleCredentials;
    const metadataGet = jest.fn().mockImplementation(async () => {
      jest.setSystemTime(new Date(Date.now() + 5_000));
      return {
        data: {
          sheets: requiredGoogleTabs.map((title) => ({
            properties: {
              title,
              gridProperties: { rowCount: 20, columnCount: 100 },
            },
          })),
        },
      };
    });
    let active = 0;
    let maxActive = 0;
    let invocation = 0;
    const valuesGet = jest.fn().mockImplementation(async () => {
      const current = invocation;
      invocation += 1;
      jest.setSystemTime(new Date(Date.now() + 1_000));
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return current % 2 === 0
        ? { data: { values: [["Телефон"], ["+79990000001"]] } }
        : { data: { values: [] } };
    });
    const batchGet = jest.fn();
    const sheetsSpy = jest.spyOn(googleSheetsApi, "sheets").mockReturnValue({
      spreadsheets: {
        get: metadataGet,
        values: { get: valuesGet, batchGet },
      },
    } as any);
    try {
      const result = await (service as any).readGoogle("sheet-id");
      expect(result).toMatchObject({
        contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        readAt: "2026-08-24T10:00:00.000Z",
        counts: {
          completeTraversal: true,
          transactionalSnapshot: false,
          eventCoverageComplete: false,
          semantics: "SEQUENTIAL_BOUNDED_TRAVERSAL_NOT_POINT_IN_TIME",
          allocatedGridCells: 8_000,
          validPhoneCells: 4,
          tabs: {
            "БАЗА брокеров": { chunks: 2 },
            Координаторы: { chunks: 2 },
            НОВАЯ: { chunks: 2 },
            Коммерция: { chunks: 2 },
          },
        },
      });
      expect(result.counts).not.toHaveProperty("complete");
      expect(metadataGet).toHaveBeenCalledTimes(1);
      expect(valuesGet).toHaveBeenCalledTimes(8);
      expect(batchGet).not.toHaveBeenCalled();
      expect(maxActive).toBe(1);
      for (const [request, options] of valuesGet.mock.calls) {
        expect(request).toMatchObject({
          spreadsheetId: "sheet-id",
          majorDimension: "ROWS",
          valueRenderOption: "UNFORMATTED_VALUE",
          dateTimeRenderOption: "FORMATTED_STRING",
        });
        expect(options).toEqual({ maxContentLength: 8 * 1024 * 1024 });
        const match = String(request.range).match(/!A(\d+):CV(\d+)$/);
        expect(match).not.toBeNull();
        const rows = Number(match![2]) - Number(match![1]) + 1;
        expect(rows * 100).toBeLessThanOrEqual(1_000);
      }
    } finally {
      sheetsSpy.mockRestore();
      jest.useRealTimers();
      if (previousCredentials === undefined) {
        delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      } else {
        process.env.GOOGLE_SERVICE_ACCOUNT_JSON = previousCredentials;
      }
    }
  });

  it("includes absolute row and column layout in the Google content hash", async () => {
    const { service } = harness();
    const previousCredentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = validGoogleCredentials;
    const readLayout = async (values: unknown[][]) => {
      const sheetsSpy = jest.spyOn(googleSheetsApi, "sheets").mockReturnValue({
        spreadsheets: {
          get: jest.fn().mockResolvedValue({
            data: {
              sheets: requiredGoogleTabs.map((title) => ({
                properties: {
                  title,
                  gridProperties: { rowCount: 2, columnCount: 2 },
                },
              })),
            },
          }),
          values: {
            get: jest.fn().mockResolvedValue({ data: { values } }),
          },
        },
      } as any);
      try {
        return await (service as any).readGoogle("sheet-id");
      } finally {
        sheetsSpy.mockRestore();
      }
    };
    try {
      const firstLayout = [["header-a", "header-b"], ["value"]];
      const secondLayout = [["header-a"], ["header-b", "value"]];
      expect(firstLayout.flat()).toEqual(secondLayout.flat());

      const first = await readLayout(firstLayout);
      const second = await readLayout(secondLayout);

      expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(second.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(first.contentHash).not.toBe(second.contentHash);
    } finally {
      if (previousCredentials === undefined) {
        delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      } else {
        process.env.GOOGLE_SERVICE_ACCOUNT_JSON = previousCredentials;
      }
    }
  });

  it("rejects Google grids wider than the per-request cell cap before values", async () => {
    const { service } = harness();
    const previousCredentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = validGoogleCredentials;
    const valuesGet = jest.fn();
    const sheetsSpy = jest.spyOn(googleSheetsApi, "sheets").mockReturnValue({
      spreadsheets: {
        get: jest.fn().mockResolvedValue({
          data: {
            sheets: requiredGoogleTabs.map((title) => ({
              properties: {
                title,
                gridProperties: { rowCount: 1, columnCount: 1_001 },
              },
            })),
          },
        }),
        values: { get: valuesGet },
      },
    } as any);
    try {
      await expect((service as any).readGoogle("sheet-id")).rejects.toThrow(
        "GOOGLE_SCAN_LIMIT_EXCEEDED",
      );
      expect(valuesGet).not.toHaveBeenCalled();
    } finally {
      sheetsSpy.mockRestore();
      if (previousCredentials === undefined) {
        delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      } else {
        process.env.GOOGLE_SERVICE_ACCOUNT_JSON = previousCredentials;
      }
    }
  });

  it("rejects oversized Google metadata before fetching any cell values", async () => {
    const { service } = harness();
    const previousCredentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = validGoogleCredentials;
    const valuesGet = jest.fn();
    const sheetsSpy = jest.spyOn(googleSheetsApi, "sheets").mockReturnValue({
      spreadsheets: {
        get: jest.fn().mockResolvedValue({
          data: {
            sheets: requiredGoogleTabs.map((title) => ({
              properties: {
                title,
                gridProperties: { rowCount: 600, columnCount: 1_000 },
              },
            })),
          },
        }),
        values: { get: valuesGet },
      },
    } as any);
    try {
      await expect((service as any).readGoogle("sheet-id")).rejects.toThrow(
        "GOOGLE_SCAN_LIMIT_EXCEEDED",
      );
      expect(valuesGet).not.toHaveBeenCalled();
    } finally {
      sheetsSpy.mockRestore();
      if (previousCredentials === undefined) {
        delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      } else {
        process.env.GOOGLE_SERVICE_ACCOUNT_JSON = previousCredentials;
      }
    }
  });
});
