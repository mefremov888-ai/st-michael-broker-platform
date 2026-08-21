import assert from "node:assert/strict";
import test from "node:test";
import {
  getLoyaltyList,
  getActiveLoyaltyLinks,
  formatRubles,
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

test("shows source-reported row metrics without promoting them to exact events", () => {
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

  assert.equal(item.fixations, 6);
  assert.equal(item.deals, 1);
  assert.equal(item.metricSource?.kind, "UNAVAILABLE");
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
              date: "2026-08-10",
              campaign: "Август",
              employee: "Оператор",
              result: "Проинформирован",
              agreement: "Перезвонить",
              nextAt: "2026-08-20",
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
  assert.match(detail.history[0].description, /Кампания: Август/);
  assert.match(detail.history[0].description, /Сотрудник: Оператор/);
  assert.match(detail.history[0].description, /Договорённость: Перезвонить/);
  assert.equal(detail.recognitions[0].note, "Лучшее агентство");
  assert.equal(detail.recognitions[0].amount, "0");
  assert.equal(detail.recognitions[0].hasAttachment, true);
  assert.equal(detail.annaDetails?.brokerCount, 42);
  assert.equal(detail.annaDetails?.activeBrokers, 17);
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
          history: [
            ["Итог обзвона", "сырой ответ", "Нормализовано", "2026-08"],
          ],
        },
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

  assert.equal(detail.company, "Агентство из источника");
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
