import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  AssignCallCenterBrokersDto,
  LogCallCenterCallDto,
  MangoCallDto,
  UpdateIntegrationSettingDto,
  UpdateMangoEmployeeNumDto,
} from "./admin-mango.dto";

async function errors<T extends object>(type: new () => T, value: object) {
  return validate(plainToInstance(type, value));
}

describe("Mango and call-center DTOs", () => {
  it.each([
    { mangoEmployeeNum: null },
    { mangoEmployeeNum: "" },
    { mangoEmployeeNum: " 0017 " },
  ])("accepts a supported EmployeeNUM payload: %j", async (payload) =>
    expect(errors(UpdateMangoEmployeeNumDto, payload)).resolves.toHaveLength(0),
  );

  it.each([
    {},
    { mangoEmployeeNum: 17 },
    { mangoEmployeeNum: "17A" },
    { mangoEmployeeNum: "123456789012345678901" },
  ])("rejects an invalid EmployeeNUM payload: %j", async (payload) => {
    expect(await errors(UpdateMangoEmployeeNumDto, payload)).not.toHaveLength(
      0,
    );
  });

  it("requires UUIDs for a Mango call", async () => {
    expect(
      await errors(MangoCallDto, {
        brokerId: "not-a-uuid",
        idempotencyKey: "also-not-a-uuid",
      }),
    ).not.toHaveLength(0);
    expect(
      await errors(MangoCallDto, {
        brokerId: "d55ce101-6d6d-4ce4-9a21-77d6bd49ac93",
        idempotencyKey: "b5066154-6973-4730-bc62-d3df0dc85925",
      }),
    ).toHaveLength(0);
  });

  it("bounds assignment batches and validates every id", async () => {
    expect(
      await errors(AssignCallCenterBrokersDto, {
        brokerIds: [],
        managerId: "d55ce101-6d6d-4ce4-9a21-77d6bd49ac93",
      }),
    ).not.toHaveLength(0);
    expect(
      await errors(AssignCallCenterBrokersDto, {
        brokerIds: ["not-a-uuid"],
        managerId: "also-not-a-uuid",
      }),
    ).not.toHaveLength(0);
  });

  it("accepts only known call results and ISO dates", async () => {
    const brokerId = "d55ce101-6d6d-4ce4-9a21-77d6bd49ac93";
    expect(
      await errors(LogCallCenterCallDto, {
        brokerId,
        result: "UNKNOWN",
      }),
    ).not.toHaveLength(0);
    expect(
      await errors(LogCallCenterCallDto, {
        brokerId,
        result: "NDZ",
        nextCallAtOverride: "tomorrow",
      }),
    ).not.toHaveLength(0);
    expect(
      await errors(LogCallCenterCallDto, {
        brokerId,
        result: "NDZ",
        nextCallAtOverride: "2026-08-20T09:00:00.000Z",
        doNotCallOverride: false,
      }),
    ).toHaveLength(0);
  });

  it("rejects non-string integration values before service trim()", async () => {
    expect(
      await errors(UpdateIntegrationSettingDto, { value: { secret: true } }),
    ).not.toHaveLength(0);
  });
});
