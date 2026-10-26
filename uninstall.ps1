# Uninstall dsh-workspace-session-drag from the desktop profile.
# Run after completely quitting DeepSeek Harness (window + tray icon).
$ErrorActionPreference = 'Stop'

$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$packageJsonPath = Join-Path $profileDir 'package.json'
$packageName = 'dsh-workspace-session-drag'

Write-Host ''
Write-Host '== dsh-workspace-session-drag uninstaller ==' -ForegroundColor Cyan

$running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($running) {
    Write-Host 'ERROR: DeepSeek Harness is still running. Quit it completely and run again.' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $packageJsonPath)) {
    Write-Host "ERROR: profile package.json not found: $packageJsonPath" -ForegroundColor Red
    exit 1
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item $packageJsonPath "$packageJsonPath.$packageName.$stamp.bak"

$pkg = Get-Content $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($pkg.PSObject.Properties['dependencies']) {
    $pkg.dependencies.PSObject.Properties.Remove($packageName)
}
if ($pkg.dsh -and $pkg.dsh.profile) {
    $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles) | Where-Object { $_ -ne $packageName }
}
$json = $pkg | ConvertTo-Json -Depth 30
[System.IO.File]::WriteAllText($packageJsonPath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))

$linkPath = Join-Path $profileDir "node_modules\$packageName"
if (Test-Path $linkPath) {
    Remove-Item $linkPath -Force -Recurse -ErrorAction SilentlyContinue
    Write-Host "removed junction: $linkPath"
}
Write-Host 'OK. Restart DeepSeek Harness.' -ForegroundColor Green
