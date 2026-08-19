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
