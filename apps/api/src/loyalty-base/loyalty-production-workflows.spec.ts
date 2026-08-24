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
    for (const workflow of [deployWorkflow, rehearsalWorkflow]) {
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
});
