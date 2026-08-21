"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const script = fs.readFileSync(
  path.join(__dirname, "rehearse-loyalty-migration.sh"),
  "utf8",
);
const workflow = fs.readFileSync(
  path.join(root, ".github/workflows/rehearse-loyalty-migration.yml"),
  "utf8",
);

test("legacy clone is fingerprinted before the one-time baseline resolve", () => {
  const legacyBranch = script.indexOf('MIGRATION_MODE="legacy"');
  const modeGuard = script.indexOf("if [", legacyBranch);
  const diff = script.indexOf("prisma@5.22 migrate diff", modeGuard);
  const resolve = script.indexOf(
    "prisma@5.22 migrate resolve --applied 0_legacy_baseline",
    modeGuard,
  );
  const deploy = script.indexOf("prisma@5.22 migrate deploy", modeGuard);

  assert.ok(legacyBranch > 0);
  assert.ok(modeGuard > legacyBranch);
  assert.match(script.slice(modeGuard, diff), /MIGRATION_MODE.*legacy/);
  assert.ok(diff > modeGuard);
  assert.ok(resolve > diff);
  assert.ok(deploy > resolve);
  assert.match(script, /pinned_schema_sha="[0-9a-f]{64}"/);
  assert.match(script, /pinned_sql_sha="[0-9a-f]{64}"/);
});

test("existing migration history is validated and never resolved again", () => {
  const existingBranch = script.indexOf('MIGRATION_MODE="existing-history"');
  const preDeployValidation = script.indexOf(
    "validate_clone_migration_history false",
    existingBranch,
  );
  const modeGuard = script.indexOf("if [", existingBranch);
  const postDeployValidation = script.indexOf(
    "validate_clone_migration_history true",
    modeGuard,
  );

  assert.ok(existingBranch > 0);
  assert.ok(preDeployValidation > existingBranch);
  assert.ok(modeGuard > preDeployValidation);
  assert.match(
    script.slice(modeGuard, postDeployValidation),
    /MIGRATION_MODE.*legacy/,
  );
  assert.ok(postDeployValidation > modeGuard);
  assert.match(script, /finished_at IS NULL AND rolled_back_at IS NULL/);
  assert.match(script, /exact continuous prefix|точным непрерывным prefix/i);
  assert.match(script, /sha256_file "\$migration_sql"/);
});

test("all mutation and cleanup targets stay inside the isolated clone", () => {
  assert.match(script, /set -eu\numask 077/);
  assert.match(script, /docker exec "\$REHEARSAL_ID" psql/g);
  assert.match(script, /--network "\$REHEARSAL_NET"/);
  assert.match(script, /DATABASE_URL="\$CLONE_DATABASE_URL"/);
  assert.match(script, /docker rm -f -v "\$REHEARSAL_ID"/);
  assert.doesNotMatch(script, /PRODUCTION_DATABASE_URL/);
  assert.doesNotMatch(script, /docker compose run[^\n]*prisma migrate/);
});

test("workflow removes its temporary trusted script even after failure", () => {
  assert.match(workflow, /REHEARSAL_SCRIPT=\$\(mktemp /);
  assert.match(workflow, /trap 'rm -f -- "\$REHEARSAL_SCRIPT"' EXIT/);
  assert.match(
    workflow,
    /git show FETCH_HEAD:scripts\/rehearse-loyalty-migration\.sh > "\$REHEARSAL_SCRIPT"/,
  );
});
