import {
  AMO_PIPELINES,
  leadToProject,
  pipelineToProject,
} from "../../../../packages/integrations/src/amo-crm.fields";

// 2026-09-07 (решение владельца): Толбухина — отдельный ЖК; воронка
// Толбухиной больше не относится к Зорге 9.
describe("amo pipeline/lead → project", () => {
  it("pipelineToProject: три ЖК; Колл-центр → UNKNOWN («Не указан»); прочие → ZORGE9", () => {
    expect(pipelineToProject(AMO_PIPELINES.ZORGE9)).toBe("ZORGE9");
    expect(pipelineToProject(AMO_PIPELINES.BERZARINA)).toBe("SILVER_BOR");
    expect(pipelineToProject(AMO_PIPELINES.TOLBUKHINA)).toBe("TOLBUKHINA");
    expect(pipelineToProject(AMO_PIPELINES.KC)).toBe("UNKNOWN");
    expect(pipelineToProject(0)).toBe("ZORGE9");
  });

  it("leadToProject: текст «Объект интереса» важнее воронки", () => {
    const lead = (pipeline: number, value?: string) => ({
      pipeline_id: pipeline,
      custom_fields_values: value
        ? [{ field_name: "Объект интереса", values: [{ value }] }]
        : [],
    });
    expect(leadToProject(lead(AMO_PIPELINES.TOLBUKHINA))).toBe("TOLBUKHINA");
    expect(leadToProject(lead(AMO_PIPELINES.KC, "ЖК Толбухина 3"))).toBe("TOLBUKHINA");
    expect(leadToProject(lead(AMO_PIPELINES.KC, "Берзарина 37"))).toBe("SILVER_BOR");
    expect(leadToProject(lead(AMO_PIPELINES.TOLBUKHINA, "Зорге 9"))).toBe("ZORGE9");
    expect(leadToProject(lead(AMO_PIPELINES.KC))).toBe("UNKNOWN");
  });
});
