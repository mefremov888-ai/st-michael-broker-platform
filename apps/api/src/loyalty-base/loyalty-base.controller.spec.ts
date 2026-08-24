import { UserRole } from "@st-michael/shared";
import {
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
} from "@nestjs/common/constants";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { LoyaltyBaseController } from "./loyalty-base.controller";
import {
  LoyaltyActivityDto,
  LoyaltyImportDto,
  LoyaltyImportRecordDto,
  LoyaltyListQueryDto,
  LoyaltyReconciliationDecisionDto,
  LoyaltySearchDto,
} from "./loyalty-base.dto";
import { LoyaltyImportPermissionGuard } from "./loyalty-import-permission.guard";

describe("LoyaltyBaseController RBAC", () => {
  it.each([
    "reconciliation",
    "reconciliationSearch",
    "activeLinks",
    "exportBrokers",
    "exportAgencies",
    "brokerChanges",
    "agencyChanges",
    "dryRunImport",
  ] as const)(
    "lets ADMIN/MANAGER reach %s so grants can be enforced",
    (method) => {
      expect(
        Reflect.getMetadata("roles", LoyaltyBaseController.prototype[method]),
      ).toEqual([UserRole.ADMIN, UserRole.MANAGER]);
    },
  );

  it.each([
    "stageImport",
    "publishImport",
    "unlinkActiveLink",
    "decideReconciliation",
  ] as const)("keeps destructive %s restricted to ADMIN", (method) => {
    expect(
      Reflect.getMetadata("roles", LoyaltyBaseController.prototype[method]),
    ).toEqual([UserRole.ADMIN]);
  });

  it.each(["dryRunImport", "stageImport"] as const)(
    "runs the IMPORT grant guard before the multipart interceptor for %s",
    (method) => {
      const guards =
        Reflect.getMetadata(
          GUARDS_METADATA,
          LoyaltyBaseController.prototype[method],
        ) || [];
      const interceptors =
        Reflect.getMetadata(
          INTERCEPTORS_METADATA,
          LoyaltyBaseController.prototype[method],
        ) || [];

      expect(guards).toContain(LoyaltyImportPermissionGuard);
      expect(interceptors).toHaveLength(1);
    },
  );

  it("keeps the dry-run handler permission check as defense in depth", async () => {
    const loyalty: any = {
      dryRunImport: jest.fn().mockResolvedValue({ ok: true }),
    };
    const permissions: any = {
      require: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new LoyaltyBaseController(loyalty, permissions);
    jest
      .spyOn(controller as any, "validatedImportDocument")
      .mockResolvedValue({ sourceName: "validated.json" });
    const user: any = { id: "manager-1", role: "MANAGER" };

    await expect(controller.dryRunImport(undefined, {}, user)).resolves.toEqual(
      { ok: true },
    );
    expect(permissions.require).toHaveBeenCalledWith(user, "IMPORT");
    expect(loyalty.dryRunImport).toHaveBeenCalledWith({
      sourceName: "validated.json",
    });
  });
});

describe("loyalty canonical filter validation", () => {
  it("allows an empty POST-body search and requires campaign UUIDs", async () => {
    const valid = plainToInstance(LoyaltySearchDto, {
      search: "",
      filter: {
        campaignIds: ["11111111-1111-4111-8111-111111111111"],
      },
      columns: {
        contact: "HAS_PHONE",
        activity: "HAS_MEETINGS",
        calls: "CALLED_IN_PERIOD",
        deals: "THREE_PLUS",
      },
    });
    // Calls-in-period is structurally valid here; the service enforces that
    // callPeriod is present because it owns cross-field validation.
    expect(await validate(valid)).toEqual([]);

    const invalid = plainToInstance(LoyaltySearchDto, {
      search: "",
      filter: { campaignIds: ["Обзвон май"] },
    });
    expect(
      (await validate(invalid)).some((error) => error.property === "filter"),
    ).toBe(true);

    const invalidColumn = plainToInstance(LoyaltySearchDto, {
      search: "",
      columns: { deals: "ABOUT_THREE" },
    });
    expect(
      (await validate(invalidColumn)).some(
        (error) => error.property === "columns",
      ),
    ).toBe(true);
  });

  it("requires an auditable reconciliation reason", async () => {
    const invalid = plainToInstance(LoyaltyReconciliationDecisionDto, {
      caseId: "case-1",
      decision: "SUPPLEMENT",
      expectedVersion: 1,
      reason: "  ",
    });
    expect(
      (await validate(invalid)).some((error) => error.property === "reason"),
    ).toBe(true);

    const valid = plainToInstance(LoyaltyReconciliationDecisionDto, {
      caseId: "case-1",
      decision: "ARCHIVE",
      expectedVersion: 1,
      reason: "Confirmed duplicate source record",
      fieldResolutions: { city: "anna" },
    });
    expect(await validate(valid)).toEqual([]);
  });
});

describe("loyalty import Decimal(18,2) validation", () => {
  it.each([
    ["9999999999999999.99", false],
    ["10000000000000000.00", true],
  ] as const)(
    "validates activity amount %s at the database boundary",
    async (amount, rejected) => {
      const dto = plainToInstance(LoyaltyActivityDto, {
        sourceSystem: "AMOCRM",
        externalId: "deal-1",
        type: "DEAL",
        occurredAt: "2026-08-18T00:00:00.000Z",
        amount,
      });

      const amountError = (await validate(dto)).find(
        (error) => error.property === "amount",
      );
      expect(Boolean(amountError)).toBe(rejected);
    },
  );

  it.each([
    ["9999999999999999.99", false],
    ["10000000000000000.00", true],
  ] as const)(
    "validates manifest deal amount %s at the database boundary",
    async (amount, rejected) => {
      const dto = plainToInstance(LoyaltyImportDto, {
        sourceName: "anna-export.json",
        ruleVersion: "anna-v1",
        expectedRecords: 1,
        expectedUniquePhones: 0,
        expectedActivities: 0,
        expectedExternalIdentities: 0,
        expectedIncludedFixations: 0,
        expectedIncludedMeetings: 0,
        expectedIncludedDeals: 0,
        expectedIncludedBrokerTours: 0,
        expectedIncludedCalls: 0,
        expectedIncludedDealAmount: amount,
        records: [
          {
            externalKey: "anna-person-1",
            entityType: "BROKER",
            displayName: "Test broker",
          },
        ],
      });

      const amountError = (await validate(dto)).find(
        (error) => error.property === "expectedIncludedDealAmount",
      );
      expect(Boolean(amountError)).toBe(rejected);
    },
  );
});

describe("loyalty pagination and source row validation", () => {
  it("caps pages before they become unsafe database offsets", async () => {
    const dto = plainToInstance(LoyaltyListQueryDto, { page: 10001 });
    expect(
      (await validate(dto)).some((error) => error.property === "page"),
    ).toBe(true);
  });

  it("caps untrusted source row numbers", async () => {
    const dto = plainToInstance(LoyaltyImportRecordDto, {
      externalKey: "broker-1",
      entityType: "BROKER",
      displayName: "Broker",
      sourceRowNumber: 10000001,
    });
    expect(
      (await validate(dto)).some(
        (error) => error.property === "sourceRowNumber",
      ),
    ).toBe(true);
  });
});
