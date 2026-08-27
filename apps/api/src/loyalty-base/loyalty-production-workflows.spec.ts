import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";

describe("loyalty production workflow safety", () => {
  const repositoryRoot = resolve(__dirname, "../../../..");
  const readRepositoryFile = (path: string) =>
    readFileSync(resolve(repositoryRoot, path), "utf8");

  const deployWorkflow = readRepositoryFile(".github/workflows/deploy.yml");
  const rehearsalWorkflow = readRepositoryFile(
    ".github/workflows/rehearse-loyalty-migration.yml",
  );
  const inspectorWorkflow = readRepositoryFile(
    ".github/workflows/inspect-production-loyalty-state.yml",
  );
  const diskReclaimWorkflow = readRepositoryFile(
    ".github/workflows/reclaim-production-disk-no-restart.yml",
  );
  const buildCacheReclaimWorkflow = readRepositoryFile(
    ".github/workflows/reclaim-production-build-cache-no-restart.yml",
  );
  const backupWorkflow = readRepositoryFile(
    ".github/workflows/backup-production-loyalty-predeploy.yml",
  );
  const rollbackRetirementWorkflow = readRepositoryFile(
    ".github/workflows/retire-obsolete-production-rollback.yml",
  );
  const deployScript = readRepositoryFile("deploy-update.sh");
  const rehearsalScript = readRepositoryFile(
    "scripts/rehearse-loyalty-migration.sh",
  );
  const apiDockerfile = readRepositoryFile("docker/Dockerfile.api");
  const apiBuildConfig = JSON.parse(
    readRepositoryFile("apps/api/tsconfig.build.json"),
  ) as {
    compilerOptions?: Record<string, unknown>;
    exclude?: string[];
  };
  const loyaltySyncService = readRepositoryFile(
    "apps/api/src/loyalty-sync/loyalty-sync.service.ts",
  );
  const loyaltySyncServiceSpec = readRepositoryFile(
    "apps/api/src/loyalty-sync/loyalty-sync.service.spec.ts",
  );
  const migrationReadme = readRepositoryFile(
    "packages/database/prisma/migrations/README.md",
  );

  it("uses only the collision-safe, never-applied loyalty migration names", () => {
    const migrationRoot = resolve(
      repositoryRoot,
      "packages/database/prisma/migrations",
    );
    const currentNames = [
      "20260824000100_loyalty_workflows",
      "20260824000200_loyalty_event_restore_version",
      "20260824000300_loyalty_event_attachments",
    ];
    const retiredNames = [
      "20260821000200_loyalty_workflows",
      "20260821000300_loyalty_event_restore_version",
      "20260821000400_loyalty_event_attachments",
    ];

    for (const name of currentNames) {
      expect(existsSync(resolve(migrationRoot, name, "migration.sql"))).toBe(
        true,
      );
      expect(inspectorWorkflow + migrationReadme).toContain(name);
    }
    for (const name of retiredNames) {
      expect(existsSync(resolve(migrationRoot, name))).toBe(false);
      expect(inspectorWorkflow + migrationReadme).not.toContain(name);
    }
  });

  it("pins every mutating release SSH connection to the verified ED25519 key", () => {
    for (const workflow of [
      deployWorkflow,
      rehearsalWorkflow,
      backupWorkflow,
    ]) {
      expect(workflow).toContain("environment: production");
      expect(workflow).toContain(
        "EXPECTED_SSH_FINGERPRINT: ${{ vars.DEPLOY_HOST_FINGERPRINT }}",
      );
      expect(workflow).toContain(
        'ssh-keyscan -p "$SSH_PORT" -t ed25519 "$SSH_HOST"',
      );
      expect(workflow).toContain(
        'test "${fingerprints[0]}" = "$EXPECTED_SSH_FINGERPRINT"',
      );
      expect(workflow).toContain("-o HostKeyAlgorithms=ssh-ed25519");
      expect(workflow).toContain("-o StrictHostKeyChecking=yes");
      expect(workflow).toContain('-o UserKnownHostsFile="$known_hosts"');
      expect(workflow).toContain("^SHA256:[A-Za-z0-9+/]{43}$");
      expect(workflow).not.toContain("appleboy/ssh-action");
      expect(workflow).not.toContain("fingerprint:");
      expect(workflow).not.toContain('echo "$EXPECTED_SSH_FINGERPRINT"');
    }
    expect(rehearsalWorkflow).toContain("group: production-deploy");
    expect(rehearsalWorkflow).toContain(
      "DEPLOY_PATH: ${{ secrets.DEPLOY_PATH }}",
    );
    expect(rehearsalWorkflow).not.toContain('cd "${{ secrets.DEPLOY_PATH }}"');
  });

  it("streams only the reviewed deploy environment allowlist through encrypted stdin", () => {
    const allowlistStart = deployWorkflow.indexOf("forwarded_names=(");
    const allowlistEnd = deployWorkflow.indexOf(
      "\n          )",
      allowlistStart,
    );
    const forwardedNames = deployWorkflow
      .slice(allowlistStart + "forwarded_names=(".length, allowlistEnd)
      .match(/[A-Z][A-Z0-9_]*/g);
    const sshPipeStart = deployWorkflow.indexOf(
      "} | timeout --foreground 75m ssh -T",
      allowlistEnd,
    );
    const sshPipeEnd = deployWorkflow.indexOf("'bash -s'", sshPipeStart);
    const sshCommand = deployWorkflow.slice(sshPipeStart, sshPipeEnd);

    expect(forwardedNames).toEqual([
      "AMO_ACCESS_TOKEN",
      "AMO_CLIENT_ID",
      "AMO_CLIENT_SECRET",
      "AMO_REFRESH_TOKEN",
      "BROKER_CONTACT_GATE_HMAC_KEY",
      "MANGO_API_KEY",
      "MANGO_API_SALT",
      "MANGO_API_URL",
      "MANGO_CALLBACK_URL",
      "MANGO_OUTBOUND_LINE",
      "SMTP_HOST",
      "SMTP_PORT",
      "SMTP_USER",
      "SMTP_PASS",
      "SMTP_FROM",
      "SMTP_SECURE",
      "DADATA_API_KEY",
      "ANTHROPIC_API_KEY",
      "GOOGLE_SERVICE_ACCOUNT_JSON",
      "TELEGRAM_BOT_TOKEN",
      "OPS_TELEGRAM_BOT_TOKEN",
      "OPS_ALERT_CHAT_ID",
      "OPS_ALERT_CHAT_IDS",
      "EXPECTED_DEPLOY_SHA",
      "ATTESTED_BACKUP_RUN_ID",
      "ATTESTED_BACKUP_RUN_ATTEMPT",
      "PRODUCTION_PG_SYSTEM_IDENTIFIER",
      "PRODUCTION_MIN_BROKER_ROWS",
      "PRODUCTION_COMPOSE_OVERRIDE_SHA256",
      "DEPLOY_PATH",
    ]);
    expect(deployWorkflow).toContain(
      'printf \'export %s=%q\\n\' "$forwarded_name" "${!forwarded_name}"',
    );
    expect(deployWorkflow).toContain("cat <<'REMOTE'");
    expect(sshPipeStart).toBeGreaterThan(allowlistEnd);
    expect(sshPipeEnd).toBeGreaterThan(sshPipeStart);
    expect(sshCommand).not.toMatch(
      /AMO_|MANGO_|SMTP_|DADATA_|ANTHROPIC_|GOOGLE_|TELEGRAM_/,
    );
    expect(deployWorkflow).not.toContain("SendEnv");
  });

  it("requires a fresh successful exact-SHA rehearsal before manual deploy", () => {
    const attestationGate = deployWorkflow.indexOf(
      "Verify exact successful rehearsal attestation",
    );
    const sshDeploy = deployWorkflow.indexOf("Deploy via SSH");
    const attestationBody = deployWorkflow.slice(attestationGate, sshDeploy);

    expect(rehearsalWorkflow).toContain(
      "EXPECTED_REHEARSAL_SHA: ${{ github.sha }}",
    );
    expect(rehearsalWorkflow).toContain("DEPLOY_PATH=$1");
    expect(rehearsalWorkflow).toContain("EXPECTED_REHEARSAL_SHA=$2");
    expect(rehearsalWorkflow).toContain("<<'REMOTE'");
    expect(rehearsalWorkflow).toContain(
      'if [ "$TRUSTED_REHEARSAL_SHA" != "$EXPECTED_REHEARSAL_SHA" ]; then',
    );
    expect(rehearsalWorkflow).toContain(
      'git show "$EXPECTED_REHEARSAL_SHA:scripts/rehearse-loyalty-migration.sh"',
    );
    expect(deployWorkflow).toContain("actions: read");
    expect(deployWorkflow).toContain("GH_TOKEN: ${{ github.token }}");
    expect(deployWorkflow).toContain(
      "/actions/workflows/rehearse-loyalty-migration.yml/runs",
    );
    expect(deployWorkflow).toContain("-f event=workflow_dispatch");
    expect(deployWorkflow).toContain("-f status=completed");
    expect(deployWorkflow).toContain('-f head_sha="$EXPECTED_DEPLOY_SHA"');
    expect(deployWorkflow).toContain('.conclusion == "success"');
    expect(deployWorkflow).toContain(".head_sha == $sha");
    expect(deployWorkflow).toContain(".repository.full_name == $repo");
    expect(deployWorkflow).toContain(".head_repository.full_name == $repo");
    expect(deployWorkflow).toContain(
      'test "$EXPECTED_REPOSITORY" = "$CANONICAL_REPOSITORY"',
    );
    expect(deployWorkflow).toContain('[ "$rehearsal_age_seconds" -gt 21600 ]');
    expect(deployWorkflow).toContain(
      "if: github.event_name == 'workflow_dispatch' && inputs.confirm_production",
    );
    expect(deployWorkflow).toContain(
      "if: always() && github.event_name == 'push' && needs.verify.result == 'success'",
    );
    expect(attestationBody).not.toContain("secrets.");
    expect(attestationBody).not.toContain("inputs.");
    expect(attestationGate).toBeGreaterThan(-1);
    expect(sshDeploy).toBeGreaterThan(attestationGate);
  });

  it("gates every inspector table family behind migration flags", () => {
    const firstMigrationGset = inspectorWorkflow.indexOf("\\gset");
    const baseGate = inspectorWorkflow.indexOf(
      "\\if :loyalty_migration_applied",
    );
    const firstBaseTable = inspectorWorkflow.indexOf(
      "FROM public.loyalty_datasets",
    );
    const sourceGate = inspectorWorkflow.indexOf(
      "\\if :source_aggregate_schema_ready",
    );
    const sourceAggregateTable = inspectorWorkflow.indexOf(
      "LEFT JOIN public.loyalty_source_aggregates",
    );
    const workflowGate = inspectorWorkflow.indexOf(
      "\\if :workflow_schema_ready",
    );
    const workflowTable = inspectorWorkflow.indexOf(
      "FROM public.loyalty_call_campaigns",
    );
    const attachmentGate = inspectorWorkflow.indexOf(
      "\\if :attachment_schema_ready",
    );
    const attachmentTable = inspectorWorkflow.indexOf(
      "FROM public.loyalty_event_attachments",
    );

    expect(firstMigrationGset).toBeGreaterThan(-1);
    expect(baseGate).toBeGreaterThan(firstMigrationGset);
    expect(firstBaseTable).toBeGreaterThan(baseGate);
    expect(sourceAggregateTable).toBeGreaterThan(sourceGate);
    expect(workflowTable).toBeGreaterThan(workflowGate);
    expect(attachmentTable).toBeGreaterThan(attachmentGate);
    expect(inspectorWorkflow).toContain("\\if :event_restore_schema_ready");
    expect(inspectorWorkflow).toContain("=unavailable");
    expect(inspectorWorkflow).toContain(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
  });

  it("blocks incompatible old-image rollback before replacing containers", () => {
    const compatibilityFunction = deployScript.indexOf(
      "previous_api_schema_is_compatible() {",
    );
    const rollbackFunction = deployScript.indexOf("rollback_application() {");
    const compatibilityBody = deployScript.slice(
      compatibilityFunction,
      rollbackFunction,
    );
    const compatibilityCheck = deployScript.indexOf(
      "if ! previous_api_schema_is_compatible; then",
      rollbackFunction,
    );
    const quiesceCurrentApi = deployScript.indexOf(
      "rollback_compose stop -t 30 api",
      compatibilityFunction,
    );
    const verifyCurrentApiStopped = deployScript.indexOf(
      "docker inspect --format '{{.State.Running}}' st-michael-api",
      compatibilityFunction,
    );
    const incompatibleDecisionCount = deployScript.indexOf(
      "WHERE decision::text IN ('SUPPLEMENT', 'ARCHIVE')",
      compatibilityFunction,
    );
    const rollbackReplacement = deployScript.indexOf(
      'if ! rollback_compose -f docker-compose.yml -f "$ROLLBACK_OVERRIDE" up -d',
      rollbackFunction,
    );

    expect(compatibilityBody).toContain(
      "docker run --rm --network none --read-only --entrypoint /bin/sh",
    );
    expect(compatibilityBody).toContain('"$ROLLBACK_API_TAG"');
    expect(compatibilityBody.indexOf("docker run --rm")).toBeLessThan(
      compatibilityBody.indexOf(
        "WHERE decision::text IN ('SUPPLEMENT', 'ARCHIVE')",
      ),
    );
    expect(deployScript).toContain(
      "WHERE decision::text IN ('SUPPLEMENT', 'ARCHIVE')",
    );
    expect(deployScript).toContain(
      "Apply a compatible forward fix or restore the confirmed predeploy database backup.",
    );
    expect(compatibilityCheck).toBeGreaterThan(rollbackFunction);
    expect(quiesceCurrentApi).toBeGreaterThan(compatibilityFunction);
    expect(verifyCurrentApiStopped).toBeGreaterThan(quiesceCurrentApi);
    expect(incompatibleDecisionCount).toBeGreaterThan(verifyCurrentApiStopped);
    expect(rollbackReplacement).toBeGreaterThan(compatibilityCheck);
    expect(rollbackReplacement).toBeGreaterThan(incompatibleDecisionCount);
    expect(migrationReadme).toContain(
      "enum expansion is practically backward-compatible only until",
    );
  });

  it("fails before builds below 8 GiB and exposes only a ready API", () => {
    const diskCheck = deployScript.indexOf("MIN_DEPLOY_AVAILABLE_KIB=8388608");
    const dockerRootDiscovery = deployScript.indexOf(
      "docker info --format '{{.DockerRootDir}}'",
    );
    const dockerRootResolution = deployScript.indexOf(
      'DOCKER_ROOT=$(readlink -f -- "$DOCKER_ROOT_REPORTED")',
    );
    const repositoryDiskCheck = deployScript.indexOf(
      'require_deploy_disk_headroom "deploy repository" "$DEPLOY_ROOT"',
    );
    const releaseContextDiskCheck = deployScript.indexOf(
      'require_deploy_disk_headroom "release context" "$RELEASE_CONTEXT"',
    );
    const dockerRootDiskCheck = deployScript.indexOf(
      'require_deploy_disk_headroom "Docker root" "$DOCKER_ROOT"',
    );
    const firstImageBuild = deployScript.indexOf("build api");
    const rollout = deployScript.indexOf(
      "if ! target_compose up -d --no-deps api web; then",
    );
    const readinessDecision = deployScript.indexOf(
      'if [ "$API_READY" -ne 1 ]; then',
      rollout,
    );
    const nginxExposure = deployScript.indexOf(
      "if ! reload_nginx_upstreams target; then",
      rollout,
    );

    expect(diskCheck).toBeGreaterThan(-1);
    expect(dockerRootDiscovery).toBeGreaterThan(diskCheck);
    expect(dockerRootResolution).toBeGreaterThan(dockerRootDiscovery);
    for (const requiredCheck of [
      repositoryDiskCheck,
      releaseContextDiskCheck,
      dockerRootDiskCheck,
    ]) {
      expect(requiredCheck).toBeGreaterThan(dockerRootResolution);
      expect(firstImageBuild).toBeGreaterThan(requiredCheck);
    }
    expect(deployScript).toContain(
      "Resolved DockerRootDir must be an existing absolute non-root directory.",
    );
    expect(deployScript.slice(diskCheck, firstImageBuild)).not.toMatch(
      /docker\s+(?:image\s+)?prune|journalctl|rm\s+-rf/,
    );
    expect(readinessDecision).toBeGreaterThan(rollout);
    expect(nginxExposure).toBeGreaterThan(readinessDecision);
  });

  it("pins the running application images before mutable build tags are replaced", () => {
    const provisionalCleanup = deployScript.indexOf(
      'if [ "${ROLLBACK_CAPTURE_COMMITTED:-0}" != "1" ]; then',
    );
    const captureRunningImages = deployScript.indexOf(
      "PREVIOUS_API_IMAGE=$(docker inspect",
    );
    const pinExistingImage = deployScript.indexOf(
      'docker tag "$running_image" "$rollback_tag"',
    );
    const ownApiImageTag = deployScript.indexOf("ROLLBACK_API_TAG_CREATED=1");
    const pinOrRecoverApi = deployScript.indexOf(
      'pin_or_recover_rollback_image api "$PREVIOUS_API_IMAGE" "$ROLLBACK_API_TAG"',
    );
    const ownWebImageTag = deployScript.indexOf("ROLLBACK_WEB_TAG_CREATED=1");
    const pinOrRecoverWeb = deployScript.indexOf(
      'pin_or_recover_rollback_image web "$PREVIOUS_WEB_IMAGE" "$ROLLBACK_WEB_TAG"',
    );
    const firstImageBuild = deployScript.indexOf("build api");
    const secondImageBuild = deployScript.indexOf("build web");
    const stageRollbackRecord = deployScript.indexOf(
      'ROLLBACK_RECORD_STAGING=$(mktemp "$ROLLBACK_DIR/.release-',
    );
    const commitRollbackCapture = deployScript.indexOf(
      "ROLLBACK_CAPTURE_COMMITTED=1",
    );
    const moveRollbackRecord = deployScript.indexOf(
      'mv -- "$ROLLBACK_RECORD_STAGING" "$ROLLBACK_RECORD"',
    );
    const ownRollbackRecord = deployScript.indexOf("ROLLBACK_RECORD_CREATED=1");
    const moveRollbackOverride = deployScript.indexOf(
      'mv -- "$ROLLBACK_OVERRIDE_STAGING" "$ROLLBACK_OVERRIDE"',
    );
    const ownRollbackOverride = deployScript.indexOf(
      "ROLLBACK_OVERRIDE_CREATED=1",
    );

    expect(provisionalCleanup).toBeGreaterThan(-1);
    expect(captureRunningImages).toBeGreaterThan(provisionalCleanup);
    expect(pinExistingImage).toBeGreaterThan(captureRunningImages);
    expect(pinExistingImage).toBeLessThan(firstImageBuild);
    expect(ownApiImageTag).toBeGreaterThan(pinExistingImage);
    expect(pinOrRecoverApi).toBeGreaterThan(ownApiImageTag);
    expect(pinOrRecoverApi).toBeLessThan(firstImageBuild);
    expect(ownApiImageTag).toBeLessThan(firstImageBuild);
    expect(ownWebImageTag).toBeGreaterThan(pinOrRecoverApi);
    expect(pinOrRecoverWeb).toBeGreaterThan(ownWebImageTag);
    expect(pinOrRecoverWeb).toBeLessThan(firstImageBuild);
    expect(ownWebImageTag).toBeLessThan(firstImageBuild);
    expect(secondImageBuild).toBeGreaterThan(firstImageBuild);
    expect(stageRollbackRecord).toBeGreaterThan(secondImageBuild);
    expect(moveRollbackRecord).toBeGreaterThan(stageRollbackRecord);
    expect(ownRollbackRecord).toBeGreaterThan(moveRollbackRecord);
    expect(moveRollbackOverride).toBeGreaterThan(ownRollbackRecord);
    expect(ownRollbackOverride).toBeGreaterThan(moveRollbackOverride);
    expect(commitRollbackCapture).toBeGreaterThan(ownRollbackOverride);
    expect(commitRollbackCapture).toBeGreaterThan(stageRollbackRecord);
    expect(deployScript).toContain(
      'docker image rm "$ROLLBACK_API_TAG" >/dev/null 2>&1 || true',
    );
    expect(deployScript).toContain(
      'docker image rm "$ROLLBACK_WEB_TAG" >/dev/null 2>&1 || true',
    );
    expect(deployScript).toContain(
      'mv -- "$ROLLBACK_RECORD_STAGING" "$ROLLBACK_RECORD"',
    );
    expect(deployScript).toContain(
      'mv -- "$ROLLBACK_OVERRIDE_STAGING" "$ROLLBACK_OVERRIDE"',
    );
    expect(deployScript).toContain(
      'if [ "${ROLLBACK_API_TAG_CREATED:-0}" = "1" ]; then',
    );
    expect(deployScript).toContain(
      'if [ "${ROLLBACK_WEB_TAG_CREATED:-0}" = "1" ]; then',
    );
    expect(deployScript).toContain(
      'if [ "${ROLLBACK_RECORD_CREATED:-0}" = "1" ]; then',
    );
    expect(deployScript).toContain(
      'if [ "${ROLLBACK_OVERRIDE_CREATED:-0}" = "1" ]; then',
    );
  });

  it("rebuilds a missing running-image record only from the exact trusted previous Git tree", () => {
    const captureRunningImages = deployScript.indexOf(
      "PREVIOUS_API_IMAGE=$(docker inspect",
    );
    const recoveryFunction = deployScript.indexOf(
      "prepare_rollback_recovery_context() {",
    );
    const ancestorGate = deployScript.indexOf(
      'git merge-base --is-ancestor "$PREVIOUS_DEPLOY_SHA" "$EXPECTED_DEPLOY_SHA"',
    );
    const archivePreviousTree = deployScript.indexOf(
      'git archive --format=tar "$PREVIOUS_DEPLOY_SHA"',
    );
    const fallbackDecision = deployScript.indexOf(
      'if docker image inspect "$running_image" >/dev/null 2>&1; then',
    );
    const ownApiTag = deployScript.indexOf("ROLLBACK_API_TAG_CREATED=1");
    const recoverApi = deployScript.indexOf(
      'pin_or_recover_rollback_image api "$PREVIOUS_API_IMAGE" "$ROLLBACK_API_TAG"',
    );
    const ownWebTag = deployScript.indexOf("ROLLBACK_WEB_TAG_CREATED=1");
    const recoverWeb = deployScript.indexOf(
      'pin_or_recover_rollback_image web "$PREVIOUS_WEB_IMAGE" "$ROLLBACK_WEB_TAG"',
    );
    const recoveredBuild = deployScript.indexOf("docker build --pull=false");
    const firstTargetBuild = deployScript.indexOf("build api");

    expect(recoveryFunction).toBeGreaterThan(captureRunningImages);
    expect(ancestorGate).toBeGreaterThan(recoveryFunction);
    expect(archivePreviousTree).toBeGreaterThan(ancestorGate);
    expect(fallbackDecision).toBeGreaterThan(archivePreviousTree);
    expect(recoveredBuild).toBeGreaterThan(fallbackDecision);
    expect(recoveredBuild).toBeLessThan(firstTargetBuild);
    expect(ownApiTag).toBeLessThan(recoverApi);
    expect(ownWebTag).toBeLessThan(recoverWeb);
    expect(deployScript).toContain(
      "ROLLBACK_RECOVERY_CONTEXT=$(mktemp -d /tmp/st-michael-rollback-recovery.XXXXXX)",
    );
    expect(deployScript).toContain(
      '/tmp/st-michael-rollback-recovery.*) rm -rf -- "$ROLLBACK_RECOVERY_CONTEXT"',
    );
    expect(deployScript).toContain(
      '--label "org.opencontainers.image.revision=$PREVIOUS_DEPLOY_SHA"',
    );
    expect(deployScript).toContain(
      '--label "com.stmichael.rollback.recovered=true"',
    );
    expect(deployScript).toContain(
      `--format '{{index .Config.Labels "org.opencontainers.image.revision"}}'`,
    );
    expect(deployScript).toContain(
      `--format '{{index .Config.Labels "com.stmichael.rollback.recovered"}}'`,
    );
    expect(deployScript).toContain(
      'echo "previous_api_image=$ROLLBACK_API_IMAGE"',
    );
    expect(deployScript).toContain(
      'echo "previous_web_image=$ROLLBACK_WEB_IMAGE"',
    );
    expect(deployScript).not.toMatch(/docker\s+(?:container\s+)?commit\b/);
    expect(deployScript).not.toMatch(/docker\s+(?:container\s+)?export\b/);
    expect(deployScript).not.toMatch(/docker\s+import\b/);
  });

  it("keeps the production API typecheck inside its one-GiB heap budget", () => {
    const narrowSheetsImport = "googleapis/build/src/apis/sheets";

    expect(loyaltySyncService).toContain(narrowSheetsImport);
    expect(loyaltySyncServiceSpec).toContain(narrowSheetsImport);
    expect(loyaltySyncService).not.toMatch(/from ["']googleapis["']/);
    expect(loyaltySyncServiceSpec).not.toMatch(/from ["']googleapis["']/);
    expect(apiDockerfile).toContain(
      "NODE_OPTIONS=--max-old-space-size=1024 npm run build --workspace=apps/api",
    );
    expect(apiDockerfile).not.toContain("--max-old-space-size=2048");
    expect(apiDockerfile).not.toMatch(/^\s*ENV\s+NODE_OPTIONS=/m);
    expect(apiBuildConfig.exclude).toEqual(
      expect.arrayContaining(["node_modules", "test", "dist", "**/*.spec.ts"]),
    );
    expect(apiBuildConfig.compilerOptions).toMatchObject({
      declaration: false,
      incremental: false,
      sourceMap: false,
    });
    expect(apiBuildConfig.compilerOptions?.noCheck).not.toBe(true);
  });

  it("keeps the live environment untouched until the verified rollout succeeds", () => {
    const liveCompose = deployScript.indexOf("live_compose() {");
    const targetCompose = deployScript.indexOf("target_compose() {");
    const rollbackCompose = deployScript.indexOf("rollback_compose() {");
    const envForwardingLoop = deployScript.indexOf("for VAR_NAME in \\");
    const envForwardingEnd = deployScript.indexOf(
      "unset VAR_NAME VAR_VALUE",
      envForwardingLoop,
    );
    const previousShaCapture = deployScript.indexOf(
      "PREVIOUS_DEPLOY_SHA=$(docker inspect",
    );
    const apiBuild = deployScript.indexOf("build api");
    const webBuild = deployScript.indexOf("build web");
    const rollbackMetadata = deployScript.indexOf(
      'ROLLBACK_RECORD_STAGING=$(mktemp "$ROLLBACK_DIR/.release-',
    );
    const migrateDeploy = deployScript.indexOf("prisma migrate deploy");
    const rollout = deployScript.indexOf(
      "target_compose up -d --no-deps api web",
    );
    const externalReadiness = deployScript.indexOf(
      "https://broker.stmichael.ru/api/health/ready",
      rollout,
    );
    const migrateStatus = deployScript.indexOf(
      "prisma migrate status",
      rollout,
    );
    const finalComposeState = deployScript.indexOf(
      "if ! target_compose ps; then",
      migrateStatus,
    );
    const envActivation = deployScript.indexOf(
      'mv -- "$ENV_STAGING_FILE" "$SERVER_ENV_FILE"',
    );
    const rollbackFunction = deployScript.indexOf("rollback_application() {");
    const failFunction = deployScript.indexOf("fail_after_rollout() {");
    const rollbackBody = deployScript.slice(rollbackFunction, failFunction);

    expect(deployScript.slice(liveCompose, targetCompose)).toContain(
      '--env-file "$SERVER_ENV_FILE"',
    );
    expect(deployScript.slice(targetCompose, rollbackCompose)).toContain(
      '--env-file "$ENV_STAGING_FILE"',
    );
    expect(deployScript.slice(rollbackCompose, envForwardingLoop)).toContain(
      'GIT_SHA="$PREVIOUS_DEPLOY_SHA" docker compose',
    );
    expect(deployScript.slice(envForwardingLoop, envForwardingEnd)).toContain(
      'unset "$VAR_NAME"',
    );
    expect(previousShaCapture).toBeGreaterThan(envForwardingEnd);
    expect(apiBuild).toBeGreaterThan(previousShaCapture);
    expect(webBuild).toBeGreaterThan(apiBuild);
    expect(rollbackMetadata).toBeGreaterThan(webBuild);
    expect(migrateDeploy).toBeGreaterThan(rollbackMetadata);
    expect(rollout).toBeGreaterThan(migrateDeploy);
    expect(externalReadiness).toBeGreaterThan(rollout);
    expect(migrateStatus).toBeGreaterThan(externalReadiness);
    expect(finalComposeState).toBeGreaterThan(migrateStatus);
    expect(envActivation).toBeGreaterThan(finalComposeState);
    expect(
      deployScript.match(/mv -- "\$ENV_STAGING_FILE" "\$SERVER_ENV_FILE"/g),
    ).toHaveLength(1);
    expect(rollbackBody).toContain("rollback_compose");
    expect(rollbackBody).not.toContain("target_compose");
    expect(deployScript.slice(envActivation)).not.toMatch(
      /(?:target|live|rollback)_compose|git log|\$\(/,
    );
  });

  it("waits for the exact isolated rehearsal database before restore", () => {
    const temporaryDatabaseStart = rehearsalScript.indexOf(
      "-e POSTGRES_DB=rehearsal",
    );
    const databaseReadiness = rehearsalScript.indexOf(
      "psql -U postgres -d rehearsal -Atqc 'SELECT 1'",
      temporaryDatabaseStart,
    );
    const finalServerReadiness = rehearsalScript.indexOf(
      `'[ "$(cat /proc/1/comm)" = postgres ]'`,
      temporaryDatabaseStart,
    );
    const restore = rehearsalScript.indexOf(
      "pg_restore -U postgres -d rehearsal",
      databaseReadiness,
    );

    expect(temporaryDatabaseStart).toBeGreaterThan(-1);
    expect(finalServerReadiness).toBeGreaterThan(temporaryDatabaseStart);
    expect(databaseReadiness).toBeGreaterThan(finalServerReadiness);
    expect(restore).toBeGreaterThan(databaseReadiness);
    expect(
      rehearsalScript.slice(temporaryDatabaseStart, restore),
    ).not.toContain("pg_isready -U postgres");
    expect(rehearsalScript).toContain('docker rm -f -v "$REHEARSAL_ID"');
  });

  it("requires a fresh successful exact-SHA backup before manual deploy", () => {
    const backupGate = deployWorkflow.indexOf(
      "      - name: Verify exact successful backup attestation",
    );
    const rehearsalGate = deployWorkflow.indexOf(
      "Verify exact successful rehearsal attestation",
    );
    const backupAttestationBody = deployWorkflow.slice(
      backupGate,
      rehearsalGate,
    );
    const backupAttestationHeader = backupAttestationBody.slice(
      0,
      backupAttestationBody.indexOf("\n        run: |"),
    );
    const sshDeploy = deployWorkflow.indexOf("      - name: Deploy via SSH");
    const sshDeployScript = deployWorkflow.indexOf(
      "\n        run: |",
      sshDeploy,
    );
    const sshDeployHeader = deployWorkflow.slice(sshDeploy, sshDeployScript);
    const liveBackupCheck = deployWorkflow.indexOf(
      'BACKUP_FILE="$BACKUP_DIR/loyalty-predeploy-',
      sshDeploy,
    );
    const trustedDeployScript = deployWorkflow.indexOf(
      "TRUSTED_DEPLOY_SCRIPT=$(mktemp",
      sshDeploy,
    );
    const liveBackupBody = deployWorkflow.slice(
      liveBackupCheck,
      trustedDeployScript,
    );

    expect(deployWorkflow).toContain(
      "/actions/workflows/backup-production-loyalty-predeploy.yml/runs",
    );
    expect(backupAttestationBody).toContain("-f event=workflow_dispatch");
    expect(backupAttestationBody).toContain("-f status=completed");
    expect(backupAttestationBody).toContain(
      '-f head_sha="$EXPECTED_DEPLOY_SHA"',
    );
    expect(backupAttestationBody).toContain('.conclusion == "success"');
    expect(backupAttestationBody).toContain(".head_sha == $sha");
    expect(backupAttestationBody).toContain(".repository.full_name == $repo");
    expect(backupAttestationBody).toContain(
      ".head_repository.full_name == $repo",
    );
    expect(backupAttestationBody).toContain(
      '[ "$backup_age_seconds" -gt 21600 ]',
    );
    expect(backupAttestationHeader).not.toMatch(/^\s+if:/m);
    expect(backupAttestationHeader).not.toContain("continue-on-error:");
    expect(sshDeployHeader).not.toMatch(/^\s+if:/m);
    expect(sshDeployHeader).not.toContain("continue-on-error:");
    expect(backupAttestationBody).toContain(".id | tostring");
    expect(backupAttestationBody).toContain(".run_attempt | tostring");
    expect(backupAttestationBody).toContain('>> "$GITHUB_OUTPUT"');
    expect(deployWorkflow).toContain(
      "ATTESTED_BACKUP_RUN_ID: ${{ steps.backup_attestation.outputs.run_id }}",
    );
    expect(deployWorkflow).toContain(
      "ATTESTED_BACKUP_RUN_ATTEMPT: ${{ steps.backup_attestation.outputs.run_attempt }}",
    );
    expect(liveBackupBody).toContain('test -f "$BACKUP_FILE"');
    expect(liveBackupBody).toContain('test ! -L "$BACKUP_FILE"');
    expect(liveBackupBody).toContain('sha256sum -- "$BACKUP_FILE"');
    expect(liveBackupBody).toContain(
      'test "$ACTUAL_BACKUP_SHA256" = "$EXPECTED_BACKUP_SHA256"',
    );
    expect(liveBackupBody).toContain(
      "docker exec -i st-michael-postgres pg_restore --list",
    );
    expect(liveBackupBody).toContain("--file=/dev/null");
    expect(liveBackupBody).not.toMatch(
      /(?:--dbname(?:=|\s)|(?:^|\s)-d(?:\s|=))/m,
    );
    expect(liveBackupBody).not.toMatch(
      /--(?:table|schema|section|use-list|filter|data-only|schema-only)\b/,
    );
    expect(liveBackupBody).not.toContain("|| true");
    expect(backupAttestationBody).not.toContain("secrets.");
    expect(backupAttestationBody).not.toContain("inputs.");
    expect(backupGate).toBeGreaterThan(-1);
    expect(rehearsalGate).toBeGreaterThan(backupGate);
    expect(liveBackupCheck).toBeGreaterThan(sshDeploy);
    expect(trustedDeployScript).toBeGreaterThan(liveBackupCheck);
  });

  it("reclaims only the explicitly approved no-restart disk targets", () => {
    const remoteStart = diskReclaimWorkflow.indexOf("<<'REMOTE'");
    const remoteEnd = diskReclaimWorkflow.indexOf(
      "\n          REMOTE",
      remoteStart,
    );
    const remoteBody = diskReclaimWorkflow.slice(remoteStart, remoteEnd);
    const reclaimJobStart = diskReclaimWorkflow.indexOf("\n  reclaim:");
    const reclaimStepsStart = diskReclaimWorkflow.indexOf(
      "\n    steps:",
      reclaimJobStart,
    );
    const reclaimJobHeader = diskReclaimWorkflow.slice(
      reclaimJobStart,
      reclaimStepsStart,
    );
    const remoteLines = remoteBody
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const enoughDiskDecision = remoteBody.indexOf(
      'if [ "$root_before" -ge "$MIN_AVAILABLE_BYTES" ]',
    );
    const journalVacuum = remoteBody.indexOf(
      "sudo -n journalctl --vacuum-size=300M >/dev/null 2>&1",
    );
    const danglingPrune = remoteBody.indexOf(
      "docker image prune -f >/dev/null",
    );
    const finalDiskGate = remoteBody.indexOf(
      'if [ "$root_after" -lt "$MIN_AVAILABLE_BYTES" ]',
    );

    expect(diskReclaimWorkflow).toContain("workflow_dispatch:");
    expect(diskReclaimWorkflow).toContain("confirm_cleanup:");
    expect(diskReclaimWorkflow).toContain("required: true");
    expect(diskReclaimWorkflow).toContain("default: false");
    expect(diskReclaimWorkflow).toContain("type: boolean");
    expect(reclaimJobHeader).not.toMatch(/^\s+if:/m);
    expect(diskReclaimWorkflow).toContain(
      "CONFIRM_CLEANUP: ${{ inputs.confirm_cleanup }}",
    );
    expect(diskReclaimWorkflow).toContain('test "$CONFIRM_CLEANUP" = "true"');
    expect(diskReclaimWorkflow).not.toContain("continue-on-error: true");
    expect(diskReclaimWorkflow).toContain("group: production-deploy");
    expect(diskReclaimWorkflow).toContain("cancel-in-progress: false");
    expect(diskReclaimWorkflow).toContain("environment: production");
    expect(diskReclaimWorkflow).toContain(
      "CANONICAL_REPOSITORY: sereganikitin/st-michael-broker-platform",
    );
    expect(diskReclaimWorkflow).toContain(
      'test "$EXPECTED_REF" = "refs/heads/master"',
    );
    expect(diskReclaimWorkflow).toContain(
      "EXPECTED_SSH_FINGERPRINT: ${{ vars.DEPLOY_HOST_FINGERPRINT }}",
    );
    expect(diskReclaimWorkflow).toContain("^SHA256:[A-Za-z0-9+/]{43}$");
    expect(diskReclaimWorkflow).toContain(
      'test "${fingerprints[0]}" = "$EXPECTED_SSH_FINGERPRINT"',
    );
    expect(remoteStart).toBeGreaterThan(-1);
    expect(remoteEnd).toBeGreaterThan(remoteStart);
    expect(remoteBody).toContain("MIN_AVAILABLE_BYTES=8589934592");
    expect(remoteBody).toContain(
      "exec 9>/tmp/st-michael-production-deploy.lock",
    );
    expect(remoteBody).toContain("flock -n 9");
    expect(remoteBody).toContain('available_bytes "$deploy_root"');
    expect(remoteBody).toContain("available_bytes /tmp");
    expect(remoteBody).toContain("docker info --format '{{.DockerRootDir}}'");
    expect(remoteBody).toContain("df -P -B1 --");
    expect(enoughDiskDecision).toBeGreaterThan(-1);
    expect(journalVacuum).toBeGreaterThan(enoughDiskDecision);
    expect(danglingPrune).toBeGreaterThan(journalVacuum);
    expect(finalDiskGate).toBeGreaterThan(danglingPrune);
    expect(remoteBody.match(/journalctl --vacuum-size=300M/g)).toHaveLength(1);
    expect(remoteBody.match(/docker image prune -f/g)).toHaveLength(1);
    expect(
      remoteLines.filter((line) => /\bdocker\s+image\s+prune\b/.test(line)),
    ).toEqual(["docker image prune -f >/dev/null"]);
    expect(remoteBody).not.toMatch(
      /\bdocker\s+image\s+prune\b[^\n]*(?:--all\b|-[A-Za-z]*a[A-Za-z]*\b)/,
    );
    expect(remoteBody).not.toMatch(
      /docker\s+(?:system|volume|builder|buildx|container|network)\s+prune|docker(?:-compose|\s+compose)|\bdocker\s+(?:rm|rmi|start|stop|restart|kill|run|exec|build|pull|push)\b|\b(?:systemctl|service|restart|stop|kill|psql|prisma|git|cp|mv|rm|rmdir|truncate|unlink|shred|tee|touch|dd|install|mkdir|ln|chmod|chown|find)\b/,
    );
    expect(remoteLines.filter((line) => /\bjournalctl\b/.test(line))).toEqual([
      "command -v journalctl >/dev/null",
      "sudo -n journalctl --vacuum-size=300M >/dev/null 2>&1",
    ]);
    expect(remoteLines.filter((line) => /\bsudo\b/.test(line))).toEqual([
      "command -v sudo >/dev/null",
      "sudo -n journalctl --vacuum-size=300M >/dev/null 2>&1",
    ]);
    expect(remoteLines.filter((line) => /\bdocker\b/.test(line))).toEqual([
      "command -v docker >/dev/null",
      "docker_root_reported=$(docker info --format '{{.DockerRootDir}}')",
      "dangling_before=$(docker image ls -q --filter dangling=true | sort -u | wc -l | tr -d '[:space:]')",
      "docker image prune -f >/dev/null",
      "dangling_after=$(docker image ls -q --filter dangling=true | sort -u | wc -l | tr -d '[:space:]')",
    ]);
    expect(remoteBody).toContain("root_after=$root_before");
    expect(remoteBody).toContain("deploy_after=$deploy_before");
    expect(remoteBody).toContain(
      "release_context_after=$release_context_before",
    );
    expect(remoteBody).toContain("docker_after=$docker_before");
    expect(remoteBody).toContain("dangling_after=$dangling_before");
    expect(remoteBody).toContain('echo "cleanup_threshold_satisfied=false"');
    expect(remoteBody).toContain('echo "cleanup_threshold_satisfied=true"');
    expect(remoteBody).not.toContain("|| true");
  });

  it("reclaims only reproducible Docker build cache without restarting production", () => {
    const remoteStart = buildCacheReclaimWorkflow.indexOf("<<'REMOTE'");
    const remoteEnd = buildCacheReclaimWorkflow.indexOf(
      "\n          REMOTE",
      remoteStart,
    );
    const remoteBody = buildCacheReclaimWorkflow.slice(remoteStart, remoteEnd);
    const remoteLines = remoteBody
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const pruneLines = remoteBody
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /\bdocker\s+\S+\s+prune\b/.test(line));
    const dockerCommandLines = remoteLines.filter(
      (line) =>
        /\bdocker\s+/.test(line) && !line.startsWith("for required_tool"),
    );
    const parsedWorkflow = parse(buildCacheReclaimWorkflow) as {
      jobs: Record<string, { steps: unknown[] }>;
    };
    const databaseChecks = Array.from(
      remoteBody.matchAll(/\n\s*assert_database\r?\n/g),
      (match) => match.index,
    );
    const lock = remoteBody.indexOf(
      "exec 9>/tmp/st-michael-production-deploy.lock",
    );
    const canonicalPrecheck = remoteBody.indexOf(
      "canonical_sha_before=$(canonical_master_sha)",
    );
    const fingerprintsBefore = remoteBody.indexOf(
      "containers_before=$(container_inventory | inventory_hash)",
    );
    const canonicalRecheck = remoteBody.indexOf(
      "canonical_sha_at_prune=$(canonical_master_sha)",
    );
    const builderPrune = remoteBody.indexOf(
      "docker builder prune --all --force",
    );
    const fingerprintsAfter = remoteBody.indexOf(
      "containers_after=$(container_inventory | inventory_hash)",
    );
    const finalThreshold = remoteBody.indexOf(
      'if [ "$root_after" -lt "$required_backup_bytes_after" ]',
    );

    expect(buildCacheReclaimWorkflow).toContain("workflow_dispatch:");
    expect(buildCacheReclaimWorkflow).toContain("confirm_cleanup:");
    expect(buildCacheReclaimWorkflow).toContain("required: true");
    expect(buildCacheReclaimWorkflow).toContain("default: false");
    expect(buildCacheReclaimWorkflow).toContain("type: boolean");
    expect(buildCacheReclaimWorkflow).toContain(
      "CONFIRM_CLEANUP: ${{ inputs.confirm_cleanup }}",
    );
    expect(buildCacheReclaimWorkflow).toContain(
      'test "$CONFIRM_CLEANUP" = "true"',
    );
    expect(buildCacheReclaimWorkflow).toContain(
      'test "$EXPECTED_REF" = "refs/heads/master"',
    );
    expect(buildCacheReclaimWorkflow).toContain(
      "EXPECTED_CLEANUP_SHA: ${{ github.sha }}",
    );
    expect(buildCacheReclaimWorkflow).toContain(
      "EXPECTED_SSH_FINGERPRINT: ${{ vars.DEPLOY_HOST_FINGERPRINT }}",
    );
    expect(buildCacheReclaimWorkflow).toContain(
      'test "${fingerprints[0]}" = "$EXPECTED_SSH_FINGERPRINT"',
    );
    expect(buildCacheReclaimWorkflow).toContain("group: production-deploy");
    expect(buildCacheReclaimWorkflow).toContain("cancel-in-progress: false");
    expect(buildCacheReclaimWorkflow).toContain("environment: production");
    expect(buildCacheReclaimWorkflow).not.toContain("continue-on-error: true");
    expect(Object.keys(parsedWorkflow.jobs)).toEqual(["reclaim"]);
    expect(parsedWorkflow.jobs.reclaim.steps).toHaveLength(1);
    expect(buildCacheReclaimWorkflow.match(/<<'REMOTE'/g)).toHaveLength(1);
    expect(
      buildCacheReclaimWorkflow.match(/ssh -i "\$private_key"/g),
    ).toHaveLength(1);
    expect(remoteStart).toBeGreaterThan(-1);
    expect(remoteEnd).toBeGreaterThan(remoteStart);
    expect(remoteBody).toContain("MIN_AVAILABLE_BYTES=8589934592");
    expect(remoteBody).toContain("BACKUP_SIZE_OVERHEAD_BYTES=67108864");
    expect(remoteBody).toContain(
      "CANONICAL_REPOSITORY_URL=https://github.com/sereganikitin/st-michael-broker-platform.git",
    );
    expect(remoteBody).toContain(
      'git ls-remote --exit-code "$CANONICAL_REPOSITORY_URL" refs/heads/master',
    );
    expect(remoteBody).toContain(
      'test "$canonical_sha_before" = "$expected_cleanup_sha"',
    );
    expect(remoteBody).toContain(
      'test "$canonical_sha_at_prune" = "$expected_cleanup_sha"',
    );
    expect(remoteBody).toContain(
      "required_backup_bytes=$((MIN_AVAILABLE_BYTES + database_size_bytes + BACKUP_SIZE_OVERHEAD_BYTES))",
    );
    expect(remoteBody).toContain(
      "exec 9>/tmp/st-michael-production-deploy.lock",
    );
    expect(remoteBody).toContain("flock -n 9");
    expect(remoteBody).toContain("container_inventory_sha256_before");
    expect(remoteBody).toContain("running_container_inventory_sha256_before");
    expect(remoteBody).toContain("tagged_image_inventory_sha256_before");
    expect(remoteBody).toContain("volume_inventory_sha256_before");
    expect(remoteBody).toContain("network_inventory_sha256_before");
    expect(remoteBody).toContain("{{.State.Pid}}");
    expect(remoteBody).toContain("{{.State.StartedAt}}");
    expect(remoteBody).toContain("{{.RestartCount}}");
    expect(remoteBody).toContain("{{json .Mounts}}");
    expect(remoteBody).toContain("docker volume inspect --format");
    expect(remoteBody).toContain("docker network inspect --format");
    expect(remoteBody).toContain('test -z "${DOCKER_HOST:-}"');
    expect(remoteBody).toContain('test "$(docker context show)" = "default"');
    expect(remoteBody).toContain("BACKUP_PARENT=/var/backups/stmichael");
    expect(remoteBody).toContain("BACKUP_DIR=$BACKUP_PARENT/loyalty-predeploy");
    expect(remoteBody).toContain('test ! -L "$BACKUP_PARENT"');
    expect(remoteBody).toContain('test ! -L "$BACKUP_DIR"');
    expect(remoteBody).toContain('available_bytes "$backup_storage_path"');
    expect(remoteBody).toContain(
      'git -C "$deploy_root" status --porcelain=v1 --untracked-files=all',
    );
    expect(remoteBody).toContain(
      'test "$containers_after" = "$containers_before"',
    );
    expect(remoteBody).toContain('test "$running_after" = "$running_before"');
    expect(remoteBody).toContain(
      'test "$tagged_images_after" = "$tagged_images_before"',
    );
    expect(remoteBody).toContain('test "$volumes_after" = "$volumes_before"');
    expect(remoteBody).toContain('test "$networks_after" = "$networks_before"');
    expect(remoteBody).toContain(
      'test "$deploy_head_after" = "$deploy_head_before"',
    );
    expect(remoteBody).toContain(
      'test "$deploy_status_after" = "$deploy_status_before"',
    );
    expect(remoteBody).toContain("backup_reserve_threshold_satisfied=true");
    expect(databaseChecks).toHaveLength(2);
    expect(lock).toBeGreaterThan(-1);
    expect(canonicalPrecheck).toBeGreaterThan(lock);
    expect(databaseChecks[0]).toBeGreaterThan(canonicalPrecheck);
    expect(fingerprintsBefore).toBeGreaterThan(databaseChecks[0]);
    expect(canonicalRecheck).toBeGreaterThan(fingerprintsBefore);
    expect(builderPrune).toBeGreaterThan(canonicalRecheck);
    expect(databaseChecks[1]).toBeGreaterThan(builderPrune);
    expect(fingerprintsAfter).toBeGreaterThan(databaseChecks[1]);
    expect(finalThreshold).toBeGreaterThan(fingerprintsAfter);
    expect(pruneLines).toEqual(["docker builder prune --all --force"]);
    expect(
      remoteBody.match(/docker builder prune --all --force/g),
    ).toHaveLength(1);
    expect(remoteBody).not.toMatch(
      /docker\s+(?:system|image|volume|container|network|buildx)\s+prune|docker(?:-compose|\s+compose)|\bdocker\s+(?:rm|rmi|start|stop|restart|kill|run|build|pull|push)\b/,
    );
    expect(remoteBody).not.toMatch(
      /\b(?:systemctl|service|restart|stop|kill|prisma|cp|mv|rm|rmdir|truncate|unlink|shred|tee|touch|dd|install|mkdir|ln|chmod|chown|find)\b/,
    );
    expect(remoteBody).not.toContain("|| true");
    expect(dockerCommandLines).toEqual([
      "docker inspect --format '{{.Id}}|{{.Image}}|{{.Name}}|{{.State.Status}}|{{.State.Pid}}|{{.State.StartedAt}}|{{.RestartCount}}|{{json .Mounts}}' \"$container_id\"",
      "done < <(docker container ls -aq --no-trunc | sort)",
      "docker container ls -q --no-trunc | sort",
      "docker image ls --digests --no-trunc --format '{{.Repository}}|{{.Tag}}|{{.ID}}|{{.Digest}}' \\",
      "docker volume inspect --format '{{.Name}}|{{.Driver}}|{{.Mountpoint}}|{{.Scope}}|{{json .Labels}}|{{json .Options}}' \"$volume_name\"",
      "done < <(docker volume ls -q | sort)",
      "docker network inspect --format '{{.Id}}|{{.Name}}|{{.Driver}}|{{.Scope}}|{{.Internal}}|{{.Attachable}}|{{json .Options}}|{{json .Labels}}' \"$network_id\"",
      "done < <(docker network ls -q --no-trunc | sort)",
      'test "$(docker inspect --format \'{{.State.Running}}\' st-michael-postgres 2>/dev/null)" = "true" || { echo "Production PostgreSQL container is not running"; exit 1; }',
      "docker exec st-michael-postgres pg_isready -U postgres -d broker_platform >/dev/null",
      'actual_database=$(docker exec st-michael-postgres psql -U postgres -d broker_platform --no-psqlrc -Atqc "SELECT current_database()")',
      'actual_system_identifier=$(docker exec st-michael-postgres psql -U postgres -d broker_platform --no-psqlrc -Atqc "SELECT system_identifier FROM pg_control_system()")',
      'broker_rows=$(docker exec st-michael-postgres psql -U postgres -d broker_platform --no-psqlrc -Atqc "SELECT COUNT(*) FROM public.brokers")',
      'database_size_bytes=$(docker exec st-michael-postgres psql -U postgres -d broker_platform --no-psqlrc -Atqc "SELECT pg_database_size(current_database())")',
      'test "$(docker context show)" = "default" || { echo "Docker default context is not active"; exit 1; }',
      "docker_endpoint=$(docker context inspect default --format '{{.Endpoints.docker.Host}}')",
      "docker_root_reported=$(docker info --format '{{.DockerRootDir}}')",
      "docker system df",
      "docker builder prune --all --force",
      "docker system df",
    ]);
    expect(
      remoteLines.filter((line) => />/.test(line.replaceAll("<none>", ""))),
    ).toEqual([
      'command -v "$required_tool" >/dev/null || { echo "Required cleanup tool is missing"; exit 1; }',
      "exec 9>/tmp/st-michael-production-deploy.lock",
      'test "$(docker inspect --format \'{{.State.Running}}\' st-michael-postgres 2>/dev/null)" = "true" || { echo "Production PostgreSQL container is not running"; exit 1; }',
      "docker exec st-michael-postgres pg_isready -U postgres -d broker_platform >/dev/null",
      'echo "Builder cache was the only approved target, but the backup reserve is still insufficient" >&2',
    ]);
    expect(remoteBody.match(/docker system df/g)).toHaveLength(2);
    expect(remoteBody.match(/docker exec st-michael-postgres/g)).toHaveLength(
      5,
    );
    expect(remoteBody).toContain("SELECT current_database()");
    expect(remoteBody).toContain(
      "SELECT system_identifier FROM pg_control_system()",
    );
    expect(remoteBody).toContain("SELECT COUNT(*) FROM public.brokers");
    expect(remoteBody).toContain("SELECT pg_database_size(current_database())");
  });

  it("creates a fresh exact-SHA DB backup without retention or service changes", () => {
    const backupJobStart = backupWorkflow.indexOf("\n  backup:");
    const backupStepsStart = backupWorkflow.indexOf(
      "\n    steps:",
      backupJobStart,
    );
    const backupJobHeader = backupWorkflow.slice(
      backupJobStart,
      backupStepsStart,
    );
    const sshStepStart = backupWorkflow.indexOf(
      "      - name: Create and fully decode-verify server-local backup",
    );
    const sshStepScript = backupWorkflow.indexOf(
      "\n        run: |",
      sshStepStart,
    );
    const sshStepHeader = backupWorkflow.slice(sshStepStart, sshStepScript);
    const remoteStart = backupWorkflow.indexOf("<<'REMOTE'", sshStepStart);
    const remoteEnd = backupWorkflow.indexOf("\n          REMOTE", remoteStart);
    const remoteBody = backupWorkflow.slice(remoteStart, remoteEnd);
    const lock = remoteBody.indexOf(
      "exec 8>/tmp/st-michael-production-deploy.lock",
    );
    const dump = remoteBody.indexOf("docker exec st-michael-postgres pg_dump");
    const restoreList = remoteBody.indexOf(
      "docker exec -i st-michael-postgres pg_restore --list",
    );
    const fullDecode = remoteBody.indexOf("--exit-on-error --no-owner");
    const hash = remoteBody.indexOf(
      'backup_sha256=$(sha256sum -- "$backup_temp"',
    );
    const reserve = remoteBody.indexOf(
      "required_backup_available_bytes=$((MIN_AVAILABLE_BYTES + database_size_bytes + BACKUP_SIZE_OVERHEAD_BYTES))",
    );
    const hardOutputLimit = remoteBody.indexOf(
      'ulimit -f "$backup_output_limit_blocks"',
    );
    const sync = remoteBody.indexOf('sync -f -- "$backup_temp"');
    const prePublishHeadroom = remoteBody.indexOf("require_headroom /", sync);
    const publish = remoteBody.indexOf(
      'mv -n -T -- "$backup_temp" "$backup_final"',
    );
    const directorySync = remoteBody.indexOf('sync -f -- "$BACKUP_DIR"');
    const finalHash = remoteBody.indexOf(
      'final_sha256=$(sha256sum -- "$backup_final"',
    );
    const finalHeadroom = remoteBody.indexOf("require_headroom /", finalHash);
    const successOutput = remoteBody.indexOf(
      "printf 'backup_size_bytes=%s\\n'",
    );
    const fullDecodeCommand = remoteBody.lastIndexOf(
      "docker exec -i st-michael-postgres pg_restore",
      fullDecode,
    );
    const fullDecodeBody = remoteBody.slice(fullDecodeCommand, hash);

    expect(backupWorkflow).toContain("workflow_dispatch:");
    expect(backupWorkflow).toContain("confirm_backup:");
    expect(backupWorkflow).toContain("required: true");
    expect(backupWorkflow).toContain("default: false");
    expect(backupWorkflow).toContain("type: boolean");
    expect(backupJobHeader).not.toMatch(/^\s+if:/m);
    expect(sshStepHeader).not.toMatch(/^\s+if:/m);
    expect(sshStepHeader).not.toContain("continue-on-error:");
    expect(backupWorkflow).toContain('test "$CONFIRM_BACKUP" = "true"');
    expect(backupWorkflow).not.toContain("continue-on-error: true");
    expect(backupWorkflow).toContain("group: production-deploy");
    expect(backupWorkflow).toContain("cancel-in-progress: false");
    expect(backupWorkflow).toContain("environment: production");
    expect(backupWorkflow).toContain(
      "CANONICAL_REPOSITORY: sereganikitin/st-michael-broker-platform",
    );
    expect(backupWorkflow).toContain(
      'test "$EXPECTED_REF" = "refs/heads/master"',
    );
    expect(backupWorkflow).toContain("EXPECTED_BACKUP_SHA: ${{ github.sha }}");
    expect(backupWorkflow).toContain(
      'ssh-keyscan -p "$SSH_PORT" -t ed25519 "$SSH_HOST"',
    );
    expect(backupWorkflow).toContain(
      'test "${fingerprints[0]}" = "$EXPECTED_SSH_FINGERPRINT"',
    );
    expect(backupWorkflow).toContain("-o HostKeyAlgorithms=ssh-ed25519");
    expect(backupWorkflow).not.toContain("appleboy/ssh-action");
    expect(remoteStart).toBeGreaterThan(sshStepStart);
    expect(remoteEnd).toBeGreaterThan(remoteStart);
    expect(remoteBody).toContain(
      'test "$trusted_backup_sha" = "$EXPECTED_BACKUP_SHA"',
    );
    expect(remoteBody).toContain(
      'test "$actual_system_identifier" = "$PRODUCTION_PG_SYSTEM_IDENTIFIER"',
    );
    expect(remoteBody).toContain("MIN_AVAILABLE_BYTES=8589934592");
    expect(remoteBody).toContain("BACKUP_SIZE_OVERHEAD_BYTES=67108864");
    expect(remoteBody).toContain("SELECT pg_database_size(current_database())");
    expect(remoteBody).toContain(
      "backup_output_limit_bytes=$((backup_available_before - MIN_AVAILABLE_BYTES - BACKUP_SIZE_OVERHEAD_BYTES))",
    );
    expect(remoteBody).toContain(
      '[ "$backup_size_bytes" -le "$backup_output_limit_bytes" ]',
    );
    expect(remoteBody).toContain("/var/backups/stmichael/loyalty-predeploy");
    expect(lock).toBeGreaterThan(-1);
    expect(reserve).toBeGreaterThan(lock);
    expect(hardOutputLimit).toBeGreaterThan(reserve);
    expect(dump).toBeGreaterThan(hardOutputLimit);
    expect(restoreList).toBeGreaterThan(dump);
    expect(fullDecode).toBeGreaterThan(restoreList);
    expect(hash).toBeGreaterThan(fullDecode);
    expect(sync).toBeGreaterThan(hash);
    expect(prePublishHeadroom).toBeGreaterThan(sync);
    expect(publish).toBeGreaterThan(prePublishHeadroom);
    expect(publish).toBeGreaterThan(sync);
    expect(directorySync).toBeGreaterThan(publish);
    expect(finalHash).toBeGreaterThan(directorySync);
    expect(finalHeadroom).toBeGreaterThan(finalHash);
    expect(successOutput).toBeGreaterThan(finalHeadroom);
    expect(remoteBody.match(/\bpg_dump\b/g)).toHaveLength(1);
    expect(remoteBody.match(/\bpg_restore\b/g)).toHaveLength(2);
    expect(fullDecodeBody).toContain("--file=/dev/null");
    expect(fullDecodeBody).toContain('< "$backup_temp"');
    expect(fullDecodeBody).not.toMatch(
      /(?:--dbname(?:=|\s)|(?:^|\s)-d(?:\s|=))/,
    );
    expect(fullDecodeBody).not.toMatch(
      /--(?:table|schema|section|use-list|filter|data-only|schema-only)\b/,
    );
    expect(remoteBody).not.toMatch(
      /\bdocker\s+(?:compose|start|stop|restart|kill|prune|rm|rmi|run|build|pull|push)\b|docker-compose|\b(?:insert|update|delete|alter|create|drop|truncate|vacuum|reindex|grant|revoke)\b|\b(?:prisma|migrate|find|-delete|-mtime|rm\s+-rf)\b/i,
    );
    expect(remoteBody).not.toMatch(/\b(?:curl|wget|scp|rsync|rclone|aws)\b/);
    expect(remoteBody).toContain("set -euo pipefail");
    expect(remoteBody).not.toContain("|| true");
    expect(remoteBody).toContain('backup_temp=$(mktemp --tmpdir="$BACKUP_DIR"');
    expect(remoteBody).toContain("trap cleanup_backup_temp EXIT");
    expect(
      remoteBody.match(/\brm -f -- "\$(?:backup|checksum)_temp"/g),
    ).toHaveLength(2);
    expect(remoteBody).not.toContain('rm -f -- "$backup_final"');
    expect(remoteBody).not.toContain('rm -f -- "$backup_checksum"');
    expect(backupWorkflow).not.toContain("actions/upload-artifact");
    expect(remoteBody).not.toMatch(/\b(?:set\s+-x|printenv|tee|ls)\b/);
    expect(remoteBody).toContain("backup_size_bytes=%s");
    expect(remoteBody).toContain("backup_sha256=%s");
    expect(remoteBody).not.toContain("backup_full_decode_verified");
    expect(remoteBody).not.toContain("backup_scope=");
  });

  it("retires only the audited oldest complete rollback pair", () => {
    const remoteStart = rollbackRetirementWorkflow.indexOf("<<'REMOTE'");
    const remoteEnd = rollbackRetirementWorkflow.indexOf(
      "\n          REMOTE",
      remoteStart,
    );
    const remoteBody = rollbackRetirementWorkflow.slice(remoteStart, remoteEnd);
    const retirementJobStart =
      rollbackRetirementWorkflow.indexOf("\n  retire:");
    const retirementStepsStart = rollbackRetirementWorkflow.indexOf(
      "\n    steps:",
      retirementJobStart,
    );
    const retirementJobHeader = rollbackRetirementWorkflow.slice(
      retirementJobStart,
      retirementStepsStart,
    );
    const parsedWorkflow = parse(rollbackRetirementWorkflow) as {
      jobs?: Record<string, { steps?: Array<Record<string, unknown>> }>;
    };
    const parsedJobs = parsedWorkflow.jobs ?? {};
    const jobNames = Object.keys(parsedJobs);
    const parsedSteps = Object.values(parsedJobs).flatMap(
      (job) => job.steps ?? [],
    );
    const parsedRunSteps = parsedSteps.filter((step) =>
      Object.prototype.hasOwnProperty.call(step, "run"),
    );
    const literalRunBlocks =
      rollbackRetirementWorkflow.match(/^        run: \|$/gm) || [];
    const sshCalls = rollbackRetirementWorkflow.match(/\bssh\s+/g) || [];
    const heredocStarts = rollbackRetirementWorkflow.match(/<<'REMOTE'/g) || [];
    const heredocEnds =
      rollbackRetirementWorkflow.match(/^          REMOTE$/gm) || [];
    const approvedImageRemovals = [
      'docker image rm --no-prune -- "$target_api_id" >/dev/null',
      'docker image rm --no-prune -- "$target_web_id" >/dev/null',
    ];
    const approvedDatabaseChecks = [
      'actual_database=$(docker exec st-michael-postgres psql -U postgres -d broker_platform --no-psqlrc -Atqc "SELECT current_database()")',
      'actual_system_identifier=$(docker exec st-michael-postgres psql -U postgres -d broker_platform --no-psqlrc -Atqc "SELECT system_identifier FROM pg_control_system()")',
      'broker_rows=$(docker exec st-michael-postgres psql -U postgres -d broker_platform --no-psqlrc -Atqc "SELECT COUNT(*) FROM public.brokers")',
      'database_size_bytes=$(docker exec st-michael-postgres psql -U postgres -d broker_platform --no-psqlrc -Atqc "SELECT pg_database_size(current_database())")',
      'post_actual_database=$(docker exec st-michael-postgres psql -U postgres -d broker_platform --no-psqlrc -Atqc "SELECT current_database()")',
      'post_actual_system_identifier=$(docker exec st-michael-postgres psql -U postgres -d broker_platform --no-psqlrc -Atqc "SELECT system_identifier FROM pg_control_system()")',
      'post_broker_rows=$(docker exec st-michael-postgres psql -U postgres -d broker_platform --no-psqlrc -Atqc "SELECT COUNT(*) FROM public.brokers")',
      'post_database_size_bytes=$(docker exec st-michael-postgres psql -U postgres -d broker_platform --no-psqlrc -Atqc "SELECT pg_database_size(current_database())")',
    ];
    const approvedCanonicalCheck =
      "canonical_master_sha=$(git ls-remote --exit-code \"$CANONICAL_REPOSITORY_URL\" refs/heads/master | awk 'NR == 1 { print $1 }')";
    const requiredToolDeclaration =
      "for required_tool in awk curl date df docker flock git grep id readlink sha256sum sort stat systemctl tr wc xargs; do";
    const approvedSshInvocation = [
      '          ssh -i "$private_key" -p "$SSH_PORT" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$known_hosts" -o ConnectTimeout=15 \\',
      "            \"${SSH_USER}@${SSH_HOST}\" \"bash -s -- '$DEPLOY_PATH' '$EXPECTED_RETIREMENT_SHA' '$OPERATION' '$CONFIRM_RETIREMENT' '$EXPECTED_TARGET_API_IMAGE_ID' '$EXPECTED_TARGET_WEB_IMAGE_ID' '$EXPECTED_TARGET_REPO_DIGESTS_MANIFEST' '$EXPECTED_RELEASE_RECORD_SHA256' '$EXPECTED_ROLLBACK_OVERRIDE_SHA256' '$EXPECTED_FULL_ROLLBACK_INVENTORY_SHA256' '$EXPECTED_NON_TARGET_IMAGE_INVENTORY_SHA256' '$EXPECTED_RUNTIME_EVIDENCE_MANIFEST' '$PRODUCTION_PG_SYSTEM_IDENTIFIER' '$PRODUCTION_MIN_BROKER_ROWS'\" <<'REMOTE'",
    ].join("\n");
    const imageRemovalLines = remoteBody
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(
        (line) =>
          !line.startsWith("#") && /\bdocker\s+image\s+rm\b/.test(line),
      );
    let remoteBodyWithoutApprovedCommands = remoteBody;
    for (const command of approvedImageRemovals) {
      expect(remoteBodyWithoutApprovedCommands.split(command)).toHaveLength(2);
      remoteBodyWithoutApprovedCommands =
        remoteBodyWithoutApprovedCommands.replace(command, "");
    }
    const remoteCommandSurface = remoteBodyWithoutApprovedCommands
      .replace(
        'entrypoint: ["/bin/sh", "-c", "exec node apps/api/dist/main.js"]',
        "",
      )
      .replace(requiredToolDeclaration, "");
    const localRunBody = rollbackRetirementWorkflow.slice(
      rollbackRetirementWorkflow.indexOf("        run: |"),
      remoteStart + "<<'REMOTE'".length,
    );
    expect(localRunBody.split(approvedSshInvocation)).toHaveLength(2);
    const localRunWithoutApprovedSsh = localRunBody.replace(
      approvedSshInvocation,
      "",
    );

    const exactEvidenceValidation = remoteBody.indexOf(
      'test "$expected_full_rollback_inventory_sha256" = "$full_rollback_inventory_sha256"',
    );
    const targetContainerCheck = remoteBody.indexOf(
      'assert_no_container_uses_image "$target_web_id"',
    );
    const beforeFingerprint = remoteBody.indexOf(
      "running_container_inventory_before=",
    );
    const canonicalRecheck = remoteBody.lastIndexOf(
      "\n          assert_canonical_master\n",
    );
    const removal = remoteBody.indexOf(approvedImageRemovals[0]);
    const afterFingerprint = remoteBody.indexOf(
      "running_container_inventory_after=",
    );
    const finalGate = remoteBody.indexOf(
      'if [ "$root_after" -lt "$MIN_AVAILABLE_BYTES" ]',
    );

    expect(rollbackRetirementWorkflow).toContain("workflow_dispatch:");
    expect(jobNames).toEqual(["retire"]);
    expect(parsedSteps).toHaveLength(1);
    expect(parsedRunSteps).toHaveLength(1);
    expect(literalRunBlocks).toHaveLength(1);
    expect(rollbackRetirementWorkflow).toContain(
      "      - name: Verify host and remove exact obsolete rollback tags",
    );
    expect(rollbackRetirementWorkflow).toContain("        shell: bash");
    expect(rollbackRetirementWorkflow).not.toMatch(/^\s+uses:/m);
    expect(sshCalls).toHaveLength(1);
    expect(heredocStarts).toHaveLength(1);
    expect(heredocEnds).toHaveLength(1);
    expect(rollbackRetirementWorkflow).toContain(
      '"${SSH_USER}@${SSH_HOST}" "bash -s --',
    );
    expect(rollbackRetirementWorkflow).not.toMatch(
      /\b(?:scp|sftp|rsync|wget|gh|nc|ncat|socat)\s+/,
    );
    expect(localRunWithoutApprovedSsh).not.toMatch(
      /\b(?:ssh|scp|sftp|rsync|curl|wget|gh|git|ftp|nc|ncat|socat|openssl|python|node|ruby|perl|pwsh|powershell|bash|sh|eval|source)\s+/,
    );
    expect(rollbackRetirementWorkflow).toContain("operation:");
    expect(rollbackRetirementWorkflow).toContain("default: inspect");
    expect(rollbackRetirementWorkflow).toContain("confirm_retirement:");
    expect(rollbackRetirementWorkflow).toContain("default: false");
    expect(rollbackRetirementWorkflow).toContain("type: boolean");
    for (const input of [
      "expected_target_api_image_id",
      "expected_target_web_image_id",
      "expected_target_repo_digests_manifest",
      "expected_release_record_sha256",
      "expected_rollback_override_sha256",
      "expected_full_rollback_inventory_sha256",
      "expected_non_target_image_inventory_sha256",
      "expected_runtime_evidence_manifest",
    ]) {
      expect(rollbackRetirementWorkflow).toContain(`${input}:`);
      expect(rollbackRetirementWorkflow).toContain(`\${{ inputs.${input} }}`);
    }
    expect(rollbackRetirementWorkflow).toContain(
      "EXPECTED_RETIREMENT_SHA: ${{ github.sha }}",
    );
    expect(rollbackRetirementWorkflow).toContain(
      'test -z "$EXPECTED_TARGET_API_IMAGE_ID"',
    );
    expect(rollbackRetirementWorkflow).toContain(
      '[[ "$EXPECTED_TARGET_API_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]]',
    );
    expect(rollbackRetirementWorkflow).toContain(
      '[[ "$EXPECTED_TARGET_REPO_DIGESTS_MANIFEST" =~ ^(none|[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64})\\|(none|[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64})$ ]]',
    );
    expect(rollbackRetirementWorkflow).toContain(
      '[[ "$EXPECTED_FULL_ROLLBACK_INVENTORY_SHA256" =~ ^[0-9a-f]{64}$ ]]',
    );
    expect(rollbackRetirementWorkflow).toContain(
      '[[ "$EXPECTED_NON_TARGET_IMAGE_INVENTORY_SHA256" =~ ^[0-9a-f]{64}$ ]]',
    );
    expect(
      rollbackRetirementWorkflow.match(
        /\^\[0-9\]\{10\}:\[0-9\]\+\(:\[0-9a-f\]\{64\}\)\{9\}\$/g,
      ),
    ).toHaveLength(2);
    expect(retirementJobHeader).not.toMatch(/^\s+if:/m);
    expect(rollbackRetirementWorkflow).toContain("group: production-deploy");
    expect(rollbackRetirementWorkflow).toContain("cancel-in-progress: false");
    expect(rollbackRetirementWorkflow).toContain("environment: production");
    expect(rollbackRetirementWorkflow).toContain(
      "CANONICAL_REPOSITORY: sereganikitin/st-michael-broker-platform",
    );
    expect(rollbackRetirementWorkflow).toContain(
      'test "$EXPECTED_REF" = "refs/heads/master"',
    );
    expect(rollbackRetirementWorkflow).toContain(
      "EXPECTED_SSH_FINGERPRINT: ${{ vars.DEPLOY_HOST_FINGERPRINT }}",
    );
    expect(rollbackRetirementWorkflow).toContain(
      "PRODUCTION_PG_SYSTEM_IDENTIFIER: ${{ vars.PRODUCTION_PG_SYSTEM_IDENTIFIER }}",
    );
    expect(rollbackRetirementWorkflow).toContain(
      "PRODUCTION_MIN_BROKER_ROWS: ${{ vars.PRODUCTION_MIN_BROKER_ROWS }}",
    );
    expect(rollbackRetirementWorkflow).toContain(
      'test "${fingerprints[0]}" = "$EXPECTED_SSH_FINGERPRINT"',
    );
    expect(rollbackRetirementWorkflow).not.toContain("continue-on-error: true");

    expect(remoteStart).toBeGreaterThan(-1);
    expect(remoteEnd).toBeGreaterThan(remoteStart);
    expect(remoteBody).toContain("set -euo pipefail");
    expect(remoteBody).toContain(
      'test -z "${DOCKER_HOST:-}" -a -z "${DOCKER_CONTEXT:-}"',
    );
    expect(remoteBody).toContain("test -S /var/run/docker.sock");
    expect(remoteBody).toContain(
      "export DOCKER_HOST=unix:///var/run/docker.sock",
    );
    expect(remoteBody).toContain('test "$(docker context show)" = "default"');
    expect(remoteBody).toContain('test "$daemon_uptime_seconds" -ge 900');
    expect(remoteBody).toContain("MIN_AVAILABLE_BYTES=8589934592");
    expect(remoteBody).toContain("BACKUP_SIZE_OVERHEAD_BYTES=67108864");
    expect(remoteBody).toContain("RELEASE_TIMESTAMP=20260821-121353");
    expect(remoteBody).toContain(
      'TARGET_API_TAG="st-michael-rollback-api:$RELEASE_TIMESTAMP"',
    );
    expect(remoteBody).toContain(
      'TARGET_WEB_TAG="st-michael-rollback-web:$RELEASE_TIMESTAMP"',
    );
    expect(remoteBody).toContain("TARGET_API_PREFIX=dcac4b4619a4");
    expect(remoteBody).toContain("TARGET_WEB_PREFIX=82594645efc6");
    expect(remoteBody).toContain(
      "TARGET_COMMIT=c690fa9b44b5c7d291247bd88343af94ba241dd0",
    );
    expect(remoteBody).toContain(
      "NEWER_TIMESTAMPS=(20260821-151042 20260821-221026 20260825-145230 20260825-160034 20260826-101612 20260826-142213)",
    );
    expect(remoteBody).toContain(
      "NEWER_TARGET_COMMITS=(f765865a97998388b9debb50bfb06efe947283c9 e6dcd44de12ba056440125430b64c956fc0c41e8 47591c0a7e844fa642e909c8d387207e59e3f626 2d6088ba7d6ab7aa2fcc9ccf3136f712abc2a6bf 5e28d89fd589d2444d23add7da09953dfd71ed69 baf5b3d959ad80d6040c5e703391862b336f9015)",
    );
    expect(remoteBody).toContain(
      "DUPLICATE_RETAINED_API_IMAGE_ID=sha256:24af61e598b6c4269017163476ccba26733d5b092f659e58c497687bb360ed0d",
    );
    expect(remoteBody).toContain(
      "DUPLICATE_RETAINED_WEB_IMAGE_ID=sha256:4e1262c7e7831914cd1076c5a1542cdffa8828b36d1956c4fb247028268832f3",
    );
    for (const auditedArray of [
      "NEWER_TIMESTAMPS",
      "NEWER_API_PREFIXES",
      "NEWER_WEB_PREFIXES",
      "NEWER_TARGET_COMMITS",
    ]) {
      expect(remoteBody).toContain('test "${#' + auditedArray + '[@]}" -eq 6');
    }
    expect(remoteBody).toContain(
      "exec 9>/tmp/st-michael-production-deploy.lock",
    );
    expect(remoteBody).toContain("flock -n 9");
    expect(remoteBody).toContain(approvedCanonicalCheck);
    expect(remoteBody).toContain(
      'test "$canonical_master_sha" = "$expected_retirement_sha"',
    );
    expect(
      (remoteBody.match(/^\s*assert_canonical_master\s*$/gm) || []).length,
    ).toBeGreaterThanOrEqual(3);

    expect(remoteBody).toContain('case "$rollback_tag_count" in');
    expect(remoteBody).toContain("12|13|14) ;;");
    expect(remoteBody).toContain(
      '[ "$actual_retained_tags" != "$expected_retained_tags" ]',
    );
    expect(remoteBody).toContain(
      '[ "$rollback_tags_before" != "$expected_current_tags" ]',
    );
    expect(remoteBody).toContain("print_rollback_tag_diagnostics()");
    expect(remoteBody).toContain("printf 'actual_rollback_tag_count=%s\\n'");
    expect(remoteBody).toContain("printf 'actual_rollback_tag_list=%s\\n'");
    expect(remoteBody).toContain(
      "printf 'actual_rollback_redacted_tag_count=%s\\n'",
    );
    expect(remoteBody).not.toContain(
      "printf 'actual_rollback_tag_inventory=%s\\n'",
    );
    expect(
      remoteBody.match(/target_(?:api|web)_repo_digest=none/g),
    ).toHaveLength(2);
    expect(remoteBody).toContain(
      'test "$evidence_age_seconds" -ge 0 -a "$evidence_age_seconds" -le 900',
    );
    expect(remoteBody).toContain(
      'if docker image inspect "$target_api_id" >/dev/null 2>&1; then',
    );
    expect(remoteBody).toContain(
      'if docker image inspect "$target_web_id" >/dev/null 2>&1; then',
    );
    expect(remoteBody).toContain(
      'target_api_id=$(record_value previous_api_image "$RELEASE_RECORD")',
    );
    expect(remoteBody).toContain(
      'target_web_id=$(record_value previous_web_image "$RELEASE_RECORD")',
    );
    expect(remoteBody).toContain(
      '[[ "$target_api_id" =~ ^sha256:[0-9a-f]{64}$ ]]',
    );
    expect(remoteBody).toContain("image_has_prefix()");
    expect(remoteBody).toContain(
      "NEWER_API_PREFIXES=(ee0a02f547ca 3ee482ad303a 24af61e598b6 24af61e598b6 3cd30e4b9e03 8997f496e2d2)",
    );
    expect(remoteBody).toContain(
      "NEWER_WEB_PREFIXES=(317a5e63839f e40d1ed4639e 4e1262c7e783 4e1262c7e783 dc06e1dca818 3ed296479876)",
    );
    expect(remoteBody).toContain(
      'test "${image_id:7:12}" = "$expected_prefix"',
    );
    for (const prefixCheck of [
      'image_has_prefix "$target_api_id" "$TARGET_API_PREFIX"',
      'image_has_prefix "$target_web_id" "$TARGET_WEB_PREFIX"',
      'image_has_prefix "$newer_api_id" "${NEWER_API_PREFIXES[$newer_index]}"',
      'image_has_prefix "$newer_web_id" "${NEWER_WEB_PREFIXES[$newer_index]}"',
    ]) {
      expect(remoteBody).toContain(prefixCheck);
    }
    expect(remoteBody).not.toMatch(
      /\[\[ "\$(?:target|newer)_(?:api|web)_id" == "sha256:/,
    );
    expect(remoteBody).toContain(
      'if ! current_target_api_id=$(image_id_for_tag "$TARGET_API_TAG"); then',
    );
    expect(remoteBody).toContain(
      'if ! newer_record_api_id=$(record_value previous_api_image "$newer_record"); then',
    );
    expect(remoteBody).toContain(
      'if ! newer_record_web_id=$(record_value previous_web_image "$newer_record"); then',
    );
    expect(remoteBody).toContain("repo_tags=$(docker image inspect");
    expect(remoteBody).toContain("repo_digests=$(docker image inspect");
    expect(remoteBody).toContain("validated_repo_digest_for_tag()");
    expect(remoteBody).toContain(
      "if ! expected_repo_tags=$(printf '%s\\n' \"$expected_repo_tags\" | awk 'NF' | sort -u); then",
    );
    expect(remoteBody).toContain(
      "if ! repo_tags=$(docker image inspect --format '{{range .RepoTags}}{{println .}}{{end}}' \"$tag\" | awk 'NF' | sort -u); then",
    );
    expect(remoteBody).toContain("expected_retained_repo_tags()");
    expect(remoteBody).toContain("api:20260825-145230|api:20260825-160034)");
    expect(remoteBody).toContain("web:20260825-145230|web:20260825-160034)");
    expect(remoteBody).toContain(
      'test "$newer_api_id" = "$DUPLICATE_RETAINED_API_IMAGE_ID"',
    );
    expect(remoteBody).toContain(
      'test "$newer_web_id" = "$DUPLICATE_RETAINED_WEB_IMAGE_ID"',
    );
    expect(remoteBody).toContain(
      'if ! expected_newer_api_repo_tags=$(expected_retained_repo_tags api "$newer_timestamp"); then',
    );
    expect(remoteBody).toContain(
      'if ! newer_api_repo_digest=$(validated_repo_digest_for_tag "$newer_api_tag" "$expected_newer_api_repo_tags" "retained_api_${newer_timestamp}"); then',
    );
    expect(remoteBody).toContain(
      "grep -Eq '^\\[\"[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}\"\\]$'",
    );
    expect(remoteBody).toContain(
      "repo_digest=${repo_digests:2:${#repo_digests}-4}",
    );
    expect(remoteBody).toContain(
      'if ! repo_digest_image_id=$(image_id_for_tag "$repo_digest"); then',
    );
    expect(remoteBody).toContain(
      'if ! tag_image_id=$(image_id_for_tag "$tag"); then',
    );
    expect(remoteBody).toContain(
      'if ! target_api_repo_digest=$(validated_repo_digest_for_tag "$TARGET_API_TAG" "$TARGET_API_TAG" "target_api"); then',
    );
    expect(remoteBody).toContain(
      'if ! target_web_repo_digest=$(validated_repo_digest_for_tag "$TARGET_WEB_TAG" "$TARGET_WEB_TAG" "target_web"); then',
    );
    expect(remoteBody).toContain("inspect_stage_failed()");
    for (const safeDiagnostic of [
      "rollback_repo_tag_stage=%s",
      "rollback_repo_tag_expected_count=%s",
      "rollback_repo_tag_actual_count=%s",
      "rollback_repo_tag_expected_sha256=%s",
      "rollback_repo_tag_actual_sha256=%s",
      "rollback_repo_digest_stage=%s",
      "rollback_repo_digest_actual_count=%s",
      "rollback_repo_digest_actual_sha256=%s",
    ]) {
      expect(remoteBody).toContain(safeDiagnostic);
    }
    for (const stderrFailure of [
      'echo "Rollback image ID lookup failed" >&2',
      'echo "Rollback image repo-tag topology differs from the exact audit" >&2',
      'echo "Rollback image has an unexpected digest reference" >&2',
      'echo "Rollback release record key lookup failed" >&2',
      'echo "Unsupported retained rollback component" >&2',
      'echo "Deploy path is not a Git worktree" >&2',
      'echo "Docker daemon MainPID is invalid" >&2',
      'echo "Runtime event audit hash is invalid" >&2',
    ]) {
      expect(remoteBody).toContain(stderrFailure);
    }
    expect(remoteBody).toContain(
      "printf 'rollback_repo_tag_actual_sha256=%s\\n' \"$actual_tag_sha256\" >&2",
    );
    expect(remoteBody).toContain(
      "printf 'rollback_repo_digest_actual_sha256=%s\\n' \"$actual_digest_sha256\" >&2",
    );
    expect(remoteBody).not.toMatch(
      /printf '[^']*=%s\\n' "\$(?:repo_tags|repo_digests)"/,
    );
    const capturedHelperCalls = remoteBody
      .split(/\r?\n/)
      .filter((line) =>
        /\$\((?:image_id_for_tag|validated_repo_digest_for_tag|record_value|expected_retained_repo_tags|deploy_worktree_sha256|docker_daemon_snapshot|runtime_event_audit)\b/.test(
          line,
        ),
      );
    expect(capturedHelperCalls.length).toBeGreaterThan(30);
    for (const capturedHelperCall of capturedHelperCalls) {
      expect(capturedHelperCall.trim()).toMatch(/^if ! /);
    }
    expect(remoteBody).toContain(
      "target_api_repo_digest=$expected_target_api_repo_digest",
    );
    expect(remoteBody).toContain(
      "target_web_repo_digest=$expected_target_web_repo_digest",
    );
    expect(remoteBody).toContain("null|\"[]\") printf 'none\\n'");
    expect(remoteBody).toContain("container_ids=$(docker ps -aq --no-trunc)");
    expect(remoteBody).not.toContain("< <(docker ps -aq --no-trunc)");
    expect(
      remoteBody.match(
        /curl --disable --noproxy '\*' --request GET --fail --silent --show-error --output \/dev\/null --max-time 10/g,
      ),
    ).toHaveLength(2);
    expect(remoteBody).toContain(
      "--resolve broker.stmichael.ru:443:127.0.0.1 https://broker.stmichael.ru/api/health",
    );
    expect(remoteBody).toContain(
      "--resolve broker.stmichael.ru:443:127.0.0.1 https://broker.stmichael.ru/api/health/ready",
    );

    expect(remoteBody).toContain(
      'test "$(stat -c \'%u:%a\' -- "$RELEASE_DIR")" = "$deploy_uid:700"',
    );
    expect(remoteBody).toContain(
      'test "$(stat -c \'%u:%a\' -- "$path")" = "$expected_uid:600"',
    );
    expect(remoteBody).toContain('test "$(readlink -f -- "$path")" = "$path"');
    expect(remoteBody).toContain(
      'test "$(wc -l < "$record" | tr -d \'[:space:]\')" = "5"',
    );
    expect(remoteBody).toContain(
      'entrypoint: ["/bin/sh", "-c", "exec node apps/api/dist/main.js"]',
    );
    expect(remoteBody).toContain('test "$actual_hash" = "$expected_hash"');
    expect(remoteBody).toContain(
      'release_record_sha_before=$(sha256sum -- "$RELEASE_RECORD"',
    );
    expect(remoteBody).toContain(
      'rollback_override_sha_before=$(sha256sum -- "$ROLLBACK_OVERRIDE"',
    );
    expect(remoteBody).toContain(
      'test "$(sha256sum -- "$RELEASE_RECORD" | awk \'{print $1}\')" = "$release_record_sha_before"',
    );
    expect(remoteBody).toContain(
      'test "$(sha256sum -- "$ROLLBACK_OVERRIDE" | awk \'{print $1}\')" = "$rollback_override_sha_before"',
    );

    for (const query of approvedDatabaseChecks) {
      expect(remoteBody).toContain(query);
    }
    expect(remoteBody.match(/\bdocker\s+exec\b/g)).toHaveLength(8);
    expect(remoteBody).toContain('test "$actual_database" = "broker_platform"');
    expect(remoteBody).toContain(
      'test "$actual_system_identifier" = "$production_pg_system_identifier"',
    );
    expect(remoteBody).toContain(
      'test "$broker_rows" -ge "$production_min_broker_rows"',
    );
    expect(remoteBody).toContain(
      '[[ "$database_size_bytes" =~ ^[1-9][0-9]{0,17}$ ]]',
    );
    expect(remoteBody).toContain(
      "required_backup_available_bytes=$((MIN_AVAILABLE_BYTES + database_size_bytes + BACKUP_SIZE_OVERHEAD_BYTES))",
    );
    expect(remoteBody).toContain("BACKUP_PARENT=/var/backups/stmichael");
    expect(remoteBody).toContain(
      'BACKUP_DIR="$BACKUP_PARENT/loyalty-predeploy"',
    );
    expect(remoteBody).toContain(
      'test "$(readlink -f -- "$BACKUP_PARENT")" = "$BACKUP_PARENT"',
    );
    expect(remoteBody).toContain(
      'test ! -L "$BACKUP_DIR" || { echo "Loyalty backup directory must not be a symlink"; exit 1; }',
    );
    expect(remoteBody).toContain(
      'backup_before=$(available_bytes "$backup_storage_path")',
    );
    expect(remoteBody).toContain(
      'backup_after=$(available_bytes "$backup_storage_path")',
    );
    expect(remoteBody).toContain(
      '[ "$backup_after" -lt "$required_backup_available_bytes_after" ]',
    );
    expect(remoteBody).toContain(
      "required_backup_available_bytes_after=$((MIN_AVAILABLE_BYTES + post_database_size_bytes + BACKUP_SIZE_OVERHEAD_BYTES))",
    );

    expect(remoteBody).toContain("full_rollback_inventory_payload=$(");
    expect(remoteBody).toContain(
      "full_rollback_inventory_sha256=$(printf '%s' \"$full_rollback_inventory_payload\" | sha256sum",
    );
    expect(remoteBody).toContain(
      "printf 'target_api_image_id=%s\\n' \"$target_api_id\"",
    );
    expect(remoteBody).toContain(
      "printf 'full_rollback_inventory_sha256=%s\\n' \"$full_rollback_inventory_sha256\"",
    );
    expect(remoteBody).toContain(
      "printf 'non_target_image_inventory_sha256=%s\\n' \"$non_target_image_inventory_sha256\"",
    );
    expect(remoteBody).toContain("inspection_only=true");
    expect(remoteBody).toContain(
      'test "$expected_target_api_image_id" = "$target_api_id"',
    );
    expect(remoteBody).toContain(
      'test "$expected_target_web_image_id" = "$target_web_id"',
    );
    expect(remoteBody).toContain(
      'test "$expected_target_api_repo_digest" = "$target_api_repo_digest"',
    );
    expect(remoteBody).toContain(
      'test "$expected_target_web_repo_digest" = "$target_web_repo_digest"',
    );
    expect(remoteBody).toContain(
      'test "$expected_release_record_sha256" = "$release_record_sha_before"',
    );
    expect(remoteBody).toContain(
      'test "$expected_rollback_override_sha256" = "$rollback_override_sha_before"',
    );
    expect(remoteBody).toContain(
      'test "$expected_full_rollback_inventory_sha256" = "$full_rollback_inventory_sha256"',
    );
    expect(remoteBody).toContain("target_api_repo_digest=%s");
    expect(remoteBody).toContain("target_web_repo_digest=%s");
    expect(remoteBody).toContain("retained_%s_api_repo_digest=%s");
    expect(remoteBody).toContain("retained_%s_web_repo_digest=%s");

    expect(imageRemovalLines).toEqual(approvedImageRemovals);
    expect(remoteBody).toContain("retired_count=0");
    expect(
      remoteBody.match(/retired_count=\$\(\(retired_count \+ 1\)\)/g),
    ).toHaveLength(2);
    expect(remoteBody).not.toContain(
      'docker image rm --no-prune -- "$TARGET_API_TAG" "$target_api_repo_digest"',
    );
    expect(remoteBody).not.toContain(
      'docker image rm --no-prune -- "$TARGET_WEB_TAG" "$target_web_repo_digest"',
    );
    expect(remoteBody).not.toContain("--force");
    expect(exactEvidenceValidation).toBeGreaterThan(-1);
    expect(targetContainerCheck).toBeGreaterThan(-1);
    expect(beforeFingerprint).toBeGreaterThan(targetContainerCheck);
    expect(canonicalRecheck).toBeGreaterThan(beforeFingerprint);
    expect(removal).toBeGreaterThan(canonicalRecheck);
    expect(afterFingerprint).toBeGreaterThan(removal);
    expect(finalGate).toBeGreaterThan(afterFingerprint);
    expect(remoteBody).toContain(
      "rollback_tag_count_after=$(printf '%s\\n' \"$rollback_tags_after\"",
    );
    expect(remoteBody).toContain('[ "$rollback_tag_count_after" -ne 12 ]');
    expect(remoteBody).toContain(
      "all_image_ids_after=$(docker image ls --all --quiet --no-trunc | sort -u)",
    );
    expect(remoteBody).toContain(
      'if ! post_newer_api_id=$(image_id_for_tag "$newer_api_tag"); then',
    );
    expect(remoteBody).toContain(
      'if ! post_newer_web_id=$(image_id_for_tag "$newer_web_tag"); then',
    );
    expect(remoteBody).toContain(
      "printf 'retired_rollback_tags=%s\\n' \"$retired_count\"",
    );
    expect(remoteBody).toContain("rollback_metadata_preserved=true");
    expect(remoteBody).toContain(
      'echo "backup_reserve_threshold_satisfied=false"',
    );
    expect(remoteBody).toContain(
      'echo "backup_reserve_threshold_satisfied=true"',
    );

    expect(remoteCommandSurface).not.toMatch(
      /(?:^|[;&|($]\s*)docker\s+image\s+(?!inspect\b|ls\b)/m,
    );
    expect(remoteCommandSurface).not.toMatch(
      /\bdocker\s+(?:system|builder|container)\b|\bdocker\s+(?:stop|restart|kill|rm|rmi|run|build|pull|push)\b/,
    );
    expect(remoteCommandSurface).not.toMatch(
      /\bdocker\s+image\s+(?:prune|build|pull|push|tag|load|save|import)\b/,
    );
    expect(remoteCommandSurface).not.toMatch(
      /(?:^|[;&|($]\s*)docker\s+(?:volume|network)\s+(?!(?:ls|inspect)\b)/m,
    );
    expect(remoteBody.match(/\bdocker\s+context\s+show\b/g)).toHaveLength(1);
    expect(remoteBody).not.toMatch(/\bdocker\s+context\s+(?!show\b)/);
    expect(remoteCommandSurface).not.toMatch(
      /docker(?:-compose|\s+compose)|\bcommand\s+docker\b/,
    );
    expect(remoteCommandSurface).not.toMatch(
      /\b(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*=["']?docker["']?(?:[; \t]|$)|\$(?:\{)?docker_(?:bin|cmd|command)(?:\})?/im,
    );
    expect(remoteCommandSurface).not.toMatch(
      /\b(?:eval|source|bash|sh|python|node|ruby|perl|pwsh|powershell)\b|(?:^|[;(&|\s])\.\s+\S+/m,
    );
    expect(remoteCommandSurface.match(/\bsystemctl\s+/g)).toHaveLength(2);
    expect(remoteBody).not.toMatch(
      /\bsystemctl\s+(?:start|stop|restart|reload|enable|disable|mask|unmask|kill|set-property)\b/,
    );
    expect(remoteCommandSurface.match(/\bcurl\s+/g)).toHaveLength(2);
    expect(remoteBody).not.toMatch(/--request\s+(?:POST|PUT|PATCH|DELETE)\b/);
    expect(remoteBody).not.toMatch(
      /--(?:data(?:-[a-z]+)?|upload-file|form(?:-string)?)\b/,
    );
    expect(remoteCommandSurface.match(/\bxargs\s+/g)).toHaveLength(1);
    expect(remoteBody).toContain("xargs -0 -r sha256sum --zero --");
    expect(remoteBody).not.toMatch(
      /\bgit\s+(?:reset|clean|checkout|switch|pull|push|commit|merge|rebase|tag|branch|apply|am|restore)\b/,
    );
    expect(remoteCommandSurface).not.toMatch(
      /\b(?:journalctl|prisma|pg_dump|pg_restore|sudo|cp|mv|rm|rmdir|truncate|unlink|shred|tee|touch|dd|install|mkdir|mktemp|mkfifo|fallocate|ln|chmod|chown|find|sed|tar|gzip|gunzip|bzip2|bunzip2|xz|unxz|zstd|unzstd|zip|unzip|7z|cpio|openssl|buildctl|sponge)\b|(?:^|\n)\s*service\s+/,
    );
    expect(remoteCommandSurface).not.toMatch(
      />{1,2}\s*(?:["']?\$(?:RELEASE_DIR|RELEASE_RECORD|ROLLBACK_OVERRIDE|BACKUP_PARENT|BACKUP_DIR|backup_storage_path|newer_record|newer_override)\b|["']?\/var\/backups\/stmichael)/,
    );
    expect(remoteCommandSurface).not.toMatch(/\bsystem\s*\(/);
    expect(remoteBody).not.toContain("|| true");
    expect(remoteBody).not.toContain("backup-20260821-120159.tar.gz");
    expect(remoteBody).not.toContain("pre-baseline-");
    expect(remoteBody).not.toContain("loyalty-predeploy-");
  });
});
