# Loyalty base API contract

All routes are below `/api/loyalty-base`. Reads require `MANAGER` or `ADMIN`,
except reconciliation routes, which are `ADMIN` only. All mutations and import
routes are `ADMIN` only. Contact/name search values must be sent in POST bodies,
never URL query parameters.

## Import

`POST /anna/import/dry-run` and `/anna/import/stage` accept multipart field
`file` (UTF-8 JSON, maximum 10 MiB). Stage resubmits the same file and adds:

- `expectedContentHash`: SHA-256 returned by dry-run;
- `expectedActiveSnapshotId`: dry-run value, UUID or an empty string for null;
- `confirmCoverageDrop=true` only after explicit administrator confirmation.

The JSON document contains `sourceName`, `ruleVersion`, `records` and this
required source control manifest:

```json
{
  "expectedRecords": 6670,
  "expectedUniquePhones": 0,
  "expectedActivities": 0,
  "expectedExternalIdentities": 0,
  "expectedIncludedFixations": 0,
  "expectedIncludedMeetings": 0,
  "expectedIncludedDeals": 0,
  "expectedIncludedBrokerTours": 0,
  "expectedIncludedCalls": 0,
  "expectedIncludedDealAmount": "0.00"
}
```

The numbers above illustrate types only; import tooling must populate the real
independently controlled totals and must not copy these zeroes. Dry-run exact-
compares every manifest field with normalized prepared data. A mismatch makes
the document non-publishable; stage rejects it. Included deals additionally
require positive RUB amount and `contractType=DDU`. Monetary strings accept at
most 16 integer digits and two decimal digits, matching Decimal(18,2).

### Curated legacy aggregates (Anna)

Anna's legacy export contains per-row CRM totals but not one stable id/date per
fixation, meeting, deal or call. Such totals must be sent as the optional
`record.sourceAggregate`; they must **not** be expanded into synthetic
`activities`. If at least one record has this object, the top-level manifest
must contain the exact `expectedSourceAggregates` count and a fail-closed
`expectedSourceReportedSummary`:

```json
{
  "expectedSourceAggregates": 6872,
  "expectedSourceReportedSummary": {
    "brokers": {
      "records": 6670,
      "fixations": 739,
      "fixationKnownRecords": 6670,
      "meetings": 375,
      "meetingKnownRecords": 6670,
      "deals": 198,
      "dealKnownRecords": 6670,
      "brokerTours": 1248,
      "brokerTourKnownRecords": 6670,
      "calls": 146,
      "callKnownRecords": 6670,
      "dealAmount": "4722766207.00",
      "dealAmountKnownRecords": 6670
    },
    "agencies": {
      "records": 202,
      "fixations": 0,
      "fixationKnownRecords": 202,
      "meetings": 697,
      "meetingKnownRecords": 202,
      "deals": 223,
      "dealKnownRecords": 202,
      "brokerTours": null,
      "brokerTourKnownRecords": 0,
      "calls": null,
      "callKnownRecords": 0,
      "dealAmount": "4704307380.00",
      "dealAmountKnownRecords": 202
    }
  }
}
```

The numbers shown are the reviewed 2026-08-21 source controls. Import tooling
must still derive every `*KnownRecords` value from field presence: an absent
value is unknown; an explicitly present zero is known. The `calls=146` control
is valid only when `callCount` is the exact sum of the present
`callsMayAugust` breakdown; the importer must reject rather than reuse it for a
different call definition. Decimal amounts are compared in integer kopecks,
never floating point.

Each row then carries its own aggregate statement:

```json
{
  "sourceAggregate": {
    "sourceKind": "ANNA_LEGACY_CRM",
    "sourceVersion": "broker-source-enriched-v1",
    "sourceLabel": "Anna curated CRM totals",
    "quality": "SOURCE_REPORTED",
    "exactness": "UNKNOWN",
    "periodKind": "LIFETIME",
    "contributesToSourceSummary": true,
    "fixationCount": 4,
    "meetingCount": null,
    "dealCount": 2,
    "brokerTourCount": 1,
    "callCount": 8,
    "dealAmount": "1500000.00",
    "currency": "RUB",
    "lastFixationAt": "2026-06-01",
    "lastMeetingAt": null,
    "lastDealAt": "2026-07-01",
    "lastCallAt": "2026-08-01",
    "brokerTourVisited": true,
    "brokerTourAt": "2026-05-15",
    "dealsByMonth": { "2026-07": 2 },
    "callBreakdown": [{ "period": "2026-05", "count": 3 }],
    "provenance": { "rawFields": ["crm.fixations", "crm.deals"] }
  }
}
```

