import { WebhooksService } from "./webhooks.service";
import {
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import * as crypto from "crypto";
import { getMangoConfig, setMangoConfig } from "@st-michael/integrations";

describe("WebhooksService amo contact tour sync", () => {
  it("fetches the full contact and clears stale tour fields from a batch webhook", async () => {
    const broker = {
      id: "broker-1",
      fullName: "Broker",
      phone: "+70000000000",
      email: null,
      brokerTourVisited: true,
      brokerTourDate: new Date("2026-07-01T00:00:00.000Z"),
    };
    const prisma = {
      broker: {
        findFirst: jest.fn().mockResolvedValue(broker),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const service = new WebhooksService(prisma as any);
    const getContact = jest.fn().mockResolvedValue({
      id: 701,
      name: "Broker",
      // The fields are absent in the current full contact, which means they
      // were cleared in amoCRM even if a webhook payload contains stale data.
      custom_fields_values: [],
    });
    (service as any).amo = { getContact };
    jest
      .spyOn((service as any).logger, "log")
      .mockImplementation(() => undefined);

    const result = await service.handleAmoContactUpdate(
      {
        contacts: {
          update: [
            {
              id: "701",
              custom_fields_values: [
                { field_id: 842303, values: [{ value: true }] },
              ],
            },
          ],
        },
      },
      {},
    );

    expect(getContact).toHaveBeenCalledWith(701);
    expect(prisma.broker.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          amoContactId: BigInt(701),
          role: "BROKER",
          mergedIntoId: null,
        },
      }),
    );
    expect(prisma.broker.update).toHaveBeenCalledWith({
      where: { id: broker.id },
      data: { brokerTourVisited: false, brokerTourDate: null },
    });
    expect(result).toEqual({
      status: "processed",
      events: 1,
      matched: 1,
      updated: 1,
      unavailable: 0,
    });
  });
});

