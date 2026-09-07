# Anna loyalty production import

This runbook describes the isolated CLI and the reviewed one-off GitHub Actions
delivery design. The normalized JSON contains personal data. It must never be
committed, attached as an Actions artifact, pasted into a dispatch input, or
printed to a log.

## CLI safety boundary

The compiled entry point is:

```text
apps/api/dist/loyalty-base/loyalty-import.cli.js
```

It starts a Nest application context containing only `DatabaseModule` and
`LoyaltyBaseService`; it does not start HTTP, queues, or schedulers. It reads
from stdin by default (`--file <path>` is also supported) and requires both:

- `--expected-payload-sha256 <64 lowercase hex>` for the exact input bytes;
- `--confirm-publish` for the dry-run -> stage -> publish operation.

`--confirm-coverage-drop` is a separate explicit approval. Do not add it merely
to make a failed run pass: review the aggregate dry-run comparison first.

Example inside the deployed API container:

```sh
node apps/api/dist/loyalty-base/loyalty-import.cli.js \
  --expected-payload-sha256 "$EXPECTED_PAYLOAD_SHA256" \
  --confirm-publish < /secure/path/payload.json
```

The CLI validates the DTO with `whitelist`, `forbidNonWhitelisted`, and
`forbidUnknownValues`. It emits one JSON line containing only statuses, hashes,
idempotency flags, and aggregate counts. It never emits input content,
validation values, row data, names, contacts, source identifiers, or database
exception text. A rerun is safe: stage is keyed by the service content hash and
publish treats an already-active published snapshot as idempotent.

## Payload channel sizing

The API and CLI accept at most 10 MiB of uncompressed JSON. A GitHub Actions secret
is limited to 48 KiB, so one secret cannot carry this payload. The reviewed
workflow design reserves 32 production-environment secrets, each capped at
45,000 base64 characters:

```text
ANNA_LOYALTY_PAYLOAD_01 ... ANNA_LOYALTY_PAYLOAD_32
```

This channel carries at most 1,440,000 base64 characters (about 1.03 MiB of
gzip bytes after base64 overhead). Measure the converter output before setting
secrets. If gzip+base64 is larger, do not silently add plaintext storage or an
artifact; use an approved private object-store/SFTP channel with an expiring
credential, or review a larger fixed secret allocation against the environment
secret quota.

Each reconstruction step must receive exactly one chunk in its step-level
environment. Loading all chunks into a single process environment risks the
OS argument/environment limit and unnecessarily broadens secret exposure.

## Prepare production environment secrets (PowerShell)

Run from a trusted workstation with GitHub CLI authenticated for the repository.
This code never writes a compressed or base64 copy to disk and does not print
payload content:

```powershell
$ErrorActionPreference = 'Stop'
$repo = 'sereganikitin/st-michael-broker-platform'
$payloadPath = 'C:\secure\anna-loyalty.normalized.json'
$chunkSize = 45000
$maxChunks = 32

function Get-PayloadSecretNames {
  $json = & gh secret list --env production --repo $repo --json name
  if ($LASTEXITCODE -ne 0) { throw 'Failed to list production secrets' }
  @($json | ConvertFrom-Json | ForEach-Object { $_.name } |
    Where-Object { $_ -match '^ANNA_LOYALTY_PAYLOAD_\d{2}$' } | Sort-Object)
}

function Remove-PayloadSecrets {
  foreach ($secretName in @(Get-PayloadSecretNames)) {
    $null = & gh secret delete $secretName --env production --repo $repo 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Failed to delete $secretName" }
  }
  $remaining = @(Get-PayloadSecretNames)
  if ($remaining.Count -ne 0) {
    throw "Payload secrets remain after cleanup: $($remaining -join ', ')"
  }
}

function Set-SecretWithoutCommandLineValue([string]$name, [string]$value) {
  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = 'gh'
  $start.UseShellExecute = $false
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  foreach ($argument in @('secret', 'set', $name, '--env', 'production', '--repo', $repo)) {
    [void]$start.ArgumentList.Add($argument)
  }
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $start
  [void]$process.Start()
  $process.StandardInput.Write($value)
  $process.StandardInput.Close()
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) { throw "Failed to set $name" }
}

$raw = [System.IO.File]::ReadAllBytes($payloadPath)
if ($raw.Length -lt 1 -or $raw.Length -gt 10MB) {
  throw 'Uncompressed payload must be between 1 byte and 10 MiB'
}

$hasher = [System.Security.Cryptography.SHA256]::Create()
try {
  $payloadSha256 = (($hasher.ComputeHash($raw) | ForEach-Object { $_.ToString('x2') }) -join '')
} finally {
  $hasher.Dispose()
}

$compressed = New-Object System.IO.MemoryStream
$gzip = [System.IO.Compression.GzipStream]::new(
  $compressed,
  [System.IO.Compression.CompressionMode]::Compress,
  $true
)
try {
  $gzip.Write($raw, 0, $raw.Length)
} finally {
  $gzip.Dispose()
}
$encoded = [Convert]::ToBase64String($compressed.ToArray())
$compressed.Dispose()
$raw = $null

$chunkCount = [Math]::Ceiling($encoded.Length / $chunkSize)
if ($chunkCount -lt 1 -or $chunkCount -gt $maxChunks) {
  throw "gzip+base64 needs $chunkCount chunks; reviewed limit is $maxChunks"
}

Remove-PayloadSecrets
$uploadSucceeded = $false
try {
  for ($index = 0; $index -lt $chunkCount; $index++) {
    $offset = $index * $chunkSize
    $length = [Math]::Min($chunkSize, $encoded.Length - $offset)
    $secretName = 'ANNA_LOYALTY_PAYLOAD_{0:D2}' -f ($index + 1)
    Set-SecretWithoutCommandLineValue $secretName $encoded.Substring($offset, $length)
  }
  $expectedNames = @(1..$chunkCount | ForEach-Object { 'ANNA_LOYALTY_PAYLOAD_{0:D2}' -f $_ })
  $actualNames = @(Get-PayloadSecretNames)
  if (@(Compare-Object $expectedNames $actualNames).Count -ne 0) {
    throw 'Uploaded payload secret-name set is incomplete or contains stale chunks'
  }
  $uploadSucceeded = $true
} finally {
  if (-not $uploadSucceeded) { Remove-PayloadSecrets }
  if ($raw) { [Array]::Clear($raw, 0, $raw.Length) }
  $encoded = $null
}

"payload_sha256=$payloadSha256"
"chunk_count=$chunkCount"
```

