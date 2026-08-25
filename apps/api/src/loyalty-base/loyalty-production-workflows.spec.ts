import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

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
  const backupWorkflow = readRepositoryFile(
    ".github/workflows/backup-production-loyalty-predeploy.yml",
  );
  const deployScript = readRepositoryFile("deploy-update.sh");
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

  it("pins the production ED25519 host fingerprint for deploy and rehearsal", () => {
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
        "fingerprint: ${{ vars.DEPLOY_HOST_FINGERPRINT }}",
      );
      expect(workflow).toContain("^SHA256:[A-Za-z0-9+/]{43}$");
      expect(workflow).not.toContain('echo "$EXPECTED_SSH_FINGERPRINT"');
    }
    expect(rehearsalWorkflow).toContain("group: production-deploy");
    expect(rehearsalWorkflow).toContain(
      "DEPLOY_PATH: ${{ secrets.DEPLOY_PATH }}",
    );
    expect(rehearsalWorkflow).not.toContain('cd "${{ secrets.DEPLOY_PATH }}"');
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
    expect(rehearsalWorkflow).toContain(
      "envs: DEPLOY_PATH,EXPECTED_REHEARSAL_SHA",
    );
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
      "$COMPOSE_CMD stop -t 30 api",
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
      'if ! $COMPOSE_CMD -f docker-compose.yml -f "$ROLLBACK_OVERRIDE" up -d',
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
      "if ! $COMPOSE_CMD up -d --no-deps api web; then",
    );
    const readinessDecision = deployScript.indexOf(
      'if [ "$API_READY" -ne 1 ]; then',
      rollout,
    );
    const nginxExposure = deployScript.indexOf(
      "if ! reload_nginx_upstreams; then",
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
      "\n          script: |",
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
      "\n          script: |",
      sshStepStart,
    );
    const sshStepHeader = backupWorkflow.slice(sshStepStart, sshStepScript);
    const remoteStart = backupWorkflow.lastIndexOf("          script: |");
    const remoteBody = backupWorkflow.slice(remoteStart);
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
      "appleboy/ssh-action@029f5b4aeeeb58fdfe1410a5d17f967dacf36262",
    );
    expect(backupWorkflow).toContain(
      "fingerprint: ${{ vars.DEPLOY_HOST_FINGERPRINT }}",
    );
    expect(backupWorkflow).toContain("script_stop: true");
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
});
