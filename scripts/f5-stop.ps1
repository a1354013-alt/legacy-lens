$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

try {
  & docker compose -f docker-compose.demo.yml down
  if ($LASTEXITCODE -ne 0) {
    throw "docker compose down exited with code $LASTEXITCODE."
  }

  Write-Host "Legacy Lens demo stopped."
  exit 0
} catch {
  Write-Host "Failed to stop the Legacy Lens demo."
  Write-Host $_.Exception.Message
  exit 1
}
