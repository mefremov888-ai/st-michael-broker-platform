import { AuthService } from "./auth.service";
import { BadRequestException } from "@nestjs/common";

// 2026-09-07: раньше attachAgencyByInn проверял только длину 10–12, и
// 11-значный ИНН проходил — брокер получал агентство, с которым потом не мог
// фиксировать клиентов. Теперь строго 10 или 12 цифр (как в форме фиксации).
describe("AuthService.attachAgencyByInn INN validation", () => {
  const makeService = () => {
    const prisma = {
      agency: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      brokerAgency: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const service = new AuthService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
    );
    // amo-адаптер и профиль-синк в этом тесте не по делу — стабы.
    (service as any).amo = {
      findCompanyByInn: jest.fn().mockResolvedValue(null),
      createCompany: jest.fn().mockResolvedValue(null),
    };
    (service as any).syncBrokerProfileToAmo = jest
      .fn()
      .mockResolvedValue(undefined);
    return { service, prisma };
  };

  it("отклоняет 11-значный ИНН с русской ошибкой (дыра закрыта)", async () => {
    const { service, prisma } = makeService();

    await expect(
      service.attachAgencyByInn("broker-1", "12345678901"),
    ).rejects.toMatchObject({
      constructor: BadRequestException,
      message: "ИНН должен содержать 10 или 12 цифр",
    });
    expect(prisma.agency.findUnique).not.toHaveBeenCalled();
    expect(prisma.brokerAgency.create).not.toHaveBeenCalled();
  });

  it.each(["123", "12345678901234"])(
    "отклоняет ИНН неверной длины: %s",
    async (inn) => {
      const { service } = makeService();
      await expect(
        service.attachAgencyByInn("broker-1", inn),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it.each(["7712345678", "771234567890"])(
    "принимает валидный ИНН (%s) и привязывает агентство",
    async (inn) => {
      const { service, prisma } = makeService();
      const agency = { id: `agency-${inn}`, name: "Agency", inn };
      prisma.agency.findUnique.mockResolvedValue(agency);

      const result = await service.attachAgencyByInn("broker-1", inn);

      expect(result).toEqual({
        agency: { id: agency.id, name: agency.name, inn },
      });
      expect(prisma.brokerAgency.create).toHaveBeenCalledWith({
        data: { brokerId: "broker-1", agencyId: agency.id, isPrimary: true },
      });
    },
  );

  it("replacePrimaryAgencyByInn тоже отклоняет 11-значный ИНН", async () => {
    const { service } = makeService();
    await expect(
      service.replacePrimaryAgencyByInn("broker-1", "12345678901"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
