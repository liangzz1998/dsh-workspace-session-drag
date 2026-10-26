# Install dsh-workspace-session-drag into the desktop profile.
# Run after completely quitting DeepSeek Harness (window + tray icon).
$ErrorActionPreference = 'Stop'

$pluginDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$packageJsonPath = Join-Path $profileDir 'package.json'
$packageName = 'dsh-workspace-session-drag'

Write-Host ''
Write-Host '== dsh-workspace-session-drag installer ==' -ForegroundColor Cyan
Write-Host "plugin : $pluginDir"
Write-Host "profile: $profileDir"

# 1. DeepSeek Harness must be fully closed
$running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($running) {
    Write-Host ''
    Write-Host 'ERROR: DeepSeek Harness is still running.' -ForegroundColor Red
    Write-Host 'Quit it completely (close the window AND the tray icon), then run this again.'
    exit 1
}

if (-not (Test-Path $packageJsonPath)) {
    Write-Host "ERROR: profile package.json not found: $packageJsonPath" -ForegroundColor Red
    exit 1
}

# 2. Backup package.json
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$packageJsonPath.$packageName.$stamp.bak"
Copy-Item $packageJsonPath $backup
Write-Host "backup : $backup"

# 3. Update package.json (dependencies + bundles)
$pkg = Get-Content $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $pkg.PSObject.Properties['dependencies']) {
    $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
}
$pkg.dependencies | Add-Member -NotePropertyName $packageName -NotePropertyValue ("link:" + $pluginDir) -Force

if (-not $pkg.PSObject.Properties['dsh'] -or -not $pkg.dsh.profile) {
    Write-Host 'ERROR: profile package.json has no dsh.profile section.' -ForegroundColor Red
    exit 1
}
$bundles = @($pkg.dsh.profile.bundles)
if ($bundles -notcontains $packageName) {
    $bundles += $packageName
}
$pkg.dsh.profile.bundles = $bundles

$json = $pkg | ConvertTo-Json -Depth 30
[System.IO.File]::WriteAllText($packageJsonPath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
Write-Host 'package.json updated'

# 4. Link the package into profile node_modules
$nodeModules = Join-Path $profileDir 'node_modules'
if (-not (Test-Path $nodeModules)) { New-Item -ItemType Directory -Path $nodeModules | Out-Null }
$linkPath = Join-Path $nodeModules $packageName
if (Test-Path $linkPath) {
    Remove-Item $linkPath -Force -Recurse -ErrorAction SilentlyContinue
}
New-Item -ItemType Junction -Path $linkPath -Target $pluginDir | Out-Null
Write-Host "junction: $linkPath -> $pluginDir"

# 5. Self check
if (-not (Test-Path (Join-Path $linkPath 'package.json'))) {
    Write-Host 'ERROR: junction self-check failed.' -ForegroundColor Red
    exit 1
}
$check = Get-Content $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
$okBundles = @($check.dsh.profile.bundles) -contains $packageName
$okDep = $check.dependencies.PSObject.Properties.Name -contains $packageName
if (-not ($okBundles -and $okDep)) {
    Write-Host 'ERROR: package.json self-check failed.' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host 'OK. Now start DeepSeek Harness again.' -ForegroundColor Green
Write-Host 'Then drag a session onto another workspace group in the sidebar.'
