# IziTest Agent — Launch Chrome with a named profile (Windows)
# Usage: powershell -ExecutionPolicy Bypass -File scripts\launch-profile.ps1 <profile-name>
# Each profile gets its own user data directory = isolated cookies, sessions, history.
# The same as launch-profile.sh on macOS / Linux.
# Starts Google Chrome, or Microsoft Edge (which Windows already has) where Chrome is not installed.

param([string]$ProfileName = "default")

$ProfileDir = Join-Path $env:USERPROFILE ".izitest\profiles\$ProfileName"
New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

# Chrome first, then Edge: the first one found is started.
$Roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) | Where-Object { $_ }
$Browsers = @(
  @{ Name = "Chrome"; Exe = "Google\Chrome\Application\chrome.exe" },
  @{ Name = "Edge"; Exe = "Microsoft\Edge\Application\msedge.exe" }
)
$BrowserName = $null
$BrowserPath = $null
foreach ($Browser in $Browsers) {
  $Found = $Roots | ForEach-Object { Join-Path $_ $Browser.Exe } | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($Found) {
    $BrowserName = $Browser.Name
    $BrowserPath = $Found
    break
  }
}

if (-not $BrowserPath) {
  Write-Host "Neither Chrome nor Edge found in Program Files nor in $env:LOCALAPPDATA."
  Write-Host "Adjust the path if your browser is installed elsewhere."
  exit 1
}

Write-Host "Launching $BrowserName profile: $ProfileName"
Write-Host "User data dir: $ProfileDir"
Write-Host ""
Write-Host "IMPORTANT: Install the IziTest Agent extension in this profile:"
if ($BrowserName -eq "Edge") {
  Write-Host "  1. Go to edge://extensions"
  Write-Host "  2. Enable Developer mode, at the bottom of the menu on the left"
  Write-Host "  3. Click 'Load unpacked' on the 'Developer options' line"
  Write-Host "     (in a narrow window: the first of its three icons)"
} else {
  Write-Host "  1. Go to chrome://extensions"
  Write-Host "  2. Enable Developer Mode"
  Write-Host "  3. Click 'Load unpacked'"
}
Write-Host "  4. Select the 'extension\dist' folder"
Write-Host "  5. Set the profile ID to '$ProfileName' in the popup"
Write-Host ""
Write-Host "Where $BrowserName may not have extensions (a company computer), use IziTest's browser"
Write-Host "without windows instead: npm run headless:install"
Write-Host ""

$Process = Start-Process -FilePath $BrowserPath -PassThru -ArgumentList @(
  "--user-data-dir=`"$ProfileDir`"",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-sync",
  "--silent-debugger-extension-api"
)

Write-Host "$BrowserName launched (PID: $($Process.Id))"