The two printed values are non-PII workflow inputs. Keep the normalized JSON
itself only in the approved local secure location.

The production environment also needs `DEPLOY_HOST_FINGERPRINT`; the transfer
must fail closed when the SSH host fingerprint is absent or wrong.

## Reviewed workflow design

The production workflow is intentionally not generated dynamically from the
payload. Its reviewed implementation must have these fixed controls:

1. Manual dispatch inputs: `expected_deployed_sha`,
   `expected_payload_sha256`, `chunk_count`, `confirm_publish`, and
   `confirm_coverage_drop`. No dispatch input contains payload data.
2. `environment: production`, required reviewers, read-only repository
   permission, `concurrency.group: production-deploy`, and
   `cancel-in-progress: false`.
3. Reject unless `confirm_publish=true`, chunk count is 1..32, hashes have exact
   lowercase formats, and `expected_deployed_sha == github.sha`.
4. Create runner directories with mode 700 and files with mode 600. Fixed
   append steps 01..32 each receive only their matching environment secret and
   run only when `chunk_count` includes that step.
5. Decode base64 and gzip without stdout, enforce 1..10 MiB, and compare the
   uncompressed SHA-256 before any transfer.
6. Use native SSH/SCP clients with strict pinned-host verification.
   Pre-create a mode-700 `/tmp/st-michael-anna-<run>-<attempt>` directory,
   transfer one mode-600 file, and never use an artifact.
7. Before transfer and immediately before execution, verify all three values
   are identical: workflow SHA, production worktree `git rev-parse HEAD`, and
   the running API container `GIT_SHA`.
8. Hold `/tmp/st-michael-production-deploy.lock`, verify the transferred
   SHA-256 again, and pipe the file to the compiled CLI through stdin.
9. Install an in-step `EXIT/HUP/INT/TERM` trap for the remote file and add
   `if: always()` cleanup steps for both remote and runner files. Validate the
   exact temporary path pattern before removal; remove files and then `rmdir`,
   never broad recursive paths.
10. The workflow log may contain only the CLI's PII-free result and operational
    status messages. It must not enable shell tracing or print secret lengths,
    chunks, decoded content, exception bodies, or file samples.

After the workflow reaches a terminal state, delete all 32 dedicated secrets,
including unused/stale names:

```powershell
$ErrorActionPreference = 'Stop'
$repo = 'sereganikitin/st-michael-broker-platform'
$json = & gh secret list --env production --repo $repo --json name
if ($LASTEXITCODE -ne 0) { throw 'Failed to list production secrets' }
$names = @($json | ConvertFrom-Json | ForEach-Object { $_.name } |
  Where-Object { $_ -match '^ANNA_LOYALTY_PAYLOAD_\d{2}$' })
foreach ($secretName in $names) {
  $null = & gh secret delete $secretName --env production --repo $repo 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Failed to delete $secretName" }
}
$verifyJson = & gh secret list --env production --repo $repo --json name
if ($LASTEXITCODE -ne 0) { throw 'Failed to verify production secret cleanup' }
$remaining = @($verifyJson | ConvertFrom-Json | ForEach-Object { $_.name } |
  Where-Object { $_ -match '^ANNA_LOYALTY_PAYLOAD_\d{2}$' })
if ($remaining.Count -ne 0) { throw 'Payload secret cleanup was incomplete' }
"deleted_payload_secrets=$($names.Count)"
```

GitHub's job token should not be granted environment-administration rights just
to self-delete secrets. Operator deletion after the terminal run is the smaller
privilege boundary.
