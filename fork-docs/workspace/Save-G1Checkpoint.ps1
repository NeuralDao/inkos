# Save a finished InkOS Studio Work checkpoint to a SEPARATE private Git repository.
# PowerShell 7; review the staged diff before using -Publish.
# Does not start Studio, call LLM APIs, or modify the public InkOS source code.
param(
  [Parameter(Mandatory = $true)]
  [string]$WorkId,
  [string]$Workspace = 'C:\Projects\inkos-workspace',
  [string]$Label = 'checkpoint',
  [switch]$Publish,
  [switch]$PrivateConfirmed
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($WorkId -match '[\\/]' -or $WorkId -eq '.' -or $WorkId -eq '..' -or $WorkId.Trim() -ne $WorkId) {
  throw 'WorkId must be one existing directory name inside works/ (not a path).'
}
if ($Label -notmatch '^[a-zA-Z0-9 ._-]{1,60}$') {
  throw 'Use a short ASCII checkpoint label without special characters.'
}
if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) {
  throw "Workspace does not exist: $Workspace"
}
$workDir = Join-Path (Join-Path $Workspace 'works') $WorkId
if (-not (Test-Path -LiteralPath $workDir -PathType Container)) {
  throw "Work directory does not exist: $workDir"
}
$gitIgnore = Join-Path $Workspace '.gitignore'
if (-not (Test-Path -LiteralPath $gitIgnore -PathType Leaf)) {
  throw 'Missing workspace .gitignore: use the template in fork-docs/G1_WORKSPACE_GIT.md first.'
}
$ignoreText = Get-Content -LiteralPath $gitIgnore -Raw
if ($ignoreText -notmatch '(?m)^/\*\s*$' -or $ignoreText -notmatch '(?m)^!/works/\s*$') {
  throw 'Unexpected .gitignore: project root must be denied by default, with works/ explicitly allowed.'
}

$gitRoot = & git -C $Workspace rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0) { throw "Workspace is not a Git repository: $Workspace" }
$rootExpected = [IO.Path]::GetFullPath($Workspace).TrimEnd('\', '/')
$rootActual = [IO.Path]::GetFullPath(($gitRoot | Select-Object -First 1)).TrimEnd('\', '/')
if ($rootExpected -ne $rootActual) {
  throw "Git root mismatch; expected $rootExpected, got $rootActual"
}

$branch = & git -C $Workspace branch --show-current
if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') {
  throw 'Expected private workspace branch main. Do not checkpoint the InkOS source branch.'
}
$remote = & git -C $Workspace remote get-url origin
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($remote)) {
  throw 'Configure the PRIVATE GitHub remote origin before staging.'
}
if ($remote -notmatch '^(https://github\.com/|git@github\.com:)[^/]+/[^/]+(?:\.git)?$') {
  throw 'Origin must be a GitHub repository URL without credentials or query parameters.'
}
if ($remote -match '(?i)github\.com[:/]NeuralDao/inkos(?:\.git)?$') {
  throw 'Refusing to publish manuscript artifacts to the public InkOS source repository.'
}

$trackedSensitive = @(& git -C $Workspace ls-files -- inkos.json .inkos/ .env .env.local)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect tracked secrets.' }
if ($trackedSensitive.Count -gt 0) {
  throw "Forbidden files are already tracked: $($trackedSensitive -join ', ')"
}
$pending = @(& git -c core.quotepath=false -C $Workspace diff --cached --name-only)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect existing staged changes.' }
$workPrefix = '^works/' + [Regex]::Escape($WorkId) + '/'
$pendingUnexpected = @($pending | Where-Object { $_ -ne 'g1-run.md' -and $_ -notmatch $workPrefix })
if ($pendingUnexpected.Count -gt 0) {
  throw "Existing staged files belong to another Work: $($pendingUnexpected -join ', ')"
}

& git -C $Workspace add -A -- "works/$WorkId"
if ($LASTEXITCODE -ne 0) { throw 'Cannot stage this Work.' }
$runNotes = Join-Path $Workspace 'g1-run.md'
if (Test-Path -LiteralPath $runNotes -PathType Leaf) {
  & git -C $Workspace add -- g1-run.md
  if ($LASTEXITCODE -ne 0) { throw 'Cannot stage g1-run.md.' }
}
$staged = @(& git -c core.quotepath=false -C $Workspace diff --cached --name-only)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect staged names.' }
if ($staged.Count -eq 0) {
  Write-Host 'No changed files to commit for this Work.'
  return
}

$outside = @($staged | Where-Object { $_ -ne 'g1-run.md' -and $_ -notmatch $workPrefix })
if ($outside.Count -gt 0) {
  throw "Unexpected staged path(s): $($outside -join ', ')"
}
$unsafe = @($staged | Where-Object {
  $_ -match '(?i)(^|/)(\.env(\.|$)|secrets?[^/]*|credentials?[^/]*|\.inkos|inkos\.json)(/|$)' -or
  $_ -match '(?i)\.(db|sqlite|sqlite3)(-|$|\.)'
})
if ($unsafe.Count -gt 0) {
  throw "Sensitive/cache path(s) staged: $($unsafe -join ', ')"
}
& git -C $Workspace diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'Staged diff failed whitespace/error check.' }

Write-Host 'Staged file names:'
$staged | ForEach-Object { Write-Host "  $_" }
& git -C $Workspace diff --cached --stat

if (-not $Publish) {
  Write-Host 'Stage prepared only. Review with:'
  Write-Host "git -C `"$Workspace`" diff --cached"
  Write-Host 'After checking PRIVATE visibility and content, rerun with -Publish -PrivateConfirmed.'
  return
}
if (-not $PrivateConfirmed) {
  throw 'Publishing requires -PrivateConfirmed after checking the GitHub repository is PRIVATE.'
}
$answer = Read-Host "Type PUSH to commit and upload ONLY this Work to the verified PRIVATE remote: $remote"
if ($answer -cne 'PUSH') {
  Write-Host 'Push cancelled. The staged changes remain local.'
  return
}
& git -C $Workspace commit -m ("G1: " + $Label)
if ($LASTEXITCODE -ne 0) { throw 'Git commit failed; push not attempted.' }
& git -C $Workspace push origin main
if ($LASTEXITCODE -ne 0) { throw 'Git push failed; local commit remains available.' }
Write-Host 'Checkpoint successfully committed and pushed.'
