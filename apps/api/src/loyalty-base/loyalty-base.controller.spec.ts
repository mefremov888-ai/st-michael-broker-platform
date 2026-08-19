import { UserRole } from "@st-michael/shared";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { LoyaltyBaseController } from "./loyalty-base.controller";
import {
  LoyaltyActivityDto,
  LoyaltyImportDto,
  LoyaltyImportRecordDto,
  LoyaltyListQueryDto,
} from "./loyalty-base.dto";

describe("LoyaltyBaseController RBAC", () => {
  it.each(["reconciliation", "reconciliationSearch", "activeLinks"] as const)(
    "restricts %s to ADMIN",
    (method) => {
      expect(
        Reflect.getMetadata("roles", LoyaltyBaseController.prototype[method]),
      ).toEqual([UserRole.ADMIN]);
    },
  );
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
