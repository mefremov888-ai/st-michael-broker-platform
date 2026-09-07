import { cabinetSourceWhere, isHistoricalClient, notHistoricalClientWhere } from "./historical-client";

// hotfix 07.09 (ночь): NOT startsWith отбрасывал строки с comment = NULL —
// брокеры не видели своих клиентов без комментария.
describe("historical-client where", () => {
  it("notHistoricalClientWhere принимает NULL-комментарий", () => {
    expect(notHistoricalClientWhere).toEqual({
      OR: [{ comment: null }, { NOT: { comment: { startsWith: "[old-cabinet:" } } }],
    });
  });
  it("cabinetSourceWhere: new → NULL-safe, old → startsWith, all → пусто", () => {
    expect(cabinetSourceWhere("new")).toEqual(notHistoricalClientWhere);
    expect(cabinetSourceWhere("old")).toEqual({ comment: { startsWith: "[old-cabinet:" } });
    expect(cabinetSourceWhere("all")).toEqual({});
    expect(cabinetSourceWhere(undefined)).toEqual({});
  });
  it("isHistoricalClient", () => {
    expect(isHistoricalClient({ comment: "[old-cabinet:5] x" })).toBe(true);
    expect(isHistoricalClient({ comment: null })).toBe(false);
  });
});
