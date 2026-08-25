import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AGENCY_CALL_RESULT_OPTIONS,
  AGENCY_CALL_RESULTS,
  BROKER_CALL_RESULT_OPTIONS,
  BROKER_CALL_RESULTS,
  LOYALTY_CALL_RESULT_CATALOG,
  getLoyaltyCallResultPresentation,
  getLoyaltyList,
  getActiveLoyaltyLinks,
  formatRubles,
  hasLoyaltyActivityEvidence,
  loyaltyLeaderMode,
  loyaltyMetricsForDisplay,
  normalizeActiveLinks,
  normalizeImportResult,
  normalizeLoyaltyDetail,
  normalizeLoyaltyList,
  normalizeLoyaltyOverview,
  normalizeReconciliation,
  publishAnnaImport,
  selectLoyaltyLeader,
  stageAnnaImport,
  unlinkActiveLoyaltyLink,
} from "./loyalty-base-api";
import {
  emptyLoyaltyFilters,
  formatLoyaltyMetricExplanation,
  loyaltyMetricPeriodLabel,
  toCanonicalFilter,
} from "./loyalty-ui-model";
import {
  loyaltyRecordStatuses,
  loyaltyStatusBadgeColor,
  loyaltyStatusDotColor,
  loyaltyStatusLabel,
} from "./loyalty-status";
import {
  agencyContactPointsPatch,
  agencyContactPersonRoleValue,
  getLoyaltyCampaign,
  getLoyaltyCampaigns,
  exportLoyaltyCampaign,
  localDateTimeInputToIso,
  toLocalDateInput,
  toLocalDateTimeInput,
} from "./loyalty-workflow-api";

test("keeps broker and agency call-result dictionaries separate and removes the obsolete reached field", () => {
  const brokerCodes = new Set<string>(
    BROKER_CALL_RESULTS.map(([code]) => code),
  );
  const agencyCodes = new Set<string>(
    AGENCY_CALL_RESULTS.map(([code]) => code),
  );

  assert.equal(brokerCodes.has("NOT_A_BROKER"), true);
  assert.equal(agencyCodes.has("NOT_A_BROKER"), false);
  assert.equal(agencyCodes.has("COOPERATION_AGREED"), true);
  assert.equal(brokerCodes.has("COOPERATION_AGREED"), false);
  assert.equal(
    [...BROKER_CALL_RESULTS, ...AGENCY_CALL_RESULTS].some(([, label]) =>
      label.includes("Дозвонились"),
    ),
    false,
  );
});

test("keeps call-result API codes and context labels backward compatible", () => {
  assert.deepEqual(BROKER_CALL_RESULTS, [
    ["INFORMED", "Проинформирован"],
    ["DO_NOT_CALL", "Просил не звонить"],
    ["NOT_INTERESTED", "Неинтересно"],
    ["NO_ANSWER", "НДЗ"],
    ["SEND_INFORMATION", "Просил отправить информацию"],
    ["BROKER_TOUR_BOOKED", "Запись на БТ"],
    ["BROKER_TOUR_DECLINED", "Отказ от БТ"],
    ["INVALID_PHONE", "Некорректный номер"],
    ["NOT_A_BROKER", "Уже не брокер"],
  ]);
  assert.deepEqual(AGENCY_CALL_RESULTS, [
    ["NO_ANSWER", "НДЗ"],
    ["COOPERATION_DECLINED", "Отказ от сотрудничества"],
    ["BROKER_TOUR_SCHEDULED", "Назначен БТ"],
    ["CALLBACK", "Перезвонить"],
    ["SEND_INFORMATION", "Отправить информацию"],
    ["AGREEMENTS_EXIST", "Есть договорённости"],
    ["COOPERATION_AGREED", "Договорились о сотрудничестве"],
  ]);
});

test("defines one complete typed catalog with stable call-result tones", () => {
  const expectedTones = {
    INFORMED: "informational",
    DO_NOT_CALL: "negative",
    NOT_INTERESTED: "negative",
    NO_ANSWER: "unreached",
    SEND_INFORMATION: "follow_up",
    BROKER_TOUR_BOOKED: "positive",
    BROKER_TOUR_DECLINED: "negative",
    INVALID_PHONE: "invalid",
    NOT_A_BROKER: "invalid",
    COOPERATION_DECLINED: "negative",
    BROKER_TOUR_SCHEDULED: "positive",
    CALLBACK: "follow_up",
    AGREEMENTS_EXIST: "positive",
    COOPERATION_AGREED: "positive",
  } as const;

  assert.deepEqual(
    Object.fromEntries(
      Object.entries(LOYALTY_CALL_RESULT_CATALOG).map(([code, value]) => [
        code,
        value.tone,
      ]),
    ),
    expectedTones,
  );
  assert.deepEqual(
    [...BROKER_CALL_RESULT_OPTIONS, ...AGENCY_CALL_RESULT_OPTIONS]
      .filter(
        (option, index, all) =>
          all.findIndex(({ code }) => code === option.code) === index,
      )
      .map(({ code }) => code)
      .sort(),
    Object.keys(LOYALTY_CALL_RESULT_CATALOG).sort(),
  );
  for (const [code, definition] of Object.entries(
    LOYALTY_CALL_RESULT_CATALOG,
  )) {
    assert.equal(definition.code, code);
    assert.ok(Object.keys(definition.labels).length > 0);
  }
});

test("resolves context labels and fails visibly neutral for unknown or cross-context codes", () => {
  assert.deepEqual(
    getLoyaltyCallResultPresentation("SEND_INFORMATION", "brokers"),
    {
      code: "SEND_INFORMATION",
      label: "Просил отправить информацию",
      tone: "follow_up",
      known: true,
    },
  );
  assert.deepEqual(
    getLoyaltyCallResultPresentation("SEND_INFORMATION", "agencies"),
    {
      code: "SEND_INFORMATION",
      label: "Отправить информацию",
      tone: "follow_up",
      known: true,
    },
  );
  assert.deepEqual(
    getLoyaltyCallResultPresentation("NOT_A_BROKER", "agencies"),
    {
      code: "NOT_A_BROKER",
      label: "NOT_A_BROKER",
      tone: "neutral",
      known: false,
    },
  );
  assert.deepEqual(
    getLoyaltyCallResultPresentation("LEGACY_UNKNOWN", "brokers"),
    {
      code: "LEGACY_UNKNOWN",
      label: "LEGACY_UNKNOWN",
      tone: "neutral",
      known: false,
    },
  );
  assert.equal(getLoyaltyCallResultPresentation("", "brokers"), null);
});

test("uses the shared accessible call-result badge on every V2 result surface", () => {
  const source = (relativePath: string) =>
    readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const badge = source(
    "../components/loyalty-base/LoyaltyCallResultBadge.tsx",
  );
  const consumers = [
    "../components/loyalty-base/LoyaltyFilterPanel.tsx",
    "../components/loyalty-base/LoyaltyQueuePanel.tsx",
    "../components/loyalty-base/LoyaltyRecordDetailV2.tsx",
    "../components/loyalty-base/LoyaltyBaseWorkspaceV2.tsx",
    "../components/loyalty-base/LoyaltyCampaignDashboard.tsx",
  ];

  for (const relativePath of consumers) {
    assert.match(source(relativePath), /LoyaltyCallResultBadge/);
  }
  assert.match(
    source("../components/loyalty-base/LoyaltyRecordDetailV2.tsx"),
    /result=\{item\.result\}/,
  );
  assert.match(badge, /aria-label=\{`Результат звонка:/);
  assert.match(badge, /aria-hidden="true"/);
  assert.match(badge, /data-call-result-tone=\{tone\}/);
  assert.doesNotMatch(badge, /(?:bg|text|border)-\$\{/);
  for (const className of [
    "border-emerald-300 bg-emerald-50 text-emerald-900",
    "border-blue-300 bg-blue-50 text-blue-900",
    "border-amber-300 bg-amber-50 text-amber-950",
    "border-slate-300 bg-slate-100 text-slate-800",
    "border-red-300 bg-red-50 text-red-900",
    "border-orange-300 bg-orange-50 text-orange-900",
  ]) {
    assert.match(badge, new RegExp(className.replace(/\//g, "\\/")));
  }
  assert.doesNotMatch(
    source("../components/loyalty-base/LoyaltyBaseWorkspaceV2.tsx"),
    /item\.lastCallResult\s*\|\|/,
  );
  assert.doesNotMatch(
    source("../components/loyalty-base/LoyaltyCampaignDashboard.tsx"),
    /item\.lastResult\s*\|\|/,
  );
});

test("formats a complete hover explanation without hiding inclusion rules", () => {
  assert.equal(
    formatLoyaltyMetricExplanation({
      formula: "COUNT(included DEAL events)",
      period: "август 2026",
      source: "SOURCE_AGGREGATE",
      exactness: "SOURCE_DECLARED",
      includedSemantics: "только известные значения",
      excludedSemantics: "null не превращается в ноль",
    }),
    [
      "Формула: COUNT(included DEAL events)",
      "Период: август 2026",
      "Источник: SOURCE_AGGREGATE",
      "Точность: SOURCE_DECLARED",
      "Включено: только известные значения",
      "Не включено: null не превращается в ноль",
    ].join("\n"),
  );
});

test("marks snapshot metrics whose selected period is not applied", () => {
  assert.equal(
    loyaltyMetricPeriodLabel("текущий месяц", false),
    "снимок / весь период источника; выбранный период не применяется",
  );
  assert.equal(
    loyaltyMetricPeriodLabel("текущий месяц", true),
    "текущий месяц",
  );
  assert.equal(
    loyaltyMetricPeriodLabel("текущий месяц", null),
    "текущий месяц",
  );
});

test("builds independent canonical filters for brokers and agencies", () => {
  const broker = emptyLoyaltyFilters();
  broker.specialization = "Вторичка";
  broker.geography = "REGION";
  broker.status = "TOP_SELLER";
  broker.agencySize = "Крупное";
  broker.activityFrom = "2026-04-01";
  broker.activityTo = "2026-06-30";
  broker.meetingsMin = "2";
  broker.meetingsMax = "5";
  const brokerFilter = toCanonicalFilter(broker, "brokers");
  assert.deepEqual(brokerFilter.specializations, ["Вторичка"]);
  assert.deepEqual(brokerFilter.geography, ["REGION"]);
  assert.deepEqual(brokerFilter.brokerStatuses, ["TOP_SELLER"]);
  assert.equal(brokerFilter.agencySizes, undefined);
  assert.deepEqual(brokerFilter.activityPeriod, {
    from: "2026-04-01",
    to: "2026-06-30",
  });
  assert.deepEqual(brokerFilter.meetings, { min: 2, max: 5 });

  const agency = emptyLoyaltyFilters();
  agency.includeLowSignal = true;
  agency.status = "VIP_PARTNER";
  agency.agencySize = "Крупное";
  agency.projectsOnSite = "IN_PROGRESS";
  agency.specialTermsProposed = "true";
  agency.dataQuality = "NEEDS_COMPLETION";
  agency.specialization = "Вторичка";
  const agencyFilter = toCanonicalFilter(agency, "agencies");
  assert.deepEqual(agencyFilter.brokerStatuses, ["VIP_PARTNER"]);
  assert.equal(agencyFilter.partnershipStatuses, undefined);
  assert.deepEqual(agencyFilter.agencySizes, ["Крупное"]);
  assert.deepEqual(agencyFilter.projectsOnSite, ["IN_PROGRESS"]);
  assert.equal(agencyFilter.specialTermsProposed, true);
  assert.deepEqual(agencyFilter.dataQuality, ["NEEDS_COMPLETION"]);
  assert.equal(agencyFilter.specializations, undefined);
  assert.equal(agencyFilter.includeLowSignal, true);
});

test("round-trips browser-local date and datetime controls without a timezone shift", () => {
  const local = new Date(2026, 7, 24, 16, 25, 0, 0);
  assert.equal(toLocalDateTimeInput(local), "2026-08-24T16:25");
  assert.equal(toLocalDateInput(local), "2026-08-24");
  assert.equal(
    localDateTimeInputToIso("2026-08-24T16:25"),
    local.toISOString(),
  );
});

test("omits contactPoints entirely for a contact-person name-only edit", () => {
  const exactPoints = [{ id: "point-1", type: "PHONE", value: "+79990000001" }];
  const patch = agencyContactPointsPatch({
    isNew: false,
    initialPhones: "+79990000001",
    initialEmails: "",
    phones: "+79990000001",
    emails: "",
    contactPoints: exactPoints,
  });
  assert.deepEqual(patch, {});
  assert.equal("contactPoints" in patch, false);
});

test("keeps an explicitly cleared contact-person role on update", () => {
  assert.equal(agencyContactPersonRoleValue({ isNew: false, role: "   " }), "");
  assert.equal(
    agencyContactPersonRoleValue({ isNew: true, role: "   " }),
    undefined,
  );
  assert.equal(
    agencyContactPersonRoleValue({ isNew: false, role: "  Руководитель  " }),
    "Руководитель",
  );
});

test("treats exact activity mode as evidence without an optional count and requires rows for local preliminary mode", () => {
  const source = (kind: string, contributingRecords: number | null) => ({
    kind,
    label: "",
    quality: "",
    exactness: kind === "EXACT_ACTIVITIES" ? "EXACT" : "APPROXIMATE",
    ruleVersion: "v1",
    periodFilterApplied: true,
    contributingRecords,
    sourceVersions: [],
  });

  assert.equal(
    hasLoyaltyActivityEvidence(source("EXACT_ACTIVITIES", null)),
    true,
  );
  assert.equal(
    hasLoyaltyActivityEvidence(source("LOCAL_PRELIMINARY", 2)),
    true,
  );
  assert.equal(
    hasLoyaltyActivityEvidence(source("LOCAL_PRELIMINARY", 0)),
    false,
  );
  assert.equal(hasLoyaltyActivityEvidence(source("UNAVAILABLE", 10)), false);
});

test("shows OUR local leaders as preliminary without weakening Anna exact-only leaders", () => {
  assert.equal(
    loyaltyLeaderMode("ours", "LOCAL_PRELIMINARY"),
    "LOCAL_PRELIMINARY",
  );
  assert.equal(loyaltyLeaderMode("anna", "LOCAL_PRELIMINARY"), "UNAVAILABLE");
  assert.equal(loyaltyLeaderMode("anna", "SOURCE_AGGREGATE"), "UNAVAILABLE");
  assert.equal(loyaltyLeaderMode("anna", "EXACT_ACTIVITIES"), "EXACT");
});

test("uses selected-period table metrics without backfilling unknowns from lifetime", () => {
  const record = normalizeLoyaltyDetail(
    {
      item: {
        id: "period-table-metrics",
        entityType: "BROKER",
        metrics: {
          fixations: 99,
          meetings: 88,
          deals: 77,
          dealAmount: "7700",
        },
        metricSource: {
          kind: "SOURCE_AGGREGATE",
          exactness: "APPROXIMATE",
        },
        periodMetrics: {
          availability: "LOCAL_PRELIMINARY",
          fixations: 2,
          meetings: null,
          deals: 1,
          dealAmount: null,
        },
      },
    },
    "brokers",
  );
  assert.deepEqual(loyaltyMetricsForDisplay(record), {
    fixations: 2,
    meetings: null,
    deals: 1,
    dealAmount: null,
    selectedPeriod: true,
    availability: "LOCAL_PRELIMINARY",
    label: "За выбранный период · предварительно",
  });

  record.periodMetrics!.availability = "UNAVAILABLE";
  assert.deepEqual(loyaltyMetricsForDisplay(record), {
    fixations: 99,
    meetings: 88,
    deals: 77,
    dealAmount: "7700",
    selectedPeriod: false,
    availability: "UNAVAILABLE",
    label: "Точные метрики недоступны",
  });
});

test("prefers exact leaders and only falls back to source leaders for an explicit rollup mode", () => {
  const exact = {
    id: "exact",
    name: "Точный лидер",
    deals: 2,
    dealAmount: "200",
  };
  const source = {
    id: "source",
    name: "Лидер среза",
    deals: 20,
    dealAmount: "2000",
  };

  assert.deepEqual(selectLoyaltyLeader(exact, source, "EXACT_ACTIVITIES"), {
    leader: exact,
    usesSource: false,
  });
  assert.deepEqual(selectLoyaltyLeader(null, source, "UNAVAILABLE"), {
    leader: source,
    usesSource: true,
  });
  assert.deepEqual(selectLoyaltyLeader(null, source, "EXACT_ACTIVITIES"), {
    leader: null,
    usesSource: false,
  });
  assert.deepEqual(selectLoyaltyLeader(null, source, ""), {
    leader: null,
    usesSource: false,
  });
});

test("normalizes the strict overview envelope without turning unavailable birthdays into zero", () => {
  const result = normalizeLoyaltyOverview(
    {
      base: "anna",
      period: {
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-08-31T23:59:59.999Z",
      },
      snapshot: {
        id: "snapshot-1",
        publishedAt: "2026-08-18T08:00:00.000Z",
        ruleVersion: "v1",
      },
      brokers: {
        total: 12,
        notCalledCurrentMonth: 4,
        newCount: 3,
        btWithoutFixation: 2,
        birthdaysToday: null,
        top: [
          {
            id: "broker-1",
            name: "Тестовый брокер",
            entityType: "BROKER",
            deals: 2,
            dealAmount: "1500000.50",
          },
        ],
      },
      agencies: {
        total: 5,
        top: [
          {
            id: "agency-1",
            name: "Тестовое агентство",
            entityType: "AGENCY",
            deals: 7,
            dealAmount: "8500000",
          },
        ],
      },
      activities: { fixations: 9, meetings: 6, deals: 4 },
      dealAmount: "10000000.50",
      metricSource: {
        kind: "UNAVAILABLE",
        exactness: "UNKNOWN",
        periodFilterApplied: false,
      },
      sourceReportedSummary: {
        kind: "SOURCE_AGGREGATE",
        label: "Срез Анны 17.08.2026",
        confirmationStatus: "NOT_CONFIRMED",
        quality: "SOURCE_REPORTED",
        exactness: ["UNKNOWN"],
        sourceVersions: ["ANNA_CURATED:2026-08-17"],
        periodFilterApplied: false,
        brokers: {
          records: 12,
          fixations: 9,
          meetings: 6,
          deals: 4,
          dealAmount: "10000000.50",
          top: [],
        },
        agencies: {
          records: 5,
          fixations: 0,
          meetings: 7,
          deals: 2,
          dealAmount: "9000000",
          top: [],
        },
      },
    },
    "anna",
  );

  assert.equal(result.birthdaysToday, null);
  assert.equal(result.newBrokers, 3);
  assert.equal(result.topBroker?.name, "Тестовый брокер");
  assert.equal(result.topBroker?.dealAmount, "1500000.50");
  assert.equal(result.dealAmount, "10000000.50");
  assert.equal(result.metricSource?.kind, "UNAVAILABLE");
  assert.equal(result.sourceReportedSummary?.brokers.fixations, 9);
  assert.equal(result.sourceReportedSummary?.agencies.dealAmount, "9000000");
  assert.equal(result.sourceReportedSummary?.periodFilterApplied, false);
});

test("preserves unavailable Anna KPI values as null instead of a false zero", () => {
  const result = normalizeLoyaltyOverview(
    {
      base: "anna",
      brokers: {
        total: 6670,
        notCalledCurrentMonth: null,
        newCount: null,
        btWithoutFixation: null,
        birthdaysToday: null,
      },
      agencies: { total: 202 },
      activities: { fixations: null, meetings: null, deals: null },
    },
    "anna",
  );

  assert.equal(result.notCalledCurrentMonth, null);
  assert.equal(result.newBrokers, null);
  assert.equal(result.btWithoutFixation, null);

  const omitted = normalizeLoyaltyOverview(
    { base: "anna", brokers: { total: 6670 }, agencies: { total: 202 } },
    "anna",
  );
  assert.equal(omitted.notCalledCurrentMonth, null);
  assert.equal(omitted.newBrokers, null);
  assert.equal(omitted.btWithoutFixation, null);
  assert.equal(omitted.birthdaysToday, null);
});

test("normalizes ANNA list/detail fields returned by the service", () => {
  const backendItem = {
    id: "person-opaque-1",
    sourceRecordId: "source-record-1",
    entityType: "BROKER",
    displayName: "Тестовый брокер",
    city: "Тестовый город",
    archivedAt: "2026-08-17T00:00:00.000Z",
    attributes: {
      crm: { birthday: "18.08" },
      relationshipStage: "Активный",
      workFormat: "Частный брокер",
      specialization: ["Первичная недвижимость"],
    },
    contactPoints: [
      {
        id: "point-1",
        type: "EMAIL",
        value: "test@example.invalid",
        maskedValue: "t***@example.invalid",
        isPrimary: true,
      },
      {
        id: "point-2",
        type: "PHONE",
        value: "+70000000001",
        maskedValue: "+7***01",
        isPrimary: true,
      },
    ],
    externalIdentities: [
      { system: "AMOCRM", entityType: "CONTACT", externalId: "1001" },
    ],
    metrics: {
      fixations: 6,
      meetings: 4,
      deals: 3,
      dealAmount: "12500000.75",
      calls: 2,
      brokerTours: 1,
    },
    agencies: [
      {
        id: "agency-1",
        displayName: "Тестовое агентство",
        role: "BROKER",
        isPrimary: true,
      },
    ],
    activities: [
      {
        id: "activity-1",
        type: "CALL",
        occurredAt: "2026-08-16T12:00:00.000Z",
        verdict: "COMPLETED",
        reasonCode: "FOLLOW_UP",
      },
    ],
    provenance: [
      {
        id: "field-1",
        fieldName: "displayName",
        sourceSystem: "ANNA_FILE",
        observedAt: "2026-08-17T12:00:00.000Z",
      },
    ],
  };

  const list = normalizeLoyaltyList(
    {
      base: "anna",
      entityType: "BROKER",
      items: [backendItem],
      page: 1,
      pageSize: 30,
      total: 1,
      totalPages: 1,
    },
    "anna",
    "brokers",
    1,
    30,
  );
  const item = list.items[0];

  assert.equal(list.entityType, "brokers");
  assert.equal(item.name, "Тестовый брокер");
  assert.equal(item.company, "Тестовое агентство");
  assert.equal(item.phone, "+70000000001");
  assert.equal(item.email, "test@example.invalid");
  assert.equal(item.fixations, 6);
  assert.equal(item.meetings, 4);
  assert.equal(item.deals, 3);
  assert.equal(item.dealAmount, "12500000.75");
  assert.equal(item.archived, true);
  assert.equal(item.hasAmo, true);
  assert.equal(
    item.amoContactUrl,
    "https://stmichael.amocrm.ru/contacts/detail/1001",
  );
  assert.equal(item.birthday, "18.08");
  assert.equal(item.stage, "Активный");
  assert.equal(item.lastCallAt, "2026-08-16T12:00:00.000Z");
  assert.equal(item.history[0].title, "FOLLOW_UP");
  assert.deepEqual(item.provenance[0], {
    field: "displayName",
    source: "ANNA_FILE",
    updatedAt: "2026-08-17T12:00:00.000Z",
  });

  const detail = normalizeLoyaltyDetail(
    { base: "anna", entityType: "BROKER", item: backendItem },
    "brokers",
  );
  assert.equal(detail.name, "Тестовый брокер");
  assert.equal(detail.history.length, 1);
});

test("retains, deduplicates and displays every backend computed status in order", () => {
  const record = normalizeLoyaltyDetail(
    {
      item: {
        id: "multi-status-broker",
        entityType: "BROKER",
        displayName: "Брокер с БТ",
        status: "LEGACY_STATUS_MUST_NOT_REPLACE_COMPUTED",
        computedStatuses: [
          "SELLER",
          "BROKER_TOUR",
          "SELLER",
          "  FUTURE_BACKEND_STATUS  ",
          "",
        ],
      },
    },
    "brokers",
  );

  assert.equal(record.status, "SELLER");
  assert.deepEqual(record.computedStatuses, [
    "SELLER",
    "BROKER_TOUR",
    "FUTURE_BACKEND_STATUS",
  ]);
  assert.deepEqual(loyaltyRecordStatuses(record), [
    "SELLER",
    "BROKER_TOUR",
    "FUTURE_BACKEND_STATUS",
  ]);
  assert.equal(loyaltyStatusLabel("BROKER_TOUR"), "Был на БТ");
  assert.equal(
    loyaltyStatusBadgeColor("BROKER_TOUR"),
    "bg-yellow-100 text-yellow-800",
  );
  assert.equal(loyaltyStatusDotColor("BROKER_TOUR"), "bg-yellow-400");
});

test("falls back to the legacy scalar status when computedStatuses is absent", () => {
  const record = normalizeLoyaltyDetail(
    {
      item: {
        id: "legacy-status-broker",
        entityType: "BROKER",
        displayName: "Старая запись",
        attributes: { status: "LEGACY_ACTIVE" },
      },
    },
    "brokers",
  );

  assert.equal(record.status, "LEGACY_ACTIVE");
  assert.deepEqual(record.computedStatuses, ["LEGACY_ACTIVE"]);
  assert.deepEqual(loyaltyRecordStatuses(record), ["LEGACY_ACTIVE"]);
});

test("keeps V2 table, detail, filter and legend on the shared multi-status contract", () => {
  const source = (relativePath: string) =>
    readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const table = source(
    "../components/loyalty-base/LoyaltyBaseWorkspaceV2.tsx",
  );
  const detail = source(
    "../components/loyalty-base/LoyaltyRecordDetailV2.tsx",
  );
  const badges = source(
    "../components/loyalty-base/LoyaltyStatusBadges.tsx",
  );
  const legend = source("../components/loyalty-base/LoyaltyStatusLegend.tsx");
  const filters = source("../components/loyalty-base/LoyaltyFilterPanel.tsx");

  assert.match(table, /<LoyaltyStatusBadges record=\{item\} \/>/);
  assert.match(detail, /<LoyaltyStatusBadges record=\{record\} \/>/);
  assert.match(badges, /loyaltyRecordStatuses\(record\)/);
  assert.match(badges, /loyaltyStatusBadgeColor\(status\)/);
  assert.match(badges, /data-loyalty-status=\{status\}/);
  assert.match(legend, /loyaltyStatusDotColor\(item\.value\)/);
  assert.match(legend, /loyaltyStatusLabel\(item\.value\)/);
  assert.match(filters, /loyaltyStatusLabel\(value\)/);
  assert.match(filters, /<LoyaltyStatusBadge/);
  assert.match(filters, /status=\{draft\.status\}/);
});

test("keeps source-reported row metrics separate from exact lifetime metrics", () => {
  const item = normalizeLoyaltyDetail(
    {
      item: {
        id: "person-source-rollup",
        entityType: "BROKER",
        displayName: "Тестовая запись",
        attributes: {
          memberships: ["БАЗА брокеров"],
          aliases: ["Проверочный псевдоним"],
          comment: "Проверочный комментарий",
          history: [
            {
              label: "Обзвон август",
              rawValue: "НДЗ",
              normalizedResult: "НДЗ",
            },
          ],
        },
        metrics: {
          fixations: null,
          meetings: null,
          deals: null,
          dealAmount: null,
        },
        activities: [],
        metricSource: {
          kind: "UNAVAILABLE",
          label: "No event-level data",
          exactness: "UNKNOWN",
          periodFilterApplied: false,
        },
        sourceReportedMetrics: {
          fixations: 6,
          meetings: 2,
          deals: 1,
          dealAmount: "12000000",
          brokerTours: 1,
          calls: null,
          sourceLabel: "Срез Анны 17.08.2026",
          quality: "SOURCE_REPORTED",
          exactness: "UNKNOWN",
          lastDealAt: "2026-07-10T00:00:00.000Z",
          lastMeetingAt: "2026-08-13T00:00:00.000Z",
          brokerTourVisited: true,
          dealsByMonth: { "2026-07": 1 },
          callBreakdown: [{ date: "2026-08-12", result: "Проинформирован" }],
        },
      },
    },
    "brokers",
  );

  assert.equal(item.fixations, null);
  assert.equal(item.meetings, null);
  assert.equal(item.deals, null);
  assert.equal(item.dealAmount, null);
  assert.equal(item.metricSource?.kind, "UNAVAILABLE");
  assert.equal(item.sourceReportedMetrics?.fixations, 6);
  assert.equal(item.sourceReportedMetrics?.deals, 1);
  assert.equal(item.sourceReportedMetrics?.quality, "SOURCE_REPORTED");
  assert.equal(item.sourceReportedMetrics?.dealsByMonth["2026-07"], 1);
  assert.equal(item.lastActivityAt, "2026-08-13T00:00:00.000Z");
  assert.deepEqual(item.memberships, ["БАЗА брокеров"]);
  assert.equal(item.history[0].title, "НДЗ");
  assert.equal(item.history[1].title, "Проинформирован");
  assert.equal(item.comment, "Проверочный комментарий");
});

test("keeps Anna agency source contacts when the backend relation array is empty", () => {
  const detail = normalizeLoyaltyDetail(
    {
      item: {
        id: "agency-source-contacts",
        entityType: "AGENCY",
        displayName: "Тестовое агентство",
        brokers: [],
        attributes: {
          agencyContacts: [
            {
              id: "source-contact-1",
              name: "Контактное лицо",
              role: "Руководитель",
            },
          ],
        },
      },
    },
    "agencies",
  );

  assert.equal(detail.contacts.length, 1);
  assert.equal(detail.contacts[0].name, "Контактное лицо");
});

test("uses merged agency contact people and preserves every phone and email", () => {
  const detail = normalizeLoyaltyDetail(
    {
      item: {
        id: "agency-merged-contacts",
        entityType: "AGENCY",
        displayName: "Агентство",
        attributes: {
          agencyContacts: [{ id: "stale", name: "Старое имя" }],
        },
        agencyContactPeople: [
          {
            id: "person-1",
            displayName: "Актуальный контакт",
            role: "Руководитель",
            actualityStatus: "CURRENT",
            contactPoints: [
              {
                id: "phone-1",
                type: "PHONE",
                value: "+70000000001",
                isPrimary: true,
              },
              {
                id: "phone-2",
                type: "PHONE",
                value: "+70000000002",
                isPrimary: false,
              },
              {
                id: "email-1",
                type: "EMAIL",
                value: "one@example.test",
                isPrimary: true,
              },
              {
                id: "email-2",
                type: "EMAIL",
                value: "two@example.test",
                isPrimary: false,
              },
            ],
          },
        ],
      },
    },
    "agencies",
  );

  assert.equal(detail.contacts.length, 1);
  assert.equal(detail.contacts[0].name, "Актуальный контакт");
  assert.equal(detail.contacts[0].status, "Актуален");
  assert.deepEqual(
    detail.contacts[0].contactPoints.map((point) => [point.type, point.value]),
    [
      ["PHONE", "+70000000001"],
      ["PHONE", "+70000000002"],
      ["EMAIL", "one@example.test"],
      ["EMAIL", "two@example.test"],
    ],
  );
});

test("keeps period metrics separate from lifetime aggregates and preserves unavailable values", () => {
  const detail = normalizeLoyaltyDetail(
    {
      item: {
        id: "period-metrics",
        entityType: "BROKER",
        metrics: { deals: 11 },
        sourceReportedMetrics: { deals: 17 },
        periodMetrics: {
          period: { from: "2026-08-01", to: "2026-08-31" },
          availability: "UNAVAILABLE",
          fixations: null,
          meetings: null,
          deals: null,
          dealAmount: null,
          lastFixationAt: null,
          lastMeetingAt: null,
          lastDealAt: null,
        },
      },
    },
    "brokers",
  );

  assert.equal(detail.deals, 11);
  assert.equal(detail.sourceReportedMetrics?.deals, 17);
  assert.equal(detail.periodMetrics?.availability, "UNAVAILABLE");
  assert.equal(detail.periodMetrics?.deals, null);
  assert.equal(detail.periodMetrics?.lastDealAt, "");
});

test("preserves local preliminary period metrics without relabelling them exact", () => {
  const detail = normalizeLoyaltyDetail(
    {
      item: {
        id: "agency-local-period",
        entityType: "AGENCY",
        periodMetrics: {
          period: { from: "2026-08-01", to: "2026-08-31" },
          availability: "LOCAL_PRELIMINARY",
          fixations: 2,
          meetings: 1,
          deals: 1,
          dealAmount: "12500000.50",
        },
      },
    },
    "agencies",
  );

  assert.equal(detail.periodMetrics?.availability, "LOCAL_PRELIMINARY");
  assert.equal(detail.periodMetrics?.fixations, 2);
  assert.equal(detail.periodMetrics?.dealAmount, "12500000.50");
});

test("preserves curated agency profile, calls, recognitions and explicit zero controls", () => {
  const detail = normalizeLoyaltyDetail(
    {
      item: {
        id: "agency-curated-details",
        entityType: "AGENCY",
        displayName: "Агентство Анны",
        attributes: {
          calls: [
            {
              id: "call-1",
              type: "CALL",
              assignmentId: "assignment-1",
              date: "2026-08-10",
              campaign: "Август",
              campaignId: "campaign-1",
              campaignName: "Август",
              employee: "Оператор",
              employeeId: "operator-1",
              employeeName: "Оператор",
              result: "Проинформирован",
              agreement: "Перезвонить",
              nextAt: "2026-08-20",
              nextStep: "Отправить презентацию",
              nextActionAt: "2026-08-20T10:00:00.000Z",
              correctionReason: "Уточнён результат",
              isCorrection: true,
              effective: true,
            },
          ],
          recognitions: [
            {
              id: "recognition-1",
              date: "2026-08-11",
              type: "Награда",
              note: "Лучшее агентство",
              employee: "Анна",
              amount: 0,
              validUntil: "2026-12-31",
              attachment: "stored-reference",
            },
          ],
          agencySize: "Крупное",
          brokerCount: 42,
          website: "https://example.invalid",
          projectsOnSite: "Проект 1",
          sitePlacementRequirements: "Только согласованные материалы",
          lastAgencyMeetingDate: "2026-08-09",
          agencyBtFormat: "Группа до 10 человек",
          activeBrokers: 17,
          lastContractDate: "2026-07-15",
          partnershipStatus: "Партнёр",
          legalName: "ООО Агентство Анны",
          nextAgreement: "Согласовать встречу",
          specialTerms: "Персональная комиссия",
          specialTermsStatus: "Предложены",
          specialTermsValidUntil: "2026-12-31",
          rating: 5,
          crmSource: "Срез Анны",
          paymentControl: 0,
          successfulDeals: 4,
          zorgeDeals: 1,
          berzarinaDeals: 2,
          activeCrmCards: 3,
          crmScore: 9,
          dealsWithAmount: 4,
          verifiedDealIds: [],
        },
        sourceReportedMetrics: {
          callBreakdown: [
            { id: "duplicate-call", result: "Не должен дублироваться" },
          ],
        },
      },
    },
    "agencies",
  );

  assert.equal(detail.history.length, 1);
  assert.equal(detail.history[0].title, "Проинформирован");
  assert.equal(detail.history[0].type, "CALL");
  assert.equal(detail.history[0].assignmentId, "assignment-1");
  assert.equal(detail.history[0].nextStep, "Отправить презентацию");
  assert.equal(detail.history[0].nextActionAt, "2026-08-20T10:00:00.000Z");
  assert.equal(detail.history[0].correctionReason, "Уточнён результат");
  assert.match(detail.history[0].description, /Кампания: Август/);
  assert.match(detail.history[0].description, /Сотрудник: Оператор/);
  assert.match(detail.history[0].description, /Договорённость: Перезвонить/);
  assert.equal(detail.recognitions[0].note, "Лучшее агентство");
  assert.equal(detail.recognitions[0].amount, "0");
  assert.equal(detail.recognitions[0].hasAttachment, true);
  assert.equal(detail.annaDetails?.brokerCount, 42);
  assert.equal(detail.annaDetails?.activeBrokers, 17);
  assert.equal(detail.annaDetails?.legalName, "ООО Агентство Анны");
  assert.equal(detail.annaDetails?.nextAgreement, "Согласовать встречу");
  assert.equal(detail.annaDetails?.specialTermsStatus, "Предложены");
  assert.equal(detail.annaDetails?.paymentControl, 0);
  assert.equal(detail.annaDetails?.verifiedDealIdsCount, 0);
  assert.equal(
    detail.annaDetails?.sitePlacementRequirements,
    "Только согласованные материалы",
  );
});

test("keeps every useful part of legacy history tuples and broker contact/company fallbacks", () => {
  const detail = normalizeLoyaltyDetail(
    {
      item: {
        id: "broker-curated-details",
        entityType: "BROKER",
        displayName: "Брокер Анны",
        attributes: {
          company: "Агентство из источника",
          role: "Ведущий брокер",
          geography: "REGION",
          history: [
            ["Итог обзвона", "сырой ответ", "Нормализовано", "2026-08"],
          ],
        },
        agencies: [
          {
            id: "agency-1",
            displayName: "Основное агентство",
            role: "Ведущий брокер",
            isPrimary: true,
          },
        ],
        contactPoints: [
          {
            id: "phone-1",
            type: "PHONE",
            value: "+70000000001",
            isPrimary: true,
          },
          {
            id: "phone-2",
            type: "PHONE",
            value: "+70000000002",
            label: "Дополнительный",
          },
          {
            id: "email-1",
            type: "EMAIL",
            value: "broker@example.invalid",
            isPrimary: true,
          },
        ],
      },
    },
    "brokers",
  );

  assert.equal(detail.company, "Основное агентство");
  assert.equal(detail.role, "Ведущий брокер");
  assert.equal(detail.geography, "REGION");
  assert.deepEqual(detail.agencies[0], {
    id: "agency-1",
    name: "Основное агентство",
    role: "Ведущий брокер",
    isPrimary: true,
  });
  assert.equal(detail.contactPoints.length, 3);
  assert.equal(detail.contactPoints[1].label, "Дополнительный");
  assert.equal(detail.history[0].title, "Итог обзвона");
  assert.equal(
    detail.history[0].description,
    "Исходное значение: сырой ответ · Нормализованный результат: Нормализовано · Месяц кампании: 2026-08",
  );
});

test("only creates amoCRM contact links from numeric CONTACT identities on the canonical HTTPS tenant", () => {
  const safe = normalizeLoyaltyDetail(
    {
      item: {
        id: "safe-amo-contact",
        entityType: "BROKER",
        externalIdentities: [
          {
            system: "AMOCRM",
            entityType: "CONTACT",
            externalId: "12345",
            url: "https://stmichael.amocrm.ru/contacts/detail/12345",
          },
        ],
      },
    },
    "brokers",
  );
  assert.equal(
    safe.amoContactUrl,
    "https://stmichael.amocrm.ru/contacts/detail/12345",
  );

  const unsafeSuppliedUrl = normalizeLoyaltyDetail(
    {
      item: {
        id: "unsafe-supplied-url",
        entityType: "BROKER",
        externalIdentities: [
          {
            system: "AMOCRM",
            entityType: "CONTACT",
            externalId: "67890",
            url: "http://attacker.invalid/contacts/detail/67890",
          },
        ],
      },
    },
    "brokers",
  );
  assert.equal(
    unsafeSuppliedUrl.amoContactUrl,
    "https://stmichael.amocrm.ru/contacts/detail/67890",
  );

  const wrongIdentity = normalizeLoyaltyDetail(
    {
      item: {
        id: "wrong-identity",
        entityType: "AGENCY",
        externalIdentities: [
          { system: "AMOCRM", entityType: "COMPANY", externalId: "12345" },
          {
            system: "AMOCRM",
            entityType: "CONTACT",
            externalId: "12/not-numeric",
          },
        ],
      },
    },
    "agencies",
  );
  assert.equal(wrongIdentity.amoContactUrl, "");
});

test("normalizes OUR projection fields returned by the service", () => {
  const result = normalizeLoyaltyList(
    {
      base: "ours",
      entityType: "BROKER",
      items: [
        {
          id: "broker-opaque-1",
          entityType: "BROKER",
          displayName: "Наш тестовый брокер",
          city: "Москва",
          archivedAt: null,
          category: "A",
          contactPoints: [
            {
              type: "PHONE",
              value: "+70000000002",
              maskedValue: "+7***02",
              isPrimary: true,
            },
            {
              type: "EMAIL",
              value: "ours@example.invalid",
              maskedValue: "o***@example.invalid",
              isPrimary: true,
            },
          ],
          externalIdentities: [],
          agencies: [
            {
              id: "agency-2",
              displayName: "Наше тестовое агентство",
              isPrimary: true,
            },
          ],
          metrics: { clients: 8, deals: 4, meetings: 3, calls: 5 },
        },
      ],
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1,
    },
    "ours",
    "brokers",
    1,
    20,
  );

  assert.equal(result.items[0].name, "Наш тестовый брокер");
  assert.equal(result.items[0].company, "Наше тестовое агентство");
  assert.equal(result.items[0].phone, "+70000000002");
  assert.equal(result.items[0].deals, 4);
  assert.equal(result.items[0].meetings, 3);
  assert.equal(result.items[0].status, "A");
  assert.equal(result.items[0].hasAmo, null);
  assert.equal(result.items[0].fixations, null);
});

test("maps agency broker relations into detail contacts", () => {
  const detail = normalizeLoyaltyDetail(
    {
      base: "anna",
      entityType: "AGENCY",
      item: {
        id: "agency-opaque-3",
        entityType: "AGENCY",
        displayName: "Агентство с брокерами",
        contactPoints: [],
        externalIdentities: [],
        metrics: {},
        brokers: [
          {
            id: "broker-opaque-3",
            displayName: "Связанный брокер",
            role: "BROKER",
            isPrimary: true,
            contactPoints: [
              { type: "PHONE", maskedValue: "+7***03" },
              { type: "EMAIL", maskedValue: "s***@example.invalid" },
            ],
          },
        ],
      },
    },
    "agencies",
  );

  assert.deepEqual(detail.contacts[0], {
    id: "broker-opaque-3",
    name: "Связанный брокер",
    role: "BROKER",
    phone: "+7***03",
    email: "s***@example.invalid",
    status: "",
    contactPoints: [
      {
        id: "",
        type: "PHONE",
        label: "",
        value: "+7***03",
        isPrimary: null,
      },
      {
        id: "",
        type: "EMAIL",
        label: "",
        value: "s***@example.invalid",
        isPrimary: null,
      },
    ],
  });
  assert.equal(detail.fixations, null);
  assert.equal(detail.meetings, null);
  assert.equal(detail.hasAmo, null);
});

test("keeps Decimal money exact beyond the JavaScript safe-integer boundary", () => {
  const exact = "9007199254740993.01";
  const detail = normalizeLoyaltyDetail(
    {
      item: {
        id: "agency-money",
        entityType: "AGENCY",
        metrics: { dealAmount: exact },
      },
    },
    "agencies",
  );

  assert.equal(detail.dealAmount, exact);
  assert.equal(
    formatRubles(exact).replace(/\s/g, " "),
    "9 007 199 254 740 993,01 ₽",
  );
});

test("normalizes reconciliation cards from displayName, contacts and contact fields", () => {
  const result = normalizeReconciliation(
    {
      items: [
        {
          id: "case-1",
          version: 4,
          status: "RESOLVED",
          decision: "LINK",
          matchCodes: ["PHONE_EXACT"],
          score: "0.9500",
          anna: {
            id: "anna-1",
            entityType: "BROKER",
            displayName: "Контакт Анны",
            contacts: [{ type: "PHONE", maskedValue: "+7***03" }],
          },
          ours: {
            id: "ours-1",
            entityType: "BROKER",
            displayName: "Наш контакт",
            contact: "+7***03",
            amoContactId: "1003",
          },
        },
      ],
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1,
    },
    1,
    20,
  );

  assert.equal(result.items[0].anna?.name, "Контакт Анны");
  assert.equal(result.items[0].anna?.entityType, "BROKER");
  assert.equal(result.items[0].anna?.phone, "+7***03");
  assert.equal(result.items[0].ours?.name, "Наш контакт");
  assert.equal(result.items[0].ours?.phone, "+7***03");
  assert.equal(result.items[0].decision, "LINK");
  assert.equal(result.items[0].score, 0.95);
});

test("normalizes the active-links envelope including stale-snapshot owners", () => {
  const result = normalizeActiveLinks(
    {
      items: [
        {
          id: "link-opaque-1",
          version: 3,
          ownerType: "BROKER",
          ownerId: "owner-opaque-1",
          ownerName: "Запись Анны",
          targetType: "BROKER",
          targetId: "target-opaque-1",
          targetName: "Запись нашей базы",
          reconciliationCaseId: "case-opaque-1",
          decidedAt: "2026-08-18T10:00:00.000Z",
          ruleVersion: "v1",
          presentInActiveSnapshot: false,
        },
      ],
      page: 2,
      pageSize: 20,
      total: 21,
      totalPages: 2,
    },
    1,
    30,
  );

  assert.equal(result.page, 2);
  assert.equal(result.total, 21);
  assert.deepEqual(result.items[0], {
    id: "link-opaque-1",
    version: 3,
    ownerType: "BROKER",
    ownerId: "owner-opaque-1",
    ownerName: "Запись Анны",
    targetType: "BROKER",
    targetId: "target-opaque-1",
    targetName: "Запись нашей базы",
    reconciliationCaseId: "case-opaque-1",
    decidedAt: "2026-08-18T10:00:00.000Z",
    ruleVersion: "v1",
    presentInActiveSnapshot: false,
  });
});

test("normalizes actual import summary and row/code issues", () => {
  const result = normalizeImportResult({
    dryRun: true,
    contentHash: "content-hash-1",
    status: "INVALID",
    publishable: false,
    expectedActiveSnapshotId: null,
    summary: {
      records: 10,
      brokers: 8,
      agencies: 2,
      contactPoints: 12,
      uniqueNormalizedPhones: 8,
      externalIdentities: 9,
      activities: 7,
      organizationRoles: 3,
      duplicateSourceKeys: 1,
      invalidContactPoints: 2,
      issueCount: 3,
      candidateCount: 4,
      ambiguousRecords: 1,
      includedActivities: 5,
      includedFixations: 1,
      includedMeetings: 1,
      includedDeals: 2,
      includedBrokerTours: 0,
      includedCalls: 1,
      includedDealAmount: "12345678.90",
      excludedActivities: 1,
      unknownActivities: 1,
      currentPublishedRecords: 12,
      coverageDropRequiresConfirmation: true,
      coverageDrops: [
        { dimension: "uniqueNormalizedPhones", current: 9, staged: 8 },
        {
          dimension: "includedDealAmount",
          current: "20000000.00",
          staged: "12345678.90",
        },
      ],
    },
    issues: [{ row: 7, code: "INVALID_CONTACT_POINT" }],
  });

  assert.equal(result.summary.records, 10);
  assert.equal(result.summary.candidateCount, 4);
  assert.equal(result.summary.includedActivities, 5);
  assert.equal(result.summary.includedDeals, 2);
  assert.equal(result.summary.includedDealAmount, "12345678.90");
  assert.equal(result.summary.unknownActivities, 1);
  assert.equal(result.summary.currentPublishedRecords, 12);
  assert.equal(result.summary.coverageDropRequiresConfirmation, true);
  assert.equal(result.summary.uniqueNormalizedPhones, 8);
  assert.deepEqual(result.summary.coverageDrops, [
    { dimension: "uniqueNormalizedPhones", current: 9, staged: 8 },
    {
      dimension: "includedDealAmount",
      current: "20000000.00",
      staged: "12345678.90",
    },
  ]);
  assert.equal(result.publishable, false);
  assert.equal(result.expectedActiveSnapshotId, null);
  assert.equal(result.hasExpectedActiveSnapshotBinding, true);
  assert.deepEqual(result.issues, [{ row: 7, code: "INVALID_CONTACT_POINT" }]);
});

test("keeps sensitive search in a flat POST body and sends server-side publish confirmation", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/search")) {
      return new Response(
        JSON.stringify({
          base: "anna",
          entityType: "BROKER",
          items: [],
          page: 2,
          pageSize: 20,
          total: 0,
          totalPages: 0,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        snapshotId: "snapshot-opaque-1",
        status: "PUBLISHED",
        contentHash: "hash-1",
        publishedAt: "2026-08-18T00:00:00.000Z",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    await getLoyaltyList("anna", "brokers", {
      page: 2,
      pageSize: 20,
      search: "Тестовый запрос",
      archived: "exclude",
      city: "Москва",
      hasAmo: "false",
      segment: "NEW_BROKER",
      columns: {
        contact: "HAS_PHONE",
        calls: "NOT_CALLED_IN_PERIOD",
        deals: "FIVE_PLUS",
      },
    });
    await publishAnnaImport(
      "snapshot-opaque-1",
      "hash-1",
      "active-snapshot-1",
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls[0].url, "/api/loyalty-base/anna/brokers/search");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(
    calls[0].url.includes(encodeURIComponent("Тестовый запрос")),
    false,
  );
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    search: "Тестовый запрос",
    page: 2,
    pageSize: 20,
    archived: "exclude",
    city: "Москва",
    hasAmo: false,
    segment: "NEW_BROKER",
    filter: {},
    columns: {
      contact: "HAS_PHONE",
      calls: "NOT_CALLED_IN_PERIOD",
      deals: "FIVE_PLUS",
    },
  });
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
    expectedContentHash: "hash-1",
    expectedActiveSnapshotId: "active-snapshot-1",
    confirmCoverageDrop: true,
    confirmed: true,
  });
});

test("resubmits the original file with non-null and null dry-run snapshot bindings for staging", async () => {
  const originalFetch = globalThis.fetch;
  const capture: { uploadedBodies: FormData[] } = { uploadedBodies: [] };
  globalThis.fetch = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    capture.uploadedBodies.push(init?.body as FormData);
    return new Response(
      JSON.stringify({
        snapshotId: "snapshot-opaque-2",
        status: "STAGED",
        contentHash: "a".repeat(64),
        summary: { records: 1, brokers: 1, agencies: 0 },
        issues: [],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const file = new File(
    [
      JSON.stringify({
        sourceName: "fixture",
        ruleVersion: "v1",
        expectedRecords: 1,
        records: [{}],
      }),
    ],
    "fixture.json",
    { type: "application/json" },
  );
  try {
    await stageAnnaImport(
      file,
      "a".repeat(64),
      "11111111-1111-4111-8111-111111111111",
      true,
    );
    await stageAnnaImport(file, "a".repeat(64), null, false);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(capture.uploadedBodies[0].get("file"), file);
  assert.equal(
    capture.uploadedBodies[0].get("expectedContentHash"),
    "a".repeat(64),
  );
  assert.equal(
    capture.uploadedBodies[0].get("expectedActiveSnapshotId"),
    "11111111-1111-4111-8111-111111111111",
  );
  assert.equal(capture.uploadedBodies[0].get("confirmCoverageDrop"), "true");
  assert.equal(capture.uploadedBodies[1].get("expectedActiveSnapshotId"), "");
  assert.equal(capture.uploadedBodies[1].get("confirmCoverageDrop"), null);
});

test("uses the active-links routes and optimistic-lock version contract", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    calls.push({ url, init });
    return new Response(
      JSON.stringify(
        url.endsWith("/unlink")
          ? { id: "link-opaque-2", version: 5, status: "REVOKED" }
          : { items: [], page: 3, pageSize: 10, total: 0, totalPages: 0 },
      ),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    await getActiveLoyaltyLinks({
      page: 3,
      pageSize: 10,
      entityType: "AGENCY",
    });
    await unlinkActiveLoyaltyLink("link-opaque-2", 4);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(
    calls[0].url,
    "/api/loyalty-base/reconciliation/links?page=3&pageSize=10&entityType=AGENCY",
  );
  assert.equal(calls[0].init?.method, undefined);
  assert.equal(calls[1].url, "/api/loyalty-base/reconciliation/links/unlink");
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
    linkId: "link-opaque-2",
    expectedVersion: 4,
  });
});

test("normalizes campaign progress and its persisted recoverable selection", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/campaign-1/export")) {
      return new Response("\uFEFFcampaign export", {
        status: 200,
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": 'attachment; filename="campaign-1.csv"',
        },
      });
    }
    const body = url.includes("/campaign-1?")
      ? {
          id: "campaign-1",
          name: "Повторный обзвон",
          message: "Уточнить интерес",
          base: "anna",
          entityType: "brokers",
          status: "DRAFT",
          expectedCount: 2,
          remainingCount: 1,
          version: 3,
          createdAt: "2026-08-24T10:00:00.000Z",
          selection: {
            mode: "IDS",
            ids: ["11111111-1111-4111-8111-111111111111"],
          },
          assignments: [
            {
              id: "assignment-1",
              status: "PENDING",
              version: 1,
              targetId: "11111111-1111-4111-8111-111111111111",
              assignedTo: {
                id: "22222222-2222-4222-8222-222222222222",
                name: "Оператор",
                role: "MANAGER",
              },
              lastResult: null,
            },
          ],
          assignmentCounts: {
            PENDING: 1,
            IN_PROGRESS: 0,
            COMPLETED: 1,
            CANCELLED: 0,
          },
          assignmentPage: {
            page: 1,
            pageSize: 200,
            total: 2,
            totalPages: 1,
          },
        }
      : [
          {
            id: "campaign-1",
            name: "Повторный обзвон",
            message: "Уточнить интерес",
            base: "anna",
            entityType: "brokers",
            status: "DRAFT",
            expectedCount: 2,
            remainingCount: 1,
            version: 3,
            createdAt: "2026-08-24T10:00:00.000Z",
          },
        ];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const campaigns = await getLoyaltyCampaigns({
      base: "anna",
      entityType: "brokers",
    });
    const detail = await getLoyaltyCampaign("campaign-1");
    const exported = await exportLoyaltyCampaign("campaign-1");
    assert.equal(campaigns[0].version, 3);
    assert.equal(campaigns[0].remainingCount, 1);
    assert.deepEqual(detail.selection, {
      mode: "IDS",
      ids: ["11111111-1111-4111-8111-111111111111"],
    });
    assert.equal(detail.assignments[0].assignedTo?.name, "Оператор");
    assert.equal(detail.assignments[0].lastResult, "");
    assert.equal(detail.assignmentCounts.COMPLETED, 1);
    assert.equal(detail.assignmentPage.total, 2);
    assert.equal(exported.filename, "campaign-1.csv");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.match(urls[0], /\/api\/loyalty-workflow\/campaigns\?/);
  assert.equal(
    urls[1],
    "/api/loyalty-workflow/campaigns/campaign-1?page=1&limit=200",
  );
  assert.equal(urls[2], "/api/loyalty-workflow/campaigns/campaign-1/export");
});
