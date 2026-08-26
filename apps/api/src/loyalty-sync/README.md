# Loyalty source dry-runs

The Google Sheets and amoCRM endpoints are read-only attestations. They never
publish source rows and persist only bounded counts, timestamps, hashes and safe
error codes.

For amoCRM, "complete traversal" means only that the configured contacts,
companies and leads entity collections were paged to their terminal response
within the declared bounds. It is an entity inventory, not full historical
coverage. The UI therefore calls this a "full entity traversal" and must never
label it as "full coverage". It does not scan a historical event ledger or call
source and cannot confirm fixation, meeting, deal-history or call KPI values.

## Memory and completeness bounds

- Google metadata is checked before any values request. The four required tabs
  must fit the configured row, column and allocated-cell limits. Values are then
  read sequentially in A1 rectangles of at most 1,000 requested cells; only one
  response rectangle is retained at a time. Each response also has an 8 MiB
  gaxios `maxContentLength` hard limit. The digest includes the tab boundary,
  absolute row, returned row length and absolute column before every value, so
  it distinguishes layouts without depending on rectangle size.
- amoCRM requests a fixed `order[id]=asc` and passes one page at a time to the
  scan consumer. IDs must be safe positive integers and globally strictly
  increasing. Readonly page responses have a 16 MiB decoded-stream cap before
  JSON parsing; declared content length, response shape and `items <= limit` are
  also checked fail-closed. The request abort timeout remains active throughout
  the bounded body read. A duplicate, order violation, page error or page-bound
  exhaustion fails the whole run. The legacy accumulating `scanReadonly` method
  remains for existing callers but the loyalty dry-run uses the page consumer.

## Sequential-scan semantics

Google metadata and value rectangles are separate requests, so the source may
change between them. `readAt` is conservatively captured before the metadata
request. A successful result means only `completeTraversal=true`; it explicitly
records `transactionalSnapshot=false` and `eventCoverageComplete=false` with the
`SEQUENTIAL_BOUNDED_TRAVERSAL_NOT_POINT_IN_TIME` semantics marker.

Concurrent edits or appends can therefore produce a digest that is not a
point-in-time snapshot. This run must not be used to attest
`FULL_ACTIVITY_COVERAGE`, and it never promises coverage of rows appended while
the traversal is running.

## RUNNING-run recovery

The application does not automatically expire or recover a `RUNNING` row. The
partial unique index per source remains the overlap guard, so an old row blocks
new scans until an operator explicitly resolves it.

Recovery is operations-only: first prove that the owning API process/request is
no longer alive, retain the run ID and incident evidence, then use the approved
database runbook to compare-and-set that exact ID from `RUNNING` to `FAILED` with
an operations recovery code and completion timestamp. Do not perform an
unconditional status update. There is intentionally no public recovery API.

Normal completion and failure are also compare-and-set transitions scoped to
the exact run ID and `RUNNING` status. A fenced process that lost ownership can
therefore never overwrite a terminal state.
