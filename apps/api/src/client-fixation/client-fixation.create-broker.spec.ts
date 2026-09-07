import { BadRequestException } from "@nestjs/common";
import {
  ClientFixationService,
  brokerPhoneConflict,
} from "./client-fixation.service";

// 2026-09-07 (кейс Кравченко/Климшина): номер занят другой карточкой —
// понятный конфликт вместо «молча уходим на неё».
describe("brokerPhoneConflict", () => {
  it("другой человек на этом номере → конфликт с ФИО и статусом", () => {
    const msg = brokerPhoneConflict(
      { fullName: "Кравченко Наталья Владимировна", status: "PENDING" },
      "Климшина Алена",
    );
    expect(msg).toContain("Кравченко Наталья Владимировна");
    expect(msg).toContain("ожидает активации");
  });
  it("тот же человек с другим написанием ФИО → без конфликта", () => {
    expect(brokerPhoneConflict({ fullName: "Иванов Иван", status: "ACTIVE" }, "Иван Иванов И.")).toBeNull();
    expect(brokerPhoneConflict({ fullName: "Петрова Мария", status: "PENDING" }, "Мария Петрова")).toBeNull();
  });
  it("заблокированная или слитая карточка → конфликт всегда", () => {
    expect(brokerPhoneConflict({ fullName: "Иванов Иван", status: "BLOCKED" }, "Иванов Иван")).toContain("заблокирован");
    expect(brokerPhoneConflict({ fullName: "Иванов Иван", status: "ACTIVE", mergedIntoId: "x" }, "Иванов Иван")).toContain("объединённой");
  });
});

describe("ClientFixationService.createBrokerByCreator", () => {
  const creator = { id: "coord-1", fullName: "Координатор", brokerAgencies: [] };
  const mkService = (existing: any) => {
    const prisma: any = {
      broker: {
        findUnique: jest.fn(async (args: any) =>
          args?.where?.id === "coord-1" ? creator : args?.where?.phone ? existing : null,
        ),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const service = new ClientFixationService(prisma, {} as any, {} as any);
    (service as any).ensureBrokerAmoContact = jest.fn().mockResolvedValue(undefined);
    return service;
  };
  it("возвращает существующую карточку того же человека", async () => {
    const service = mkService({ id: "b1", fullName: "Иванов Иван", phone: "+79990000001", email: null, isCoordinator: false, status: "ACTIVE", mergedIntoId: null });
    const res: any = await service.createBrokerByCreator("coord-1", { fullName: "Иван Иванов", phone: "+79990000001" } as any);
    expect(res.created).toBe(false);
    expect(res.broker.id).toBe("b1");
    expect(res.status).toBe("ACTIVE");
  });
  it("бросает BROKER_PHONE_CONFLICT, если номер занят другим человеком", async () => {
    const service = mkService({ id: "b2", fullName: "Кравченко Наталья", phone: "+79253181467", email: null, isCoordinator: false, status: "PENDING", mergedIntoId: null });
    await expect(
      service.createBrokerByCreator("coord-1", { fullName: "Климшина Алена", phone: "+79253181467" } as any),
    ).rejects.toMatchObject({ response: { code: "BROKER_PHONE_CONFLICT", field: "phone" } });
  });
});
