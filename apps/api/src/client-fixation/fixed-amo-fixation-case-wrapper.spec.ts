import { createHash } from "crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";
import { tmpdir } from "os";
import { PassThrough } from "stream";
import { spawnSync } from "child_process";
import { runInNewContext } from "vm";
import { parse } from "yaml";

describe("DRAFT protected exact-case wrapper (no providers or production commands)", () => {
  const root = resolve(__dirname, "../../../..");
  const source = readFileSync(resolve(root, "scripts/run-fixed-amo-fixation-case.js"), "utf8");
  const workflowText = readFileSync(resolve(root, ".github/workflows/apply-fixed-amo-fixation-case.yml"), "utf8");
  const workflow = parse(workflowText);
  const steps = workflow.jobs.apply.steps;
  const step = (name: string) => {
    const match = steps.find((entry: any) => entry.name === name);
    if (!match) throw Error(`Missing workflow step: ${name}`);
    return match;
  };
  const gateStep = step("Validate mode, current master, runtime and apply attestations");
  const downloadPlanStep = step("Download immutable reviewed-plan attestation");
  const bindPlanStep = step("Bind apply inputs to the reviewed plan report");
  const runtimeCheckoutStep = step("Checkout exact deployed adapter revision separately");
  const buildStep = step("Build separately checked-out deployed integration and writer bytes");
  const streamStep = step("Stream attested case under continuously checked physical exclusive lock");
  const uploadPlanStep = step("Upload immutable reviewed-plan attestation");
  it("binds uncertain-lease exception to the exact immutable zero-POST failure receipt", () => {
    const proof = step("Verify exact historical zero-post failure before lease recovery");
    expect(proof.if).toBe("${{ inputs.mode == 'apply' }}");
    expect(proof.run).toContain('.id == 38150838032');
    expect(proof.run).toContain('.actor.login == "mefremov888-ai"');
    expect(proof.run).toContain('78e0e607d07397bfeacabbb4b41a64a57b54877a');
    expect(proof.run).toContain('.run_attempt == 1');
    expect(streamStep.env.ZERO_POST_FAILURE_RUN_ID).toBe('${{ steps.abandoned.outputs.zero_post_failure_run_id }}');
    const script = proof.run.match(/node -e '([\s\S]*?)'\s*\n/)[1];
    const receipt = { status: "unresolved", failureCode: "RECOVERY_REFUSED", automaticRetryBlocked: true,
      directMorekitDispatchAttempted: false, contactPosts: 0, leadPosts: 0, patchPosts: 0, notePosts: 0 };
    const log = (report: any) => `apply\tStream attested case under continuously checked physical exclusive lock\t2026-10-11T15:22:30.0370890Z ${JSON.stringify(report)}\n`;
    const parseReceipt = (input: string) => spawnSync(process.execPath, ["-e", script], { input, encoding: "utf8", timeout: 5000 }).status;
    expect(parseReceipt(log(receipt))).toBe(0);
    expect(parseReceipt(log(receipt) + log(receipt))).not.toBe(0);
    expect(parseReceipt(log({ ...receipt, contactPosts: 1 }))).not.toBe(0);
    expect(parseReceipt(log({ ...receipt, status: "linked" }))).not.toBe(0);
    expect(parseReceipt(`apply\tstep\t2026-10-11T15:22:30.0370890Z echo '${JSON.stringify(receipt)}'\n`)).not.toBe(0);
    expect(parseReceipt(log(receipt).replace('15:22:30', '15:22:31'))).not.toBe(0);
  });
  const stream = streamStep.run.replace(/\r\n/g, "\n");
  const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
  function load(extra: any = {}) {
    const target = { exports: {} as any };
    const requires: string[] = [];
    const require = (name: string) => {
      requires.push(name);
      if (name === "node:fs" && extra.fs) return extra.fs;
      if (name === "node:path") return jest.requireActual("path").posix;
      if (!name.startsWith("node:")) throw Error("Non-built-in import refused in fixture");
      return jest.requireActual(name);
    };
    runInNewContext(source, { module: target, exports: target.exports, require, __dirname: "/tmp/st-michael-fixed-case.ABC123/scripts", Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, process: { env: {}, on: jest.fn(), exit: jest.fn(), pid: 99 }, console: { log() {}, warn() {}, error() {}, info() {}, debug() {} }, ...extra.globals });
    return { api: target.exports, requires };
  }
  const runner = load().api;
  function attestation() {
    const stage = "/tmp/st-michael-fixed-case.ABC123";
    const files = new Map<string, Buffer>();
    const hashes: any = {};
    for (const [key, relative] of Object.entries(runner.FILES)) {
      const bytes = Buffer.from(`// fixture ${key}\n`);
      files.set(`${stage}/${relative}`, bytes); hashes[key] = sha(bytes);
      if (runner.COMPILED.includes(key)) files.set(`/app/${relative}`, bytes);
    }
    files.set(`${stage}/${runner.RUNNER}`, Buffer.from(source));
    const manifest: any = { schemaVersion: 1, sourceGitSha: "a".repeat(40), deployedGitSha: "b".repeat(40), sourceHashes: hashes, runnerSha256: sha(source) };
    const bytes = Buffer.from(JSON.stringify(manifest)); files.set(`${stage}/manifest.json`, bytes);
    const modes = new Map<string, number>();
    const links = new Set<string>();
    const fs = {
      lstatSync: jest.fn((file: string) => ({ isFile: () => files.has(file), isDirectory: () => !files.has(file), isSymbolicLink: () => links.has(file), mode: modes.get(file) || (files.has(file) ? 0o600 : 0o700), size: files.get(file)?.length || 0 })),
      readFileSync: jest.fn((file: string) => { const bytes = files.get(file); if (!bytes) throw Error("Absent private fixture"); return bytes; }),
      realpathSync: jest.fn((file: string) => file),
    };
    const env: any = { NODE_ENV: "production", GIT_SHA: manifest.deployedGitSha, FIXED_CASE_DEPLOYED_GIT_SHA: manifest.deployedGitSha, FIXED_CASE_SOURCE_GIT_SHA: manifest.sourceGitSha,
      FIXED_CASE_RUN_ID: "123456", FIXED_CASE_RUN_ATTEMPT: "1", FIXED_CASE_CONFIRMATION: runner.CONFIRMATION,
      FIXED_CASE_MODE: "apply", FIXED_CASE_PLAN_RUN_ID: "123455", FIXED_CASE_EXPECTED_CASE_HASH: "d".repeat(64), FIXED_CASE_EXPECTED_CANDIDATE_HASH: "e".repeat(64),
      FIXED_CASE_MANIFEST_SHA256: sha(bytes), FIXED_CASE_RUNNER_SHA256: manifest.runnerSha256,
      PRODUCTION_PG_SYSTEM_IDENTIFIER: "1234567", PRODUCTION_MIN_BROKER_ROWS: "100" };
    return { stage, files, hashes, manifest, modes, links, fs, env, api: load({ fs }).api };
  }
  it("imports only built-ins and performs no work on load", () => {
    const instance = load();
    expect(instance.requires).toEqual(["node:crypto", "node:fs", "node:path"]);
    expect(instance.api.FILES).toHaveProperty("leasePlan");
    expect(Object.keys(instance.api.FILES)).toHaveLength(19);
    expect(instance.api.COMPILED).toHaveLength(12);
  });
  it("attests all nineteen staged files, wrapper and twelve LIVE compiled files before recovery imports", () => {
    const fixture = attestation();
    expect(fixture.api.attest(fixture.stage, fixture.env)).toMatchObject(fixture.manifest);
    expect(JSON.parse(fixture.env.FIXED_CASE_SOURCE_HASHES)).toEqual(Object.fromEntries(
      runner.RECOVERY_SOURCE_KEYS.map((key: string) => [key, fixture.hashes[key]])));
    expect(Object.keys(JSON.parse(fixture.env.FIXED_CASE_SOURCE_HASHES))).toHaveLength(12);
    expect(fixture.env.FIXED_CASE_INSPECTOR_SHA256).toBe(fixture.hashes.inspector);
    const reads = fixture.fs.readFileSync.mock.calls.map((args: any[]) => args[0]);
    for (const key of runner.COMPILED) expect(reads).toContain(`/app/${runner.FILES[key]}`);
    expect(source.indexOf("attest(root, environment)")).toBeLessThan(source.indexOf('require("./apply-fixed-amo-fixation-case.js")'));
  });
  it("loads the recovery from a real private /tmp-style tree without NODE_PATH or package fallback", () => {
    const temp = mkdtempSync(resolve(tmpdir(), "st-michael-fixed-case-test-"));
    try {
      for (const relative of runner.RECOVERY_SOURCE_KEYS.map((key: string) => runner.FILES[key])) {
        const destination = resolve(temp, relative);
        mkdirSync(resolve(destination, ".."), { recursive: true });
        copyFileSync(resolve(root, relative), destination);
      }
      const entry = resolve(temp, runner.FILES.recovery);
      const result = spawnSync(process.execPath, ["-e", "const r=require(process.argv[1]); if(typeof r.runDraftRecovery!=='function') process.exit(2)", entry],
        { cwd: temp, env: { ...process.env, NODE_PATH: "" }, encoding: "utf8", timeout: 5000 });
      expect(result.stderr).toBe(""); expect(result.status).toBe(0);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
  it.each(Object.keys(runner.FILES))("rejects any staged hash mismatch: %s", (key) => {
    const f = attestation(); f.files.set(`${f.stage}/${runner.FILES[key]}`, Buffer.from("changed-private-fixture"));
    expect(() => f.api.attest(f.stage, f.env)).toThrow("refused");
  });
  it.each(runner.COMPILED)("rejects any LIVE adapter mismatch: %s", (key: string) => {
    const f = attestation(); f.files.set(`/app/${runner.FILES[key]}`, Buffer.from("different-live-revision"));
    expect(() => f.api.attest(f.stage, f.env)).toThrow("refused");
  });
  it.each(["manifest.json", "scripts/run-fixed-amo-fixation-case.js"])("rejects changed wrapper or manifest: %s", (file) => {
    const f = attestation(); f.files.set(`${f.stage}/${file}`, Buffer.from("private-change"));
    expect(() => f.api.attest(f.stage, f.env)).toThrow("refused");
  });
  it.each(["scripts", "packages/integrations/dist", "scripts/apply-fixed-amo-fixation-case.js"])("rejects symlink ancestry or file: %s", (file) => {
    const f = attestation(); f.links.add(`${f.stage}/${file}`);
    expect(() => f.api.attest(f.stage, f.env)).toThrow("refused");
  });
  it.each([
    { NODE_ENV: "development" }, { FIXED_CASE_RUN_ATTEMPT: "2" }, { FIXED_CASE_RUN_ID: "123\n" }, { GIT_SHA: "c".repeat(40) },
    { FIXED_CASE_CONFIRMATION: "true" }, { NODE_TLS_REJECT_UNAUTHORIZED: "0" }, { PRODUCTION_PG_SYSTEM_IDENTIFIER: "x" }, { PRODUCTION_MIN_BROKER_ROWS: "9999999999999999" },
  ])("rejects execution/runtime/identity gate drift before imports", (change) => {
    const f = attestation(); expect(() => f.api.attest(f.stage, { ...f.env, ...change })).toThrow("refused");
  });
  it("requires physical mode700 stage and mode600 executable sources", () => {
    const f = attestation(); f.modes.set(f.stage, 0o755);
    expect(() => f.api.attest(f.stage, f.env)).toThrow("refused");
    f.modes.delete(f.stage); f.modes.set(`${f.stage}/scripts/apply-fixed-amo-fixation-case.js`, 0o644);
    expect(() => f.api.attest(f.stage, f.env)).toThrow("refused");
  });
  function channels(globals: any = {}) {
    const input = new PassThrough(), output = new PassThrough(), fatal = jest.fn();
    const packets: string[] = []; output.on("data", (data) => packets.push(String(data)));
    const lock = load({ globals }).api.createOperationLock(input, output, fatal);
    return { input, output, fatal, packets, lock };
  }
  it("requires a fresh host nonce acknowledgement, coalesces concurrent assertions", async () => {
    const f = channels();
    const first = f.lock.assertOwned(), second = f.lock.assertOwned();
    expect(first).toBe(second); expect(f.packets).toHaveLength(1);
    expect(f.packets[0]).toMatch(/^lock-check:[a-f0-9]{32}\n$/);
    f.input.write(f.packets[0].replace("lock-check:", "lock-ok:"));
    await first;
    const next = f.lock.assertOwned(); expect(f.packets[1]).not.toBe(f.packets[0]);
    f.input.write(f.packets[1].replace("lock-check:", "lock-ok:")); await next;
    expect(f.fatal).not.toHaveBeenCalled(); f.lock.close();
  });
  it.each(["lock-ok:wrong\n", "lock-ok:" + "a".repeat(32) + "\n", "private".repeat(30)])("fails closed on malformed, replayed or oversized acknowledgements", async (payload) => {
    const f = channels(); const pending = f.lock.assertOwned(); const failure = expect(pending).rejects.toThrow("LOCK_NOT_OWNED");
    f.input.write(payload); await failure;
    expect(f.fatal).toHaveBeenCalledTimes(1); await expect(f.lock.assertOwned()).rejects.toThrow("LOCK_NOT_OWNED"); f.lock.close();
  });
  it("fails closed at exactly 5s deadline; no no-op lock callback or retry", async () => {
    let timeout: () => void = () => {}; const timer = jest.fn((callback, milliseconds) => { expect(milliseconds).toBe(5000); timeout = callback; return 1; });
    const f = channels({ setTimeout: timer, clearTimeout: jest.fn(), setInterval: jest.fn(() => 2), clearInterval: jest.fn() });
    const promise = f.lock.assertOwned(); const failure = expect(promise).rejects.toThrow("LOCK_NOT_OWNED"); timeout(); await failure;
    expect(f.fatal).toHaveBeenCalledTimes(1); expect(f.packets).toHaveLength(1); f.lock.close();
  });
  it("continuously checks ownership through 500ms heartbeats", async () => {
    let beat: () => void = () => {}; const f = channels({ setInterval: jest.fn((callback, ms) => { expect(ms).toBe(500); beat = callback; return 1; }), clearInterval: jest.fn() });
    beat(); expect(f.packets).toHaveLength(1); f.input.write(f.packets[0].replace("lock-check:", "lock-ok:"));
    await Promise.resolve(); beat(); expect(f.packets).toHaveLength(2);
    f.input.write(f.packets[1].replace("lock-check:", "lock-ok:")); await Promise.resolve(); f.lock.close();
  });
  it("closes a legitimate pending heartbeat without invoking fatal", async () => {
    const f = channels(); const pending = f.lock.assertOwned(); const cancelled = expect(pending).rejects.toThrow("LOCK_CLOSED");
    f.lock.close(); await cancelled; expect(f.fatal).not.toHaveBeenCalled(); expect(f.input.destroyed).toBe(true);
  });
  it("fails immediately on closed host channel before final writes", async () => {
    const f = channels(); const pending = f.lock.assertOwned(); const failure = expect(pending).rejects.toThrow("LOCK_NOT_OWNED");
    f.input.emit("end"); await failure; expect(f.fatal).toHaveBeenCalledTimes(1); f.lock.close();
  });
  const linked = { status: "linked", leadId: 123, businessStatePreserved: true, accountStatusPreserved: true, assignmentNeeded: true, directMorekitDispatchAttempted: false, contactPosts: 1, leadPosts: 1, patchPosts: 1, notePosts: 1 };
  it("emits only strictly projected safe outcome, never assignment completed", () => {
    expect(JSON.parse(runner.safeReport(linked))).toEqual(linked);
    expect(runner.safeReport({ status: "prior_operation_readonly", automaticRetryBlocked: true, assignmentNeeded: true, directMorekitDispatchAttempted: false, databaseWrites: false, contactPosts: 0, leadPosts: 0, patchPosts: 0, notePosts: 0 })).not.toMatch(/private|phone|token|email/);
  });
  it.each([
    ["plan", "planned", true], ["plan", "linked", false], ["apply", "linked", true],
    ["apply", "unresolved", false], ["apply", "prior_operation_readonly", false],
  ])("treats only the intended terminal outcome as successful: %s/%s", (mode, status, success) => {
    expect(runner.isSuccessfulResultForMode(mode, status)).toBe(success);
  });
  it("passes every real safeReport outcome through the exact workflow jq validator", () => {
    const filter = stream.match(/report=\$\(printf '%s' "\$encoded" \| base64 -d \| jq -ce '\n([\s\S]*?)' 2>\/dev\/null\)/)?.[1];
    expect(filter).toBeDefined();
    const planned = { status: "planned", mutationAuthorized: false, databaseWrites: false, amoWrites: false,
      caseHash: "a".repeat(64), candidateHash: "b".repeat(64), sourceSha256: "c".repeat(64), deployedGitSha: "d".repeat(40) };
    const unresolved = { status: "unresolved", automaticRetryBlocked: true, assignmentNeeded: true, directMorekitDispatchAttempted: false,
      failureCode: "LEAD_UNCONFIRMED", contactPosts: 1, leadPosts: 1, patchPosts: 0, notePosts: 0 };
    const prior = { status: "prior_operation_readonly", automaticRetryBlocked: true, assignmentNeeded: true, directMorekitDispatchAttempted: false,
      databaseWrites: false, contactPosts: 0, leadPosts: 0, patchPosts: 0, notePosts: 0 };
    const jq = process.env.JQ_PATH || "jq";
    for (const result of [planned, linked, unresolved, prior]) {
      const projected = runner.safeReport(result);
      const checked = spawnSync(jq, ["-ce", filter!], { input: projected, encoding: "utf8", timeout: 5000 });
      expect({ error: checked.error?.message, status: checked.status, stderr: checked.stderr }).toEqual({ error: undefined, status: 0, stderr: "" });
      expect(JSON.parse(checked.stdout)).toEqual(JSON.parse(projected));
    }
    const stale = spawnSync(jq, ["-ce", filter!], { input: JSON.stringify({ ...linked, directMorekitDispatchAttempted: undefined, morekitSent: false }), encoding: "utf8", timeout: 5000 });
    expect(stale.status).not.toBe(0);
    expect(stale.stdout).toBe("");
  });
  it.each([{ phone: "private" }, { failureCode: "PRIVATE_ERROR" }, { leadPosts: 2 }, { patchPosts: 2 }, { notePosts: 2 }, { directMorekitDispatchAttempted: true }, { leadId: "123" }, { accountStatusPreserved: false }, { status: "completed" }])("refuses untrusted or misleading report fields", (change) => {
    expect(() => runner.safeReport({ ...linked, ...change })).toThrow("refused");
  });
  it("emits only an exact whitelisted refusal code and never raw provider text", () => {
    expect(runner.safeRefusalCode({ safeCode: "CERT_CALLTOUCH_PROVENANCE_INVALID", message: "private token +79990001122" })).toBe("CERT_CALLTOUCH_PROVENANCE_INVALID");
    expect(runner.safeRefusalCode({ safeCode: "CERT_PRIVATE_TOKEN_79990001122", message: "private token" })).toBe("UNCLASSIFIED_REFUSAL");
    expect(runner.safeRefusalCode(Error("private@example.test"))).toBe("UNCLASSIFIED_REFUSAL");
  });
    it.each(["EVIDENCE_NOT_FRESH", "CLIENT_CONTACT_EVIDENCE_CHANGED", "WINDOW_REQUEST_FAILED", "REVIEW_NOTES_REQUEST_REJECTED",
      "PREFLIGHT_SNAPSHOT_FAILED", "PREFLIGHT_ACCOUNT_FAILED", "PREFLIGHT_EVIDENCE_FAILED", "PREFLIGHT_CERTIFICATE_FAILED",
      "PREFLIGHT_PLAN_BINDING_FAILED", "PREFLIGHT_PRIOR_AUDIT_FAILED", "PREFLIGHT_NEGATIVE_FAILED"])("classifies literal readonly preflight failure %s without raw error output", (safeCode) => {
      expect(runner.safeRefusalCode({ safeCode, message: "private token +79990001122", code: "PRIVATE_VALUE" })).toBe(safeCode);
      expect(runner.safeRefusalCode({ code: safeCode, message: "private token" })).toBe("UNCLASSIFIED_REFUSAL");
    });
  it("Redis uses only current runtime settings, bounded connect, no reconnect strategy", () => {
    const Redis = jest.fn(); runner.createRedis(Redis, { REDIS_HOST: "redis", REDIS_PORT: "6379", REDIS_DB: "0" });
    const options = Redis.mock.calls[0][0]; expect(options).toMatchObject({ host: "redis", port: 6379, db: 0, lazyConnect: true, connectTimeout: 5000 });
    expect(options.retryStrategy()).toBe(null);
  });
  it.each([{ REDIS_DB: "2" }, { REDIS_DB: "00" }, { REDIS_HOST: "different-host" }, { REDIS_PORT: "6380" }, { REDIS_PASSWORD: "private-fixture" }])("refuses Redis settings which differ from live API lease connection", (changes) => {
    const Redis = jest.fn();
    expect(() => runner.createRedis(Redis, { REDIS_HOST: "redis", REDIS_PORT: "6379", ...changes })).toThrow("refused");
    expect(Redis).not.toHaveBeenCalled();
  });
  it("pins production, reviewed plan, first attempt, exact deployed SHA, CI and separate runtime checkout", () => {
    expect(workflow.permissions).toEqual({ contents: "read", actions: "read" });
    expect(workflow.concurrency).toEqual({ group: "production-deploy", "cancel-in-progress": false });
    expect(workflow.jobs.apply.environment).toBe("production");
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(["mode", "confirmation", "plan_run_id", "expected_case_hash", "expected_candidate_hash", "expected_deployed_sha", "backup_run_id", "ci_run_id"]);
    expect(runtimeCheckoutStep.with.path).toBe(".fixed-case-runtime"); expect(runtimeCheckoutStep.with.ref).toBe("${{ steps.gate.outputs.deployed_sha }}");
    expect(gateStep.run).toContain('test "$EXPECTED_RUN_ATTEMPT" = 1');
    expect(gateStep.run).toContain('test "$EXPECTED_ACTOR" = mefremov888-ai');
    expect(gateStep.run).toContain('test "$reviewed_deployed_sha" = "$deployed_sha"');
    expect(gateStep.run).toContain('.path == ".github/workflows/apply-fixed-amo-fixation-case.yml"');
    expect(gateStep.run).toContain('.path == ".github/workflows/deploy.yml"');
    expect(buildStep.run).toContain("npm ci --ignore-scripts");
    expect(stream).toContain('-o StrictHostKeyChecking=yes'); expect(stream).toContain('test "$(ssh-keygen -lf "$known_hosts"');
    expect(stream).toContain('root=$(mktemp -d /tmp/st-michael-fixed-case.XXXXXX)');
    expect(stream).toContain('-e FIXED_CASE_PLAN_RUN_ID="$plan_run"');
    expect(stream).toContain('test "$EXPECTED_ACTOR" = mefremov888-ai');
    for (const relative of Object.values(runner.FILES)) expect(stream).toContain(relative);
    expect(stream).toContain('fixed_case_runner_refused_code=UNCLASSIFIED_REFUSAL');
    expect(stream).not.toContain('cat "$runner_stderr"');
    expect(stream).toContain("exit_status=1");
    expect(stream).toContain('test "${#safe_lines[@]}" -eq 6');
    expect(stream).toContain('test "${#safe_lines[@]}" -eq 7');
  });
  it("downloads an immutable plan artifact and runs the real Bash+jq hash binding before build", () => {
    expect(downloadPlanStep.if).toBe("${{ inputs.mode == 'apply' }}");
    expect(downloadPlanStep.uses).toBe("actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093");
    expect(downloadPlanStep.with).toMatchObject({ name: "fixed-amo-case-plan-attestation", "run-id": "${{ inputs.plan_run_id }}" });
    expect(uploadPlanStep.if).toBe("${{ inputs.mode == 'plan' }}");
    expect(uploadPlanStep.uses).toBe("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
    expect(uploadPlanStep.with).toMatchObject({ name: "fixed-amo-case-plan-attestation", "retention-days": 1, overwrite: false });
    expect(steps.indexOf(bindPlanStep)).toBeLessThan(steps.indexOf(buildStep));
    const temp = mkdtempSync(resolve(tmpdir(), "fixed-plan-bind-"));
    try {
      const directory = resolve(temp, "fixed-amo-case-plan-review"); mkdirSync(directory);
      const file = resolve(directory, "fixed-amo-case-plan-attestation.json");
      const attestation = { schemaVersion: 1, mode: "plan", repository: "sereganikitin/st-michael-broker-platform", actor: "mefremov888-ai",
        planRunId: "123455", sourceGitSha: "a".repeat(40), deployedGitSha: "b".repeat(40), caseHash: "c".repeat(64), candidateHash: "d".repeat(64),
        sourceSha256: "e".repeat(64), mutationAuthorized: false, databaseWrites: false, amoWrites: false };
      writeFileSync(file, JSON.stringify(attestation));
      let path = process.env.PATH;
      if (process.env.JQ_PATH) { copyFileSync(process.env.JQ_PATH, resolve(temp, "jq.exe")); path = `${temp};${path}`; }
      const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
      const environment = { ...process.env, PATH: path, RUNNER_TEMP: temp.replace(/\\/g, "/"), EXPECTED_REPOSITORY: attestation.repository,
        EXPECTED_ACTOR: attestation.actor, EXPECTED_SHA: attestation.sourceGitSha, PLAN_RUN_ID: attestation.planRunId,
        EXPECTED_DEPLOYED_SHA: attestation.deployedGitSha, EXPECTED_CASE_HASH: attestation.caseHash, EXPECTED_CANDIDATE_HASH: attestation.candidateHash };
      const accepted = spawnSync(bash, ["-c", bindPlanStep.run], { env: environment, encoding: "utf8", timeout: 5000 });
      expect({ status: accepted.status, stderr: accepted.stderr }).toEqual({ status: 0, stderr: "" });
      writeFileSync(file, JSON.stringify({ ...attestation, candidateHash: "f".repeat(64) }));
      const refused = spawnSync(bash, ["-c", bindPlanStep.run], { env: environment, encoding: "utf8", timeout: 5000 });
      expect(refused.status).not.toBe(0);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
  it.each(["1", "01", "2", "", "true", "1\n"])("actual trusted Bash run-attempt gate accepts only literal first attempt: %j", (attempt) => {
    const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
    const gate = gateStep.run.split("\n").find((line: string) => line.includes('test "$EXPECTED_RUN_ATTEMPT" = 1'));
    const result = spawnSync(bash, ["-c", `${gate}\nprintf gate_passed`], { env: { ...process.env, EXPECTED_RUN_ATTEMPT: attempt }, encoding: "utf8", timeout: 5000 });
    expect(result.status).toBe(attempt === "1" ? 0 : 1);
    expect(result.stdout).toBe(attempt === "1" ? "gate_passed" : "");
  });
  it("uses existing physical root600 exclusive lock, continuously checks path AND fd inode", () => {
    expect(stream).toContain('exec 9<"$lock_path"'); expect(stream).toContain('flock -x -n 9');
    expect(stream).toContain('test "$(stat -Lc \'%a:%u\' "$lock_path")" = 600:0');
    expect(stream).toContain('"/proc/$$/fd/9")" = "$lock_identity"');
    const loop = stream.split("while true; do")[1].split("exit_status=0;")[0];
    expect(loop).toContain('assert_lock || { terminate_runner; exit 1; }');
    expect(loop).toContain('read -r -t 0.25 -n 4097'); expect(loop).toContain('printf \'lock-ok:%s\\n\'');
    expect(stream).toContain('9<&- 7>&- 6>&- &'); // Docker child must not retain host lock or FIFO writer.
    expect(stream).toContain('argv[1]!==root+"/scripts/run-fixed-amo-fixation-case.js"');
    expect(stream).toContain('process.kill(pid,"SIGKILL")');
  });
  (process.platform === "win32" ? it.skip : it)("actual Linux flock excludes another owner and actual fd/path inode guard rejects replacement", () => {
    // The unprivileged CI fixture maps only its own mode600 UID to root for
    // production's ownership predicate. flock and both inode stat calls are
    // real; no production file, Docker, database or provider is accessed.
    const guard = stream.match(/assert_lock\(\) \{[\s\S]*?\n\}/)?.[0];
    expect(guard).toBeDefined(); expect(guard!.length).toBeLessThan(1000);
    expect(guard).not.toMatch(/docker|curl|ssh|git|psql|node|rm /);
    const program = `set -euo pipefail
      task_dir=$(mktemp -d)
      trap 'exec 9<&- 10<&-; rm -f -- "$task_dir/lock" "$task_dir/replacement"; rmdir -- "$task_dir"' EXIT
      lock_path="$task_dir/lock"
      printf fixture > "$lock_path"; chmod 600 "$lock_path"
      stat() {
        if [ "$2" = '%a:%u' ]; then
          actual=$(command stat "$@")
          test "$actual" = "600:$(id -u)" || return 1
          printf '600:0\\n'
        else command stat "$@"; fi
      }
      lock_identity=$(stat -Lc '%d:%i' "$lock_path")
      exec 9<"$lock_path"
      flock -x -n 9
      ${guard}
      assert_lock
      exec 10<"$lock_path"
      if flock -x -n 10; then exit 2; fi
      printf replacement > "$task_dir/replacement"
      chmod 600 "$task_dir/replacement"
      mv -T -- "$task_dir/replacement" "$lock_path"
      if assert_lock; then exit 3; fi
      printf fixture_verified`;
    const result = spawnSync("/bin/bash", ["-c", program], { encoding: "utf8", timeout: 5000 });
    expect(result.stderr).toBe(""); expect(result.status).toBe(0); expect(result.stdout).toBe("fixture_verified");
  });
  it("requires exact backup source/run, six hour freshness, private physical checksum and full decode", () => {
    expect(gateStep.run).toContain('.head_sha == $sha'); expect(gateStep.run).toContain('.run_attempt == 1');
    expect(gateStep.run).toContain('.path == ".github/workflows/backup-production-loyalty-predeploy.yml"');
    expect(stream).toContain('"$age" -le 21600'); expect(stream).toContain('loyalty-predeploy-${source_sha}-run${backup_run}-attempt1.dump');
    expect(stream).toContain('test "$(sha256sum "$backup"'); expect(stream).toContain('pg_restore --exit-on-error --no-owner --file=/dev/null');
    expect(stream).toContain('BEGIN READ ONLY; SET LOCAL statement_timeout=');
    expect(stream).not.toMatch(/git (fetch|reset|checkout|pull)|docker (restart|start|stop|kill|run|build|pull|compose)|(?:DROP|ALTER|DELETE FROM)|\.env|SMS_ENABLED|MorekitAdapter|\/hooks\//);
  });
  it("parses ALL actual Bash steps and assembled streamed program without executing any", () => {
    const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
    for (const step of steps.filter((step: any) => step.shell === "bash")) {
      const result = spawnSync(bash, ["-n"], { input: step.run, encoding: "utf8", timeout: 5000 });
      expect(result.stderr).toBe(""); expect(result.status).toBe(0);
    }
    const prefix = stream.split("<<'REMOTE_PREFIX'\n")[1].split("\nREMOTE_PREFIX")[0];
    const suffix = stream.split("<<'REMOTE_SUFFIX'\n")[1].split("\nREMOTE_SUFFIX")[0];
    const actual = `${prefix}\nZml4dHVyZQ==\nFIXED_CASE_PAYLOAD\n${suffix}`;
    const result = spawnSync(bash, ["-n"], { input: actual, encoding: "utf8", timeout: 5000 });
    expect(result.stderr).toBe(""); expect(result.status).toBe(0);
  });
});
