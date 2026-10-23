[CmdletBinding()]
param(
    [string]$ChromePath = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    [string]$PrivateKeyPath = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($PrivateKeyPath)) {
    $PrivateKeyPath = Join-Path $repoRoot "Ext_pom_key\Claude_Conversation_Exporter.pem"
}

if (-not (Test-Path -LiteralPath $ChromePath -PathType Leaf)) {
    throw "Chrome was not found at '$ChromePath'. Pass its path with -ChromePath."
}
if (-not (Test-Path -LiteralPath $PrivateKeyPath -PathType Leaf)) {
    throw "The CRX signing key was not found at '$PrivateKeyPath'. Pass its path with -PrivateKeyPath."
}

$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("claude-conversation-exporter-" + [guid]::NewGuid().ToString("N"))
$stagingDir = Join-Path $stagingRoot "Claude_Conversation_Exporter"
$outputDir = Join-Path $repoRoot "Crx"
$outputPath = Join-Path $outputDir "Claude_Conversation_Exporter.crx"

# Keep the package limited to public extension and documentation files. In
# particular, never copy Ext_pom_key (the private signing key) into the package.
$files = @(
    "background.js",
    "content.js",
    "curl-template.txt",
    "INSTALL.md",
    "LICENSE",
    "manifest.json",
    "package.json",
    "popup.css",
    "popup.html",
    "popup.js",
    "README.md"
)
$directories = @("icons", "lib", "tools")

try {
    New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

    foreach ($file in $files) {
        Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination $stagingDir -Force
    }
    foreach ($directory in $directories) {
        Copy-Item -LiteralPath (Join-Path $repoRoot $directory) -Destination $stagingDir -Recurse -Force
    }

    $chromeProcess = Start-Process -FilePath $ChromePath -ArgumentList @(
        "--pack-extension=$stagingDir",
        "--pack-extension-key=$PrivateKeyPath"
    ) -Wait -PassThru -NoNewWindow
    if ($chromeProcess.ExitCode -ne 0) {
        throw "Chrome failed to package the extension (exit code $($chromeProcess.ExitCode))."
    }

    $generatedCrx = "$stagingDir.crx"
    if (-not (Test-Path -LiteralPath $generatedCrx -PathType Leaf)) {
        throw "Chrome did not create the expected CRX at '$generatedCrx'."
    }

    Copy-Item -LiteralPath $generatedCrx -Destination $outputPath -Force
    Write-Host "Packaged extension written to $outputPath"
}
finally {
    # Chrome may create a temporary PEM beside the staged package. Remove it
    # regardless; the authoritative private key remains outside the package.
    $generatedPem = "$stagingDir.pem"
    if (Test-Path -LiteralPath $generatedPem) {
        Remove-Item -LiteralPath $generatedPem -Force
    }
    if (Test-Path -LiteralPath $stagingRoot) {
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force
    }
}
