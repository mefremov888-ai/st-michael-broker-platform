import { SchedulerService } from "./scheduler.service";

describe("SchedulerService.handleBrokerTourContactSync", () => {
  it("batch-syncs canonical brokers without an env-token guard and continues after an update error", async () => {
    const oldAccessToken = process.env.AMO_ACCESS_TOKEN;
    delete process.env.AMO_ACCESS_TOKEN;

    const brokers = [
      {
        id: "broker-1",
        amoContactId: BigInt(101),
        brokerTourVisited: false,
        brokerTourDate: null,
      },
      {
        id: "broker-2",
        amoContactId: BigInt(102),
        brokerTourVisited: false,
        brokerTourDate: null,
      },
      {
        id: "broker-3",
        amoContactId: BigInt(103),
        brokerTourVisited: true,
        brokerTourDate: new Date("2026-07-01T00:00:00.000Z"),
      },
    ];
    const prisma = {
      broker: {
        findMany: jest.fn().mockResolvedValue(brokers),
        update: jest
          .fn()
          .mockRejectedValueOnce(
            new Error("db error containing irrelevant details"),
          )
          .mockResolvedValueOnce({}),
      },
    };
    const service = new SchedulerService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const contacts = new Map<number, any>([
      [
        101,
        {
          id: 101,
          custom_fields_values: [
            { field_id: 842303, values: [{ value: true }] },
            { field_id: 842305, values: [{ value: 1_786_492_800 }] },
          ],
        },
      ],
      [102, { id: 102, custom_fields_values: [] }],
      [103, { id: 103, custom_fields_values: [] }],
    ]);
    const getContactsByIds = jest.fn().mockResolvedValue(contacts);
    (service as any).amo = { getContactsByIds };
    const log = jest
      .spyOn((service as any).logger, "log")
      .mockImplementation(() => undefined);

    try {
      await service.handleBrokerTourContactSync();
    } finally {
      if (oldAccessToken === undefined) delete process.env.AMO_ACCESS_TOKEN;
      else process.env.AMO_ACCESS_TOKEN = oldAccessToken;
    }

    expect(prisma.broker.findMany).toHaveBeenCalledWith({
      where: {
        role: "BROKER",
        mergedIntoId: null,
        amoContactId: { not: null },
      },
      select: {
        id: true,
        amoContactId: true,
        brokerTourVisited: true,
        brokerTourDate: true,
      },
    });
    expect(getContactsByIds).toHaveBeenCalledWith([101, 102, 103]);
    expect(prisma.broker.update).toHaveBeenNthCalledWith(1, {
      where: { id: "broker-1" },
      data: {
        brokerTourVisited: true,
        brokerTourDate: new Date("2026-08-12T00:00:00.000Z"),
      },
    });
    expect(prisma.broker.update).toHaveBeenNthCalledWith(2, {
      where: { id: "broker-3" },
      data: { brokerTourVisited: false, brokerTourDate: null },
    });
    expect(log).toHaveBeenCalledWith(
      "[broker-tour-sync] linked=3 fetched=3 updated=1 missing=0 errors=1",
    );
  });
});
