import {
  brokerTourSnapshotFromAmoContact,
  buildBrokerTourUpdate,
  extractAmoContactIds,
  parseAmoCheckbox,
  parseAmoDate,
} from "./broker-tour-sync";

describe("broker tour amo sync helpers", () => {
  it.each([true, 1, "1", " true ", "YES", "Да", "on"])(
    "parses truthy checkbox value %p",
    (value) => {
      expect(parseAmoCheckbox(value)).toBe(true);
    },
  );

  it.each([false, 0, null, undefined, "", "0", "false", "нет"])(
    "parses false checkbox value %p",
    (value) => {
      expect(parseAmoCheckbox(value)).toBe(false);
    },
  );

  it("parses amo Unix seconds, milliseconds and textual dates", () => {
    expect(parseAmoDate(1_786_492_800)?.toISOString()).toBe(
      "2026-08-12T00:00:00.000Z",
    );
    expect(parseAmoDate("1786492800000")?.toISOString()).toBe(
      "2026-08-12T00:00:00.000Z",
    );
    expect(parseAmoDate("12.08.2026")?.toISOString()).toBe(
      "2026-08-12T00:00:00.000Z",
    );
    expect(parseAmoDate("not-a-date")).toBeNull();
    expect(parseAmoDate("31.02.2026")).toBeNull();
  });

  it("extracts the two tour fields from a full amo contact", () => {
    const result = brokerTourSnapshotFromAmoContact({
      custom_fields_values: [
        { field_id: 842303, values: [{ value: true }] },
        { field_id: "842305", values: [{ value: 1_786_492_800 }] },
      ],
    });

    expect(result.brokerTourVisited).toBe(true);
    expect(result.brokerTourDate?.toISOString()).toBe(
      "2026-08-12T00:00:00.000Z",
    );
  });

  it("treats absent amo fields as cleared source-of-truth values", () => {
    expect(
      brokerTourSnapshotFromAmoContact({ custom_fields_values: [] }),
    ).toEqual({
      brokerTourVisited: false,
      brokerTourDate: null,
    });
  });

  it("returns no update for an idempotent sync and clears stale values", () => {
    const date = new Date("2026-08-12T00:00:00.000Z");
    expect(
      buildBrokerTourUpdate(
        { brokerTourVisited: true, brokerTourDate: date },
        { brokerTourVisited: true, brokerTourDate: new Date(date) },
      ),
    ).toBeNull();

    expect(
      buildBrokerTourUpdate(
        { brokerTourVisited: true, brokerTourDate: date },
        { brokerTourVisited: false, brokerTourDate: null },
      ),
    ).toEqual({ brokerTourVisited: false, brokerTourDate: null });
  });

  it("extracts and deduplicates contact ids from amo batch and direct payloads", () => {
    expect(
      extractAmoContactIds({
        id: "42",
        contacts: {
          update: [{ id: "41" }, { id: 42 }],
          add: { 0: { id: "43" }, 1: { id: "invalid" } },
        },
      }),
    ).toEqual([41, 42, 43]);
  });
});
