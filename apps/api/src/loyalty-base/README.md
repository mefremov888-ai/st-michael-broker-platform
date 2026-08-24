# Loyalty base API contract

All routes are below `/api/loyalty-base`. Reads require `MANAGER` or `ADMIN`.
Contact/name search values must be sent in POST bodies, never URL query
parameters. Fine-grained loyalty grants are enforced in addition to route
roles.

## Import

`POST /anna/import/dry-run` and `/anna/import/stage` accept multipart field
`file` (UTF-8 JSON, maximum 10 MiB). Stage resubmits the same file and adds:

Dry-run requires the `IMPORT` grant for managers; stage remains ADMIN-only.
Both multipart routes check `IMPORT` in a guard before the in-memory file
interceptor runs. Dry-run repeats the permission check in its handler as
defense in depth.

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
- `POST /reconciliation/links/unlink` is retired and always returns HTTP 410.
  Links can only be revoked by a case-bound `UNLINK` decision through
  `POST /reconciliation` with the reconciliation case version.

Broker drill-down segment literals are exactly
`NOT_CALLED_CURRENT_MONTH | NEW_BROKER | BT_WITHOUT_FIXATION | BIRTHDAY_TODAY`.
Archived source records and manually archived stable entities are excluded from
reconciliation candidate generation and reconciliation lists.
Inside the same serializable decision transaction, `LINK` and `SUPPLEMENT`
revalidate that the Anna source/manual owner is still active and that an OUR
broker is still a non-merged `BROKER`, is not blocked, and is not marked
`CLOSED_AS_BROKER` (or that the target OUR agency still exists).

### Canonical list filters, facets and stable selections

Interactive filtering uses `POST /:base/brokers/search` or
`POST /:base/agencies/search`. Search text (name, related agency, phone or
email) stays in the JSON body. The canonical object is `filter`; legacy flat
fields and `filters` are normalized for compatibility. A typical body is:

Capability is checked before a full graph is loaded. A dimension without an
authoritative field for the selected OUR broker/agency model fails with HTTP
400 and code `LOYALTY_FILTER_UNAVAILABLE`; list, search, export and workflow
selection use the same check and never turn an unsupported predicate into an
empty result.

```json
{
  "page": 1,
  "pageSize": 30,
  "search": "",
  "sortBy": "deals",
  "sortOrder": "desc",
  "filter": {
    "callPeriod": { "from": "2026-08-01", "to": "2026-08-31" },
    "campaignIds": ["11111111-1111-4111-8111-111111111111"],
    "lastCallResults": ["SEND_INFORMATION"],
    "scenario": "CALLED_IN_PERIOD",
    "assigneeIds": ["user-id"],
    "specializations": ["Бизнес / премиум"],
    "geography": ["MOSCOW"],
    "workFormats": ["Агентство"],
    "relationshipStages": ["Сделка"],
    "brokerStatuses": ["TOP_SELLER"],
    "dataQuality": ["FULL"],
    "dealCount": { "min": 1, "max": 4 },
    "dealsInPeriod": true,
    "bt": true,
    "meetings": { "min": 1 },
    "agencySizes": ["Крупное"],
    "websitePresent": true,
    "projectsOnSite": ["YES"],
    "individualTerms": true,
    "specialTermsProposed": true,
    "rewardPresent": true,
    "staleDays": 90
  }
}
```

Table-header filters are sent beside `filter` as `columns`. Omit a property for
the UI's “all” option:

```json
{
  "columns": {
    "contact": "HAS_PHONE",
    "statusStage": "TOP_SELLER",
    "activity": "HAS_MEETINGS",
    "calls": "CALLED_IN_PERIOD",
    "assignee": "user-id-or-exact-name",
    "deals": "THREE_PLUS"
  }
}
```

The bounded values are `HAS_PHONE | NO_PHONE`; a computed broker/agency status
code; `BT_VISITED | BT_NOT_VISITED | HAS_FIXATIONS | NO_FIXATIONS |
HAS_MEETINGS | NO_MEETINGS`; `CALLED_IN_PERIOD | NOT_CALLED_IN_PERIOD`;
`UNASSIGNED` or an exact assignee id/name; and `HAS_DEALS | NO_DEALS |
ONE_TO_TWO | ONE_TO_FOUR | THREE_PLUS | FIVE_PLUS`. Column filters are part of
the server predicate and hash, so pagination, select-all and export cannot
diverge from the visible table.

Flat `from/to` are one selected period and apply to both call predicates and
`dealsInPeriod`. With canonical input, `activityPeriod` may be supplied
separately; when omitted it inherits `callPeriod`. Both bounds are required.
Campaigns are database UUIDs only. Historical names are resolved server-side
through `LOYALTY_CAMPAIGN_MAP_JSON`, whose values may be a string, an array of
aliases, or `{ "name": "...", "aliases": ["..."] }`.

