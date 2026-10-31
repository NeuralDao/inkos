[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Build", "Verify")]
    [string]$Mode,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$RepoRoot,

    [string]$ExpectedSourceRef = "origin/custom/main"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:ResolvedRepo = (Resolve-Path -LiteralPath $RepoRoot).Path
$manifestRelativePath = "packages/core/dist/.inkos-build-provenance.json"
$manifestPath = Join-Path $script:ResolvedRepo $manifestRelativePath
$buildCommand = "pnpm --filter @actalk/inkos-core build"

$protectedPaths = @(
    "packages/core/src",
    "package.json",
    "packages/core/package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    "tsconfig.json",
    "packages/core/tsconfig.json",
    "scripts/clean-package-dist.mjs"
)

$fixedInputPaths = @(
    "package.json",
    "packages/core/package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    "tsconfig.json",
    "packages/core/tsconfig.json",
    "scripts/clean-package-dist.mjs",
    "node_modules/.pnpm/lock.yaml",
    "node_modules/.modules.yaml",
    "packages/core/node_modules/typescript/package.json",
    "packages/core/node_modules/typescript/bin/tsc",
    "packages/core/node_modules/typescript/lib/tsc.js",
    "packages/core/node_modules/typescript/lib/typescript.js",
    "packages/core/node_modules/.bin/tsc.cmd"
)

function Invoke-GitText {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    $output = & git -C $script:ResolvedRepo @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Git command failed: git $($Arguments -join ' ')"
    }
    return ($output -join [Environment]::NewLine).Trim()
}

function Invoke-NativeText {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    Push-Location $script:ResolvedRepo
    try {
        $output = & $Command @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed: $Command $($Arguments -join ' ')"
        }
        return ($output -join [Environment]::NewLine).Trim()
    }
    finally {
        Pop-Location
    }
}

function Assert-SourceParity {
    $dirtyArguments = @("status", "--porcelain", "--untracked-files=all", "--ignored=matching", "--") + $protectedPaths
    $dirty = Invoke-GitText -Arguments $dirtyArguments
    if ($dirty) {
        throw "Build inputs have local changes or untracked files: $dirty"
    }

    $diffArguments = @("diff", "--quiet", "HEAD", $ExpectedSourceRef, "--") + $protectedPaths
    & git -C $script:ResolvedRepo @diffArguments
    $diffExitCode = $LASTEXITCODE
    if ($diffExitCode -eq 1) {
        throw "Core source/build inputs differ from $ExpectedSourceRef."
    }
    if ($diffExitCode -ne 0) {
        throw "Git could not compare Core source/build inputs with $ExpectedSourceRef (exit $diffExitCode)."
    }
}

