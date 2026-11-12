# IziTest Agent — Launch Chrome with a named profile (Windows)
# Usage: .\scripts\launch-profile.ps1 <profile-name>
# Each profile gets its own user data directory = isolated cookies, sessions, history.
# The same as launch-profile.sh on macOS / Linux.

param([string]$ProfileName = "default")

$ProfileDir = Join-Path $env:USERPROFILE ".izitest\profiles\$ProfileName"
New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

$Candidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$Chrome = $Candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if (-not $Chrome) {
  Write-Host "Chrome not found in Program Files nor in $env:LOCALAPPDATA."
  Write-Host "Adjust the path if Chrome is installed elsewhere."
  exit 1
}

Write-Host "Launching Chrome profile: $ProfileName"
Write-Host "User data dir: $ProfileDir"
Write-Host ""
Write-Host "IMPORTANT: Install the IziTest Agent extension in this profile:"
Write-Host "  1. Go to chrome://extensions"
Write-Host "  2. Enable Developer Mode"
Write-Host "  3. Click 'Load unpacked'"
Write-Host "  4. Select the 'extension\dist' folder"
Write-Host "  5. Set the profile ID to '$ProfileName' in the popup"
Write-Host ""
Write-Host "Where Chrome may not have extensions (a company computer), use IziTest's browser"
Write-Host "without windows instead: npm run headless:install"
Write-Host ""

$Process = Start-Process -FilePath $Chrome -PassThru -ArgumentList @(
  "--user-data-dir=`"$ProfileDir`"",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-sync",
  "--silent-debugger-extension-api"
)

Write-Host "Chrome launched (PID: $($Process.Id))"