Canonical call-result codes equal the workflow enum. Broker values are
`INFORMED | DO_NOT_CALL | NOT_INTERESTED | NO_ANSWER | SEND_INFORMATION |
BROKER_TOUR_BOOKED | BROKER_TOUR_DECLINED | INVALID_PHONE | NOT_A_BROKER`.
Agency values are `NO_ANSWER | COOPERATION_DECLINED |
BROKER_TOUR_SCHEDULED | CALLBACK | SEND_INFORMATION | AGREEMENTS_EXIST |
COOPERATION_AGREED`. Deprecated filter inputs are canonicalized before the
predicate and `filterHash`; they are never returned as facet values.

Every list/search response contains `selectionCount`, deterministic
`filterHash`, `snapshotId`, `facets` and `dataAvailability`. The workflow layer
must use `LoyaltyBaseService.resolveSelection(...)`, which runs the identical
predicate and returns `{ ids, total, filterHash, snapshotId }`. Missing legacy
metrics remain `null`; unknown evidence never becomes zero or a negative
answer to a filter.

Each row also has `periodMetrics` with the requested `{ from, to }`,
`availability`, counts/amount and last dates. It is `EXACT` only when Anna has
INCLUDED event rows for the active snapshot; otherwise every metric is `null`
and availability is `UNAVAILABLE`. Lifetime totals are never relabelled as
selected-period values. OUR currently reports period metrics as unavailable
until a separately verified aggregate query is introduced.

Status precedence is deterministic. Brokers use `DORMANT → TOP_SELLER →
SELLER → OFFERING → FIXATING → BROKER_TOUR → NEW` (BT may also be a secondary
status). Agencies use `DORMANT_PARTNER → VIP_PARTNER → SELLING_PARTNER →
ACTIVE_PARTNER → FIXATING_PARTNER → WARM_PARTNER → STARTING_PARTNER →
NEW_AGENCY`. `NEW` is emitted only when all required zero/false facts are
known. Data-quality facets use only `FULL | NEEDS_COMPLETION |
NOT_FOUND_IN_CRM | CONFLICT`.

### Export and audit reads

`POST /:base/brokers/export` and `/agencies/export` require both `READ_ALL` and
`EXPORT` and use the same POST-body predicate. They stream RFC 4180 CSV with a
UTF-8 BOM, mask phone and email values, neutralize Excel formulas beginning
with `=`, `+`, `-`, `@`, tab or carriage return, and fail loudly instead of
silently truncating above 50,000 rows. The export audit stores only
actor, base, entity type, row count, truncation flag and limit—never search
text, filters or row contents. It also stores the one-way `filterHash` so an
export can be tied to its canonical selection without disclosing criteria.

`GET /anna/brokers/:id/changes` and
`GET /anna/agencies/:id/changes` are ADMIN-only paginated audit reads.
Reconciliation decisions require a 3–1000 character `reason`; optional
`targetId` and `fieldResolutions` are stored in the decision payload for
`LINK | KEEP_SEPARATE | REJECT_MATCH | SUPPLEMENT | ARCHIVE | UNLINK`.

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

## Production-scale release gate

List, search, selection resolution and synchronous CSV export intentionally use
one canonical in-process predicate so visible rows, facets, bulk selection and
export cannot diverge. Consequently, one request may hold the complete
candidate graph while it evaluates and sorts it. The reviewed production scale
is 6,872 Anna rows, 18,893 OUR brokers and a 202-agency graph containing 18,893
current broker relations.

The gate also asserts that persisted reconciliation reads send `skip/take` to
PostgreSQL. The cabinet-only anti-join may hold the 6,872 matched stable IDs,
but fetches only the requested 30-row entity page; it does not materialize the
18,893 cabinet records as response candidates.

`loyalty-scale.release.spec.ts` exercises those three graph sizes. Each
in-process mapping/filtering/sorting/facet pipeline must finish below 15 seconds
and add less than 256 MiB of heap. Run the explicit release gate with:

```bash
cd apps/api
npx jest --runInBand --logHeapUsage src/loyalty-base/loyalty-scale.release.spec.ts
```

The synthetic gate measures application CPU/heap only; it is not evidence for
production PostgreSQL latency. A release must still smoke-test one default
page for each base/entity pair and a narrowly filtered export against the real
database.

To prevent concurrent full graphs from exhausting one Node process, one shared
process-wide coordinator admits at most two simultaneous full-scan pipelines
across both `LoyaltyBaseService` and reconciliation V2. A third
list/search/selection/export or reconciliation-universe request fails loudly
with HTTP 503, code `LOYALTY_FULL_SCAN_BUSY`, JSON `retryAfterSeconds=2`, and
HTTP `Retry-After: 2`. Slots are released in `finally` after both success and
error.
Overview and entity detail reads do not acquire this guard. The synchronous
export additionally fails rather than truncates when the canonical selection
exceeds `MAX_LOYALTY_EXPORT_ROWS` (50,000).

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
