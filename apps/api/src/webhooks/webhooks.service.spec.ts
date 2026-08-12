import { WebhooksService } from "./webhooks.service";

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