function Get-InputInventory {
    $files = [System.Collections.Generic.List[string]]::new()

    foreach ($relativePath in $fixedInputPaths) {
        $fullPath = Join-Path $script:ResolvedRepo $relativePath
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
            throw "Required build input is missing: $relativePath"
        }
        $files.Add($fullPath)
    }

    $sourceRoot = Join-Path $script:ResolvedRepo "packages/core/src"
    if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
        throw "Core source directory is missing: $sourceRoot"
    }

    $sourceEntries = @(Get-ChildItem -LiteralPath $sourceRoot -Recurse -Force)
    $sourceLinks = @($sourceEntries | Where-Object {
        ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    })
    if ($sourceLinks.Count -gt 0) {
        $linkPaths = ($sourceLinks | ForEach-Object { $_.FullName }) -join [Environment]::NewLine
        throw "Reparse points/symlinks under Core source are not allowed in a provenance build: $linkPaths"
    }
    foreach ($file in $sourceEntries | Where-Object { -not $_.PSIsContainer }) {
        $files.Add($file.FullName)
    }

    $compilerLibRoot = Join-Path $script:ResolvedRepo "packages/core/node_modules/typescript/lib"
    if (-not (Test-Path -LiteralPath $compilerLibRoot -PathType Container)) {
        throw "Installed TypeScript library directory is missing: $compilerLibRoot"
    }
    foreach ($file in Get-ChildItem -LiteralPath $compilerLibRoot -File -Recurse -Force) {
        $files.Add($file.FullName)
    }

    $inventory = foreach ($fullPath in ($files | Sort-Object -Unique)) {
        $relativePath = [System.IO.Path]::GetRelativePath($script:ResolvedRepo, $fullPath).Replace('\', '/')
        [pscustomobject]@{
            path = $relativePath
            sha256 = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }

    return @($inventory)
}

function Get-BuildParameters {
    $nodeVersion = Invoke-NativeText -Command "node" -Arguments @("--version")
    $pnpmVersion = Invoke-NativeText -Command "pnpm" -Arguments @("--version")
    $tscVersion = Invoke-NativeText -Command "pnpm" -Arguments @("--filter", "@actalk/inkos-core", "exec", "tsc", "--version")

    return [pscustomobject]@{
        buildCommand = $buildCommand
        nodeVersion = $nodeVersion
        pnpmVersion = $pnpmVersion
        typescriptVersion = $tscVersion
        platform = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
        architecture = [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
    }
}

function Get-DistInventory {
    $distRoot = Join-Path $script:ResolvedRepo "packages/core/dist"
    if (-not (Test-Path -LiteralPath $distRoot -PathType Container)) {
        throw "Core dist directory is missing: $distRoot"
    }

    $manifestFullPath = [System.IO.Path]::GetFullPath($manifestPath)
    $distEntries = @(Get-ChildItem -LiteralPath $distRoot -Recurse -Force)
    $distLinks = @($distEntries | Where-Object {
        ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    })
    if ($distLinks.Count -gt 0) {
        $linkPaths = ($distLinks | ForEach-Object { $_.FullName }) -join [Environment]::NewLine
        throw "Reparse points/symlinks under Core dist are not allowed in a provenance inventory: $linkPaths"
    }
    $files = $distEntries | Where-Object {
        -not $_.PSIsContainer -and [System.IO.Path]::GetFullPath($_.FullName) -ne $manifestFullPath
    }

    $inventory = foreach ($file in $files) {
        $relativePath = [System.IO.Path]::GetRelativePath($script:ResolvedRepo, $file.FullName).Replace('\', '/')
        [pscustomobject]@{
            path = $relativePath
            sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }

    $result = @($inventory | Sort-Object path)
    if ($result.Count -eq 0) {
        throw "Core dist contains no build outputs."
    }
    return $result
}

function Assert-JsonEqual {
    param(
        [Parameter(Mandatory = $true)][object]$Expected,
        [Parameter(Mandatory = $true)][object]$Actual,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $expectedJson = ConvertTo-Json -InputObject @($Expected) -Depth 30 -Compress
    $actualJson = ConvertTo-Json -InputObject @($Actual) -Depth 30 -Compress
    if ($expectedJson -cne $actualJson) {
        throw "$Label does not match the recorded Core build provenance."
    }
}

$scriptHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
Assert-SourceParity

$head = Invoke-GitText -Arguments @("rev-parse", "HEAD")
$sourceHead = Invoke-GitText -Arguments @("rev-parse", "--verify", $ExpectedSourceRef)
$inputInventory = @(Get-InputInventory)
$buildParameters = Get-BuildParameters

if ($Mode -eq "Build") {
    if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
        Remove-Item -LiteralPath $manifestPath -Force
    }

    Write-Host "Building Core from verified source commit $head ..."
    Push-Location $script:ResolvedRepo
    try {
        & pnpm --filter "@actalk/inkos-core" build
        $buildExitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
    if ($buildExitCode -ne 0) {
        throw "Core build failed with exit code $buildExitCode. No provenance manifest was written."
    }

    $headAfterBuild = Invoke-GitText -Arguments @("rev-parse", "HEAD")
    $sourceHeadAfterBuild = Invoke-GitText -Arguments @("rev-parse", "--verify", $ExpectedSourceRef)
    if ($headAfterBuild -ne $head -or $sourceHeadAfterBuild -ne $sourceHead) {
        throw "Git refs changed during the Core build. No provenance manifest was written."
    }

    $inputInventoryAfterBuild = @(Get-InputInventory)
    Assert-JsonEqual -Expected $inputInventory -Actual $inputInventoryAfterBuild -Label "Build input inventory"
    $buildParametersAfterBuild = Get-BuildParameters
    Assert-JsonEqual -Expected $buildParameters -Actual $buildParametersAfterBuild -Label "Build parameters"

    $distInventory = @(Get-DistInventory)
    $manifest = [ordered]@{
        schemaVersion = 1
        sourceCommit = $head
        expectedSourceRef = $ExpectedSourceRef
        expectedSourceCommit = $sourceHead
        buildScriptSha256 = $scriptHash
        buildParameters = $buildParameters
        inputFiles = $inputInventory
        distFiles = $distInventory
    }

    $manifest | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $manifestPath -Encoding utf8
    Write-Host "CORE BUILD PROVENANCE WRITTEN. No tests or LLM/API calls were made."
    return [pscustomobject]@{
        status = "BUILD_PROVENANCE_WRITTEN"
        sourceCommit = $head
        expectedSourceCommit = $sourceHead
        buildScriptSha256 = $scriptHash
        distFiles = $distInventory
    }
}

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Core build provenance is missing. Run this script with -Mode Build after explicit build authorization."
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ([int]$manifest.schemaVersion -ne 1) {
    throw "Unsupported Core build provenance schema: $($manifest.schemaVersion)"
}
if ($manifest.sourceCommit -ne $head) {
    throw "Core dist was built from commit $($manifest.sourceCommit), but local HEAD is $head."
}
if ($manifest.expectedSourceRef -ne $ExpectedSourceRef -or $manifest.expectedSourceCommit -ne $sourceHead) {
    throw "Core build provenance was created against a different or moved expected source ref."
}
if ($manifest.buildScriptSha256 -ne $scriptHash) {
    throw "Core build provenance was created by a different build script version."
}

Assert-JsonEqual -Expected $manifest.buildParameters -Actual $buildParameters -Label "Build parameters"
Assert-JsonEqual -Expected $manifest.inputFiles -Actual $inputInventory -Label "Build input inventory"

$distInventory = @(Get-DistInventory)
Assert-JsonEqual -Expected $manifest.distFiles -Actual $distInventory -Label "Complete dist inventory"

Write-Host "CORE BUILD PROVENANCE VERIFIED."
return [pscustomobject]@{
    status = "BUILD_PROVENANCE_VERIFIED"
    sourceCommit = $head
    expectedSourceCommit = $sourceHead
    buildScriptSha256 = $scriptHash
    distFiles = $distInventory
}