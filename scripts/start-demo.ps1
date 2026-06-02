$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

function Test-Command($command, $displayName) {
  try {
    & $command --version | Out-Null
  } catch {
    Write-Host ""
    Write-Host "$displayName is required to start the Legacy Lens demo."
    Write-Host "Install Docker Desktop, start it, then run start-demo.cmd again."
    exit 1
  }
}

Test-Command "docker" "Docker"

try {
  docker compose version | Out-Null
} catch {
  Write-Host ""
  Write-Host "Docker Compose is required to start the Legacy Lens demo."
  Write-Host "Install or update Docker Desktop, then run start-demo.cmd again."
  exit 1
}

if (-not $env:LEGACY_LENS_PORT) {
  $env:LEGACY_LENS_PORT = "3000"
}
if (-not $env:LEGACY_LENS_DB_PORT) {
  $env:LEGACY_LENS_DB_PORT = "3306"
}
if (-not $env:APP_VERSION) {
  $env:APP_VERSION = "demo"
}

Write-Host ""
Write-Host "Starting Legacy Lens local demo..."
Write-Host "App URL: http://localhost:$env:LEGACY_LENS_PORT"
Write-Host "Click Sign in to enter the demo; dev auth bypass is enabled only in docker-compose.demo.yml."
Write-Host ""
Write-Host "If a port is already in use, run:"
Write-Host '$env:LEGACY_LENS_PORT=3100'
Write-Host '$env:LEGACY_LENS_DB_PORT=3310'
Write-Host '.\start-demo.cmd'
Write-Host ""

docker compose -f docker-compose.demo.yml up --build