describe("WebhooksService Mango authentication and call status", () => {
  const apiKey = "test-vpbx-key";
  const apiSalt = "test-vpbx-salt";
  const originalConfig = getMangoConfig();

  const envelope = (
    eventOrRawJson: Record<string, unknown> | string,
    key = apiKey,
    salt = apiSalt,
  ) => {
    const json = typeof eventOrRawJson === "string"
      ? eventOrRawJson
      : JSON.stringify(eventOrRawJson);
    return {
      vpbx_api_key: key,
      sign: crypto
        .createHash("sha256")
        .update(key + json + salt)
        .digest("hex"),
      json,
    };
  };

  const makePrisma = () => ({
    call: {
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn(),
    },
    broker: {
      findFirst: jest.fn(),
    },
  });

  beforeEach(() => {
    setMangoConfig({ apiKey, apiSalt });
  });

  afterAll(() => {
    setMangoConfig(originalConfig);
  });

  it("accepts an official signed form envelope and updates the matching call", async () => {
    const prisma = makePrisma();
    prisma.call.findFirst.mockResolvedValue({
      id: "local-call-1",
      mangoCallId: "command-1",
    });
    const service = new WebhooksService(prisma as any);
    jest.spyOn((service as any).logger, "log").mockImplementation(() => undefined);

    const result = await service.handleMangoCallResult(
      envelope({
        command_id: "command-1",
        call_id: "mango-call-1",
        seq: 4,
        call_state: "Disconnected",
        disconnect_reason: 1100,
        from: { extension: 17, number: "sip:operator@mango.invalid" },
        to: { number: "79991112233" },
        duration: 42,
        recording_url: "https://recordings.invalid/call-1",
      }),
      {},
    );

    expect(prisma.call.findFirst).toHaveBeenCalledWith({
      where: { mangoCallId: "command-1" },
    });
    expect(prisma.call.updateMany).toHaveBeenCalledWith({
      where: {
        id: "local-call-1",
        OR: [
          { mangoEventSeq: null },
          { mangoEventSeq: { lt: 4n } },
        ],
      },
      data: {
        mangoCallId: "command-1",
        mangoEventSeq: 4n,
        status: "COMPLETED",
        durationSec: 42,
        recordingUrl: "https://recordings.invalid/call-1",
      },
    });
    expect(result).toEqual({
      status: "processed",
      callId: "local-call-1",
      action: "updated",
    });
  });

  it("atomically ignores an older or duplicate terminal event by seq", async () => {
    const prisma = makePrisma();
    prisma.call.findFirst.mockResolvedValue({
      id: "local-call-1",
      mangoCallId: "command-1",
      mangoEventSeq: 12n,
      status: "NO_ANSWER",
    });
    // PostgreSQL/Prisma updateMany evaluates the seq predicate atomically. A
    // zero count means another delivery already stored an equal/newer event.
    prisma.call.updateMany.mockResolvedValue({ count: 0 });
    const service = new WebhooksService(prisma as any);
    jest.spyOn((service as any).logger, "log").mockImplementation(() => undefined);

    await expect(
      service.handleMangoCallResult(
        envelope({
          command_id: "command-1",
          call_id: "mango-call-1",
          seq: 11,
          call_state: "Disconnected",
          disconnect_reason: 1100,
          duration: 1,
        }),
        {},
      ),
    ).resolves.toEqual({
      status: "ignored",
      matched: true,
      callId: "local-call-1",
      reason: "stale_or_duplicate_event",
    });
    expect(prisma.call.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "local-call-1",
          OR: [
            { mangoEventSeq: null },
            { mangoEventSeq: { lt: 11n } },
          ],
        },
      }),
    );
  });

  it("rejects an official call-state event without a safe seq", async () => {
    const prisma = makePrisma();
    const service = new WebhooksService(prisma as any);

    await expect(
      service.handleMangoCallResult(
        envelope({
          call_id: "mango-call-1",
          call_state: "Disconnected",
          disconnect_reason: 1100,
        }),
        {},
      ),
    ).resolves.toEqual({
      status: "ignored",
      matched: false,
      reason: "invalid_seq",
    });
    expect(prisma.call.findFirst).not.toHaveBeenCalled();
    expect(prisma.call.updateMany).not.toHaveBeenCalled();
  });

  it("keeps legacy normalized terminal events for INITIATED calls only", async () => {
    const prisma = makePrisma();
    prisma.call.findFirst.mockResolvedValue({
      id: "legacy-local-call",
      mangoCallId: "legacy-call",
      status: "INITIATED",
    });
    const service = new WebhooksService(prisma as any);
    jest.spyOn((service as any).logger, "log").mockImplementation(() => undefined);

    await expect(
      service.handleMangoCallResult(
        envelope({ call_id: "legacy-call", status: "completed", duration: 7 }),
        {},
      ),
    ).resolves.toEqual({
      status: "processed",
      callId: "legacy-local-call",
      action: "updated",
    });
    expect(prisma.call.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "legacy-local-call",
          mangoEventSeq: null,
          status: "INITIATED",
        },
        data: expect.objectContaining({ mangoEventSeq: null, status: "COMPLETED" }),
      }),
    );
  });

  it.each([
    ["missing signature", (valid: any) => ({ ...valid, sign: undefined })],
    ["malformed signature", (valid: any) => ({ ...valid, sign: "abc" })],
    ["invalid signature", (valid: any) => ({ ...valid, sign: "0".repeat(64) })],
  ])("rejects an official envelope with %s", async (_label, mutate) => {
    const prisma = makePrisma();
    const service = new WebhooksService(prisma as any);
    const valid = envelope({ status: "completed", call_id: "call-1" });

    await expect(
      service.handleMangoCallResult(mutate(valid), {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.call.findFirst).not.toHaveBeenCalled();
  });

  it("rejects a mismatched VPBX API key even if that key signed the JSON", async () => {
    const prisma = makePrisma();
    const service = new WebhooksService(prisma as any);

    await expect(
      service.handleMangoCallResult(
        envelope({ status: "completed", call_id: "call-1" }, "wrong-key"),
        {},
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.call.findFirst).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON after validating its official signature", async () => {
    const prisma = makePrisma();
    const service = new WebhooksService(prisma as any);

    await expect(
      service.handleMangoCallResult(envelope("{not-json"), {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.call.findFirst).not.toHaveBeenCalled();
  });

  it("does not treat Mango command result 1000 as a completed call", async () => {
    const prisma = makePrisma();
    const service = new WebhooksService(prisma as any);

    await expect(
      // Whitespace is intentional: signature verification must use this exact
      // string, not a parsed-and-re-serialized representation.
      service.handleMangoCallResult(
        envelope('{ "command_id": "command-ack", "result": 1000 }'),
        {},
      ),
    ).resolves.toEqual({
      status: "ignored",
      matched: false,
      reason: "command_result",
    });
    expect(prisma.call.findFirst).not.toHaveBeenCalled();
    expect(prisma.call.update).not.toHaveBeenCalled();
    expect(prisma.call.updateMany).not.toHaveBeenCalled();
    expect(prisma.call.create).not.toHaveBeenCalled();
  });

  it.each([
    [1100, "COMPLETED"],
    [1110, "COMPLETED"],
    [1120, "COMPLETED"],
    [1111, "NO_ANSWER"],
    [1121, "BUSY"],
    [1122, "UNAVAILABLE"],
    [1124, "UNAVAILABLE"],
    [1130, "UNAVAILABLE"],
    [1134, "UNAVAILABLE"],
    [4207, "UNAVAILABLE"],
    [2001, "FAILED"],
    [3201, "FAILED"],
    [3401, "FAILED"],
    [5001, "FAILED"],
    [5003, "FAILED"],
    [1190, "FAILED"],
  ])(
    "maps official Disconnected reason %i to %s",
    async (disconnectReason, expectedStatus) => {
      const prisma = makePrisma();
      prisma.call.findFirst.mockResolvedValue({
        id: "local-call-1",
        mangoCallId: "command-1",
      });
      const service = new WebhooksService(prisma as any);
      jest.spyOn((service as any).logger, "log").mockImplementation(() => undefined);

      await service.handleMangoCallResult(
        envelope({
          command_id: "command-1",
          call_id: "mango-call-1",
          seq: 8,
          call_state: "Disconnected",
          disconnect_reason: disconnectReason,
          from: { extension: 17 },
          to: { number: "79991112233" },
        }),
        {},
      );

      expect(prisma.call.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            mangoEventSeq: 8n,
            status: expectedStatus,
          }),
        }),
      );
    },
  );

  it.each([
    ["Appeared", "non_terminal_state"],
    ["Connected", "non_terminal_state"],
    ["OnHold", "non_terminal_state"],
  ])("ignores official non-terminal %s events", async (callState, reason) => {
    const prisma = makePrisma();
    const service = new WebhooksService(prisma as any);
    jest.spyOn((service as any).logger, "log").mockImplementation(() => undefined);

    await expect(
      service.handleMangoCallResult(
        envelope({
          command_id: "command-1",
          call_id: "mango-call-1",
          seq: 2,
          call_state: callState,
        }),
        {},
      ),
    ).resolves.toEqual({ status: "ignored", matched: false, reason });
    expect(prisma.call.findFirst).not.toHaveBeenCalled();
    expect(prisma.call.update).not.toHaveBeenCalled();
    expect(prisma.call.updateMany).not.toHaveBeenCalled();
  });

  it("ignores the intermediate Disconnected/1000 callback leg", async () => {
    const prisma = makePrisma();
    const service = new WebhooksService(prisma as any);
    jest.spyOn((service as any).logger, "log").mockImplementation(() => undefined);

    await expect(
      service.handleMangoCallResult(
        envelope({
          command_id: "command-1",
          call_id: "first-technical-leg",
          seq: 3,
          call_state: "Disconnected",
          disconnect_reason: 1000,
        }),
        {},
      ),
    ).resolves.toEqual({
      status: "ignored",
      matched: false,
      reason: "intermediate_leg",
    });
    expect(prisma.call.findFirst).not.toHaveBeenCalled();
    expect(prisma.call.update).not.toHaveBeenCalled();
    expect(prisma.call.updateMany).not.toHaveBeenCalled();
  });

  it("uses nested official phone fields for recent-call correlation", async () => {
    const prisma = makePrisma();
    prisma.call.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "local-call-2", mangoCallId: null });
    prisma.broker.findFirst.mockResolvedValueOnce({ id: "broker-2" });
    const service = new WebhooksService(prisma as any);
    jest.spyOn((service as any).logger, "log").mockImplementation(() => undefined);

    await service.handleMangoCallResult(
      envelope({
        call_id: "mango-call-2",
        seq: 9,
        call_state: "Disconnected",
        disconnect_reason: 1111,
        from: { number: "sip:operator17@node1234567890.invalid" },
        to: { number: "+7 (999) 111-22-33" },
      }),
      {},
    );

    expect(prisma.broker.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.broker.findFirst).toHaveBeenCalledWith({
      where: { phone: { endsWith: "9991112233" } },
    });
    expect(prisma.call.updateMany).toHaveBeenCalledWith({
      where: {
        id: "local-call-2",
        OR: [
          { mangoEventSeq: null },
          { mangoEventSeq: { lt: 9n } },
        ],
      },
      data: expect.objectContaining({
        mangoCallId: "mango-call-2",
        mangoEventSeq: 9n,
        status: "NO_ANSWER",
      }),
    });
  });

  it("ignores an unknown event status instead of coercing it to completed", async () => {
    const prisma = makePrisma();
    const service = new WebhooksService(prisma as any);
    jest.spyOn((service as any).logger, "log").mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);

    await expect(
      service.handleMangoCallResult(
        envelope({ status: "connected_to_operator", call_id: "call-1" }),
        {},
      ),
    ).resolves.toEqual({
      status: "ignored",
      matched: false,
      reason: "unknown_status",
    });
    expect(prisma.call.findFirst).not.toHaveBeenCalled();
    expect(prisma.call.update).not.toHaveBeenCalled();
    expect(prisma.call.updateMany).not.toHaveBeenCalled();
  });

  it("supports the legacy JSON body only with the same SHA-256 formula", async () => {
    const prisma = makePrisma();
    const service = new WebhooksService(prisma as any);
    const event = { result: 1000 };
    const json = JSON.stringify(event);
    const sign = crypto
      .createHash("sha256")
      .update(apiKey + json + apiSalt)
      .digest("hex");

    await expect(
      service.handleMangoCallResult(event, { "x-mango-sign": sign }),
    ).resolves.toEqual({
      status: "ignored",
      matched: false,
      reason: "command_result",
    });
  });

  it("rejects unsigned legacy JSON when Mango credentials are configured", async () => {
    const prisma = makePrisma();
    const service = new WebhooksService(prisma as any);

    await expect(
      service.handleMangoCallResult({ result: 1000 }, {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([
    ["both credentials missing", "", ""],
    ["API key missing", "", apiSalt],
    ["salt missing", apiKey, ""],
  ])("fails closed when %s", async (_label, configuredKey, configuredSalt) => {
    setMangoConfig({ apiKey: configuredKey, apiSalt: configuredSalt });
    const prisma = makePrisma();
    const service = new WebhooksService(prisma as any);

    await expect(
      service.handleMangoCallResult({ result: 1000 }, {}),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.call.findFirst).not.toHaveBeenCalled();
    expect(prisma.call.create).not.toHaveBeenCalled();
  });
});