All measures are nullable: `null`/omitted means unknown, while `0` is an
explicit source-reported zero. `dealAmount` and `currency` must either both be
absent or be a non-negative decimal plus `RUB`. `dealsByMonth` accepts only
`YYYY-MM` keys and non-negative integer counts. `DATE_RANGE` requires both
`periodFrom` and `periodTo`.

`contributesToSourceSummary=true` is accepted only with
`quality=SOURCE_REPORTED`. Broker and agency source summaries are always
reported as separate groups and are never added together because their scopes
may overlap. The flag means "show in the explicitly unconfirmed source block";
it never promotes a rollup to a confirmed KPI.

ANNA reads expose three related fields:

- `metrics`: exact event-derived KPI values, or nullable values when exact
  event evidence is unavailable;
- `metricSource`: `EXACT_ACTIVITIES` or `UNAVAILABLE`;
- `sourceReportedMetrics`: the original aggregate and provenance even when
  exact events take precedence.

If the active snapshot has any event-level activity evidence, overview KPIs use
only INCLUDED, non-archived event rows. Without such evidence, confirmed
activity KPIs are null rather than fabricated from rollups. Overview exposes
the unconfirmed rollups under `sourceReportedSummary.brokers` and
`sourceReportedSummary.agencies`; it never sums those groups. Source aggregates
are snapshot/lifetime values unless their own period metadata says otherwise;
`periodFilterApplied=false` prevents the UI from presenting them as selected-
month/quarter facts. Overview also returns per-KPI `kpiMetadata` with basis,
formula, period behavior, rule version and included/excluded semantics for
tooltips.

Publish is `POST /anna/import/:snapshotId/publish` with JSON body:

```json
{
  "confirmed": true,
  "expectedContentHash": "<64 lowercase hex>",
  "expectedActiveSnapshotId": null,
  "confirmCoverageDrop": false
}
```

The active pointer and every coverage dimension are rechecked in the same
serializable transaction. Publication history is append-only.

## Read and reconciliation

- `GET /:base/overview?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /:base/brokers|agencies?page=1&pageSize=30`
- `POST /:base/brokers|agencies/search` for sensitive search/filter bodies
- `GET /:base/brokers|agencies/:id`
- `GET /reconciliation`, `POST /reconciliation/search`, `POST /reconciliation`
- `GET /reconciliation/links`
- `POST /reconciliation/links/unlink` with `{ "linkId", "expectedVersion" }`

Broker drill-down segment literals are exactly
`NOT_CALLED_CURRENT_MONTH | NEW_BROKER | BT_WITHOUT_FIXATION | BIRTHDAY_TODAY`.
Archived source records and manually archived stable entities are excluded from
reconciliation candidate generation and reconciliation lists.

## Manual Anna overrides

Anna detail/list items expose `updatedAt`, which is the optimistic concurrency
token for the stable entity. ADMIN mutations fail with `409 Conflict` when the
token is stale:

- `PATCH /anna/brokers|agencies/:id` requires `expectedUpdatedAt` in the JSON
  body together with the fields being changed;
- `DELETE /anna/brokers|agencies/:id` requires JSON body
  `{ "expectedUpdatedAt": "<ISO timestamp>" }`.

Successful mutations append the changed field names and their manual override
values before/after to the entity audit. Contact points are not mutable through
these endpoints and are never copied into this audit payload.

## Database defense in depth

The API has no update/delete path for imported source records, contact points,
external identities, activities, or field provenance; a stage creates a new
snapshot instead. Core snapshot/activity ownership is enforced with composite
foreign keys, and reconciliation transitions are rechecked in serializable
transactions. The current migration does not make every source/provenance
table physically immutable against a privileged direct-SQL operator, nor can
all polymorphic owner relations be expressed as Prisma relations. The current
Compose setup still gives the API the shared PostgreSQL owner credential, so
least privilege must not be assumed: direct DML on `loyalty_*` source tables
remains an operationally prohibited path. Separate migration/application
roles and database-level source immutability/RLS are defense-in-depth
follow-ups that must be rehearsed on a PostgreSQL clone before production
hardening is declared complete.
