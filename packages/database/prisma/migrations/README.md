# Prisma migration baseline and loyalty rollout

The repository historically used `prisma db push`, so an existing non-empty
database has no Prisma migration history. Running `prisma migrate deploy`
directly against such a database fails with `P3005`.

`0_legacy_baseline/migration.sql` is a real, reproducible baseline generated
with Prisma 5.22 from the pre-loyalty schema at canonical Git commit
`e5f264d4815af5567797ca4e6cd86cdd30ae4d56`. The matching immutable schema is
`../baselines/0_legacy_baseline.prisma`.

Pinned SHA-256 fingerprints:

- baseline schema: `441C03DFC60C931D3CC22329F2651E744655279D2C332096EAF983976991A419`
- baseline SQL: `646F98459ABB9D4ED6746810F403188B45270656C5E6EA20E89D53465A870A08`

## Fresh database

Do not mark anything as applied. Run the normal deploy command; Prisma applies
the legacy baseline first and then all dated additive migrations in order
(`20260818000100_loyalty_base`, followed by the Mango safety migration).

```powershell
npx.cmd prisma migrate deploy --schema packages/database/prisma/schema.prisma
```

## Existing legacy production database

Never execute the baseline SQL against an existing database, and never use
`migrate resolve` merely to suppress P3005. The baseline may be marked applied
only after all steps below succeed.

1. Take a recoverable production backup/snapshot and record the application
   commit and database server version.
2. Restore that backup to an isolated clone. Do not point an application or
   workers at the clone.
3. Verify the two checked-in SHA-256 fingerprints above.
4. Run a read-only schema fingerprint against the clone. Exit code `0` and an
   empty diff are mandatory; exit code `2` means drift and blocks rollout.

```powershell
npx.cmd prisma migrate diff `
  --from-url $env:CLONE_DATABASE_URL `
  --to-schema-datamodel packages/database/prisma/baselines/0_legacy_baseline.prisma `
  --script `
  --exit-code
```

5. In a dedicated clone-only shell, record the legacy migration and rehearse
   the additive loyalty migration. Close that shell after the rehearsal; do
   not reuse it for production work.

```powershell
$env:DATABASE_URL = $env:CLONE_DATABASE_URL
npx.cmd prisma migrate resolve --applied 0_legacy_baseline --schema packages/database/prisma/schema.prisma
npx.cmd prisma migrate deploy --schema packages/database/prisma/schema.prisma
npx.cmd prisma migrate status --schema packages/database/prisma/schema.prisma
```

6. Verify on the clone: API startup, loyalty dry-run, no active Anna snapshot,
   legacy broker/client counts, and application smoke tests. The migration is
   additive and must not modify rows in `brokers` or `agencies`.
7. Schedule a production maintenance window and pause the normal automated
   deploy. Start a **new shell** with no clone variables inherited. Load
   `PRODUCTION_DATABASE_URL` from the approved secret manager without printing
   it. Independently confirm the non-secret production hostname/project and
   database name against the change ticket and provider console (or an
   approved read-only identity query). Record only those non-secret identity
   values; never print, paste, or log the credential URL.

8. From that new shell, repeat the read-only fingerprint against the explicit
   production URL. An empty diff and exit code `0` are mandatory. Then assign
   `DATABASE_URL` explicitly from `PRODUCTION_DATABASE_URL` immediately before
   the one-off migration commands:

```powershell
$env:CLONE_DATABASE_URL = $null
$env:DATABASE_URL = $null
if ([string]::IsNullOrWhiteSpace($env:PRODUCTION_DATABASE_URL)) { throw 'PRODUCTION_DATABASE_URL is required' }
npx.cmd prisma migrate diff `
  --from-url $env:PRODUCTION_DATABASE_URL `
  --to-schema-datamodel packages/database/prisma/baselines/0_legacy_baseline.prisma `
  --script `
  --exit-code
if ($LASTEXITCODE -ne 0) { throw 'Production schema differs from the reviewed legacy baseline' }

$env:DATABASE_URL = $env:PRODUCTION_DATABASE_URL
npx.cmd prisma migrate resolve --applied 0_legacy_baseline --schema packages/database/prisma/schema.prisma
npx.cmd prisma migrate status --schema packages/database/prisma/schema.prisma
npx.cmd prisma migrate deploy --schema packages/database/prisma/schema.prisma
npx.cmd prisma migrate status --schema packages/database/prisma/schema.prisma
```

Clear both production variables and close the shell after verification. Never
copy `DATABASE_URL` from the clone shell and never infer the production target
from whichever value happens to be present in `DATABASE_URL`.

## Automated deployment preflight

The baseline adoption is a one-time database operation, not a recurring CD
step. Before the first migration-aware release:

1. Block the regular application rollout and automatic `migrate deploy` job.
2. Run the SHA-256 checks, clone rehearsal, backup check, non-secret target
   identity confirmation, and final production fingerprint above from the
   exact immutable release artifact.
3. Run a single-concurrency, one-off migration job in the maintenance window.
   Its secret must be injected as `PRODUCTION_DATABASE_URL`; the job must make
   the explicit `DATABASE_URL = PRODUCTION_DATABASE_URL` assignment shown
   above. Do not log environment variables or command tracing.
4. Allow `migrate resolve --applied 0_legacy_baseline` only in that reviewed
   one-off job. Never add `migrate resolve` to the reusable deployment
   pipeline.
5. Require successful `migrate status`, application smoke tests, and legacy
   row-count checks before resuming application replicas and normal CD. Any
   drift, wrong target identity, checksum mismatch, or partially applied state
   fails closed and requires operator review.

The production GitHub Environment must also contain two reviewed, non-secret
variables before `Run workflow` can pass:

- `PRODUCTION_PG_SYSTEM_IDENTIFIER` — exact value returned by the approved
  read-only `SELECT system_identifier FROM pg_control_system()` against
  production;
- `PRODUCTION_MIN_BROKER_ROWS` — conservative positive floor derived from the
  recorded pre-deploy broker count. It must detect an empty/wrong volume while
  leaving explicit headroom for legitimate maintenance.

Record these values in the change ticket without a credential URL. The normal
production workflow is update-only: a missing `brokers` table is treated as a
wrong/empty database and is never initialized automatically. Fresh installs
must use a separate reviewed procedure, not the production update workflow.

Pushes to `master` run build/tests only. The SSH deployment is manual and
requires `confirm_production=true` plus approval of the protected GitHub
Environment `production`. Configure required reviewers and restrict deployment
branches to `master` before the release.

Do not mark `20260818000100_loyalty_base` as applied manually. Its SQL is
transactional and must actually execute. Any fingerprint drift, failed clone
rehearsal, missing backup, or migration checksum mismatch is a fail-closed
deployment blocker that requires a reviewed reconciliation migration.

## First Anna publication

Migration success does not authorize the first Anna snapshot publish. Before
first publish, retain the signed source control report and complete the agreed
50-card sample review. Subsequent publishes are additionally guarded by the
active-snapshot dimensional drop checks in the API.
