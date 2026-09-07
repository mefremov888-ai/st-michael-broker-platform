import { ClientFixationService } from "./client-fixation.service";

describe("ClientFixationService.getClients", () => {
  let prisma: any;
  let service: ClientFixationService;

  beforeEach(() => {
    prisma = {
      client: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    service = new ClientFixationService(prisma, {} as any, {} as any);
  });

  it("scopes a broker to own and responsible clients", async () => {
    await service.getClients("broker-1", {});
    expect(prisma.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [{ brokerId: "broker-1" }, { responsibleBrokerId: "broker-1" }],
        },
      }),
    );
  });

  it("lets staff see every fixation uniqueness row", async () => {
    await service.getClients("admin-1", { asStaff: true });
    expect(prisma.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {},
      }),
    );
  });

  it("lets staff filter uniqueness rows to one broker", async () => {
    await service.getClients("admin-1", { asStaff: true, brokerId: "broker-9" });
    expect(prisma.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [{ brokerId: "broker-9" }, { responsibleBrokerId: "broker-9" }],
        },
      }),
    );
  });
});
