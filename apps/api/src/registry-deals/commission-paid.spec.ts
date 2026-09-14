import { parseCommissionPaid } from "./commission-paid";

/**
 * Примеры взяты из живого листа (выгрузка 14.09.2026): в колонке «выплачено»
 * 29 разных написаний, и в части ячеек рядом со словом дописана сумма.
 */
describe("колонка «выплачено» из листа сделок", () => {
  it("простое «да»", () => {
    expect(parseCommissionPaid("да")).toEqual({ paid: true, amount: null, raw: "да" });
  });

  it("«Да» с заглавной и «оплачено»", () => {
    expect(parseCommissionPaid("Да").paid).toBe(true);
    expect(parseCommissionPaid("оплачено").paid).toBe(true);
  });

  it("«нет» — явно не выплачено", () => {
    expect(parseCommissionPaid("нет").paid).toBe(false);
  });

  it("«не оплачено» не путается с «оплачено»", () => {
    expect(parseCommissionPaid("не оплачено").paid).toBe(false);
  });

  it("сумма, дописанная рядом со словом: «669 138 да»", () => {
    const r = parseCommissionPaid("669 138 да");
    expect(r.paid).toBe(true);
    expect(r.amount).toBe(669138);
  });

  it("сумма с копейками через запятую: «743 477,94 да»", () => {
    const r = parseCommissionPaid("743 477,94 да");
    expect(r.paid).toBe(true);
    expect(r.amount).toBeCloseTo(743477.94, 2);
  });

  it("несколько сумм — берём наибольшую", () => {
    const r = parseCommissionPaid("оплачен 623360,72 648804,2");
    expect(r.paid).toBe(true);
    expect(r.amount).toBeCloseTo(648804.2, 2);
  });

  it("пустая ячейка — ничего не знаем", () => {
    expect(parseCommissionPaid("")).toEqual({ paid: null, amount: null, raw: null });
    expect(parseCommissionPaid(null)).toEqual({ paid: null, amount: null, raw: null });
  });

  it("непонятный текст сохраняем, но выводов не делаем", () => {
    const r = parseCommissionPaid("уточняется у бухгалтерии");
    expect(r.paid).toBeNull();
    expect(r.amount).toBeNull();
    expect(r.raw).toBe("уточняется у бухгалтерии");
  });
});
