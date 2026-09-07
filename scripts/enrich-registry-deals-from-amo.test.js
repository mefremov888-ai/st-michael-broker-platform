const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseSqm,
  parseFloor,
  pickApartmentField,
  planRowUpdate,
} = require("./enrich-registry-deals-from-amo");

test("площадь: запятая, единицы, мусор", () => {
  assert.equal(parseSqm("54,3"), 54.3);
  assert.equal(parseSqm("54.30 м2"), 54.3);
  assert.equal(parseSqm(" 120 "), 120);
  assert.equal(parseSqm("нет"), null);
  assert.equal(parseSqm("0"), null);
  assert.equal(parseSqm(null), null);
});

test("этаж: число, «7 этаж», «7/25», мусор", () => {
  assert.equal(parseFloor("7"), 7);
  assert.equal(parseFloor("7 этаж"), 7);
  assert.equal(parseFloor("12/25"), 12);
  assert.equal(parseFloor("-1"), -1);
  assert.equal(parseFloor("высокий"), null);
  assert.equal(parseFloor("999"), null);
});

test("поле номера квартиры ищется по названию", () => {
  const fields = [
    { id: 1, name: "Этаж", type: "text" },
    { id: 2, name: "№ квартиры", type: "text" },
    { id: 3, name: "Комментарий к квартире", type: "textarea" },
  ];
  assert.equal(pickApartmentField(fields)?.id, 2);
  assert.equal(pickApartmentField([{ id: 9, name: "Дом", type: "text" }]), null);
});

test("план заполняет только пустые поля и ставит object_source=amo", () => {
  const lead = {
    custom_fields_values: [
      { field_id: 604555, values: [{ value: "54,3" }] },
      { field_id: 604551, values: [{ value: "7" }] },
      { field_id: 604547, values: [{ value: "Корпус 2. Gold" }] },
      { field_id: 777, values: [{ value: "190" }] },
    ],
  };
  const plan = planRowUpdate(
    { sqm: null, floor: 3, building: null, apartmentNumber: null },
    lead,
    777,
  );
  assert.deepEqual(plan.fields, ["sqm", "building", "apartmentNumber"]);
  assert.deepEqual(plan.data, {
    sqm: 54.3,
    building: "Корпус 2. Gold",
    apartmentNumber: "190",
    objectSource: "amo",
  });
  // Всё заполнено или лида нет — плана нет.
  assert.equal(
    planRowUpdate(
      { sqm: 1, floor: 1, building: "x", apartmentNumber: "1" },
      lead,
      777,
    ),
    null,
  );
  assert.equal(planRowUpdate({ sqm: null }, null, 777), null);
});
