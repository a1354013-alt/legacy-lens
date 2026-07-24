$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot
. (Join-Path $PSScriptRoot "f5-startup-policy.ps1")

$composeArgs = @("compose", "-f", "docker-compose.demo.yml")
$startupTimeoutSeconds = 180
$pollIntervalSeconds = 2
$readyRequestTimeoutSeconds = 5
$script:dockerCommandAvailable = $false

function Write-Step([string] $Message) {
  Write-Host $Message
}

function Fail-Startup([string] $Message) {
  throw [System.InvalidOperationException]::new($Message)
}

function Test-CommandAvailable([string] $CommandName) {
  return $null -ne (Get-Command $CommandName -ErrorAction SilentlyContinue)
}

function Initialize-DefaultEnvironment {
  if (-not $env:LEGACY_LENS_PORT) {
    $env:LEGACY_LENS_PORT = "3000"
  }

  if (-not $env:LEGACY_LENS_DB_PORT) {
    $env:LEGACY_LENS_DB_PORT = "3306"
  }

  if (-not $env:APP_VERSION) {
    $env:APP_VERSION = Get-PackageVersion
  }
}

function Get-PackageVersion {
  $packageJsonPath = Join-Path $repoRoot "package.json"

  try {
    $packageJson = Get-Content -Path $packageJsonPath -Raw | ConvertFrom-Json
  } catch {
    Fail-Startup "Unable to read package.json to determine the default APP_VERSION."
  }

  if (-not $packageJson.version -or [string]::IsNullOrWhiteSpace([string] $packageJson.version)) {
    Fail-Startup "package.json does not define a usable version for the default APP_VERSION."
  }

  return [string] $packageJson.version
}

function Get-ReadyUrl {
  return "http://localhost:$($env:LEGACY_LENS_PORT)/ready"
}

function Get-AppUrl {
  return "http://localhost:$($env:LEGACY_LENS_PORT)"
}

function Test-HostPortInUse([int] $Port) {
  $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
  return $listeners.Port -contains $Port
}

function Invoke-ReadyCheck {
  param(
    [string] $Url
  )

  try {
    $response = Invoke-WebRequest -Uri $Url -TimeoutSec $readyRequestTimeoutSeconds -UseBasicParsing
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    return $false
  }
}

function Invoke-DockerChecked {
  param(
    [string[]] $Arguments,
    [switch] $IgnoreFailure
  )

  $output = & docker @Arguments 2>&1
  $exitCode = $LASTEXITCODE
  if (-not $IgnoreFailure -and $exitCode -ne 0) {
    throw ($output | Out-String).Trim()
  }

  return ($output | Out-String)
}

function Get-ComposeCommandText([string[]] $Arguments) {
  return "docker $($Arguments -join ' ')"
}

function Initialize-LogFile {
  $logDir = Join-Path $repoRoot ".tmp"
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null

  $script:logPath = Join-Path $logDir "f5-start.log"
  Set-Content -Path $script:logPath -Encoding utf8 -Value @(
    "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), (Get-ComposeCommandText ($composeArgs + @("up", "-d", "--build")))
  )
}

function Get-LogText {
  if (-not $script:logPath -or -not (Test-Path $script:logPath)) {
    return ""
  }

  return Get-Content -Path $script:logPath -Raw
}

function Show-LogTail {
  if (-not $script:logPath -or -not (Test-Path $script:logPath)) {
    return
  }

  Write-Host ""
  Write-Host "Last 80 lines of startup log ($script:logPath):"
  Get-Content -Path $script:logPath -Tail 80
}

function Show-ComposeDiagnostics {
  if (-not $script:dockerCommandAvailable) {
    return
  }

  Write-Host ""
  Write-Host "docker compose -f docker-compose.demo.yml ps"
  Invoke-DockerChecked -Arguments ($composeArgs + @("ps")) -IgnoreFailure | Write-Host

  Write-Host ""
  Write-Host "docker compose -f docker-compose.demo.yml logs --tail 80 app migrate db"
  Invoke-DockerChecked -Arguments ($composeArgs + @("logs", "--tail", "80", "app", "migrate", "db")) -IgnoreFailure | Write-Host
}

function Get-ComposeServiceContainerId([string] $ServiceName) {
  $result = Invoke-DockerChecked -Arguments ($composeArgs + @("ps", "-q", $ServiceName)) -IgnoreFailure
  return $result.Trim()
}

function Get-ComposeServiceState([string] $ServiceName) {
  $containerId = Get-ComposeServiceContainerId -ServiceName $ServiceName
  if (-not $containerId) {
    return $null
  }

  $stateJson = Invoke-DockerChecked -Arguments @("inspect", "--format", "{{json .State}}", $containerId) -IgnoreFailure
  if (-not $stateJson.Trim()) {
    return $null
  }

  return $stateJson | ConvertFrom-Json
}

function Get-StartupFailureReason {
  $logText = (Get-LogText).ToLowerInvariant()
  $appState = Get-ComposeServiceState -ServiceName "app"
  $migrateState = Get-ComposeServiceState -ServiceName "migrate"
  $dbState = Get-ComposeServiceState -ServiceName "db"

  if ($migrateState -and $migrateState.Status -eq "exited" -and $migrateState.ExitCode -ne 0) {
    return "The migrate container failed before Legacy Lens became ready."
  }

  if ($appState -and ($appState.Status -eq "exited" -or $appState.Status -eq "dead")) {
    return "The app container exited during startup."
  }

  if ($dbState -and ($dbState.Status -eq "exited" -or $dbState.Status -eq "dead")) {
    return "The database container exited during startup."
  }

  if ($logText.Contains("port is already allocated") -or $logText.Contains("bind: address already in use")) {
    return "The configured application or database port is already in use."
  }

  if ($logText.Contains("failed to solve") -or $logText.Contains("error: build")) {
    return "Docker image build failed."
  }

  if ($logText.Contains("connect econnrefused") -or $logText.Contains("drizzle-kit migrate")) {
    return "The migrate container could not connect to the database."
  }

  return "Docker Compose failed to start the demo stack."
}

function Assert-Prerequisites {
  Write-Step "Checking Docker..."

  if (-not (Test-CommandAvailable "docker")) {
    Fail-Startup "Docker is not installed or is not available on PATH."
  }

  $script:dockerCommandAvailable = $true

  try {
    Invoke-DockerChecked -Arguments @("compose", "version") | Out-Null
  } catch {
    Fail-Startup "Docker Compose is unavailable. Install or update Docker Desktop and try again."
  }

  try {
    Invoke-DockerChecked -Arguments @("info") | Out-Null
  } catch {
    Fail-Startup "Docker Desktop is not running. Start Docker Desktop and wait for it to finish starting."
  }
}

function Get-ValidatedPortValue {
  param(
    [string] $VariableName,
    [string] $DisplayName
  )

  $rawValue = [string] (Get-Item -Path "Env:$VariableName").Value
  $parsed = 0
  if (-not [int]::TryParse($rawValue, [ref] $parsed) -or $parsed -lt 1 -or $parsed -gt 65535) {
    Fail-Startup "$DisplayName must be an integer between 1 and 65535. Received '$rawValue'."
  }

  return $parsed
}

function Assert-PortsAvailableForStartup {
  if (Invoke-ReadyCheck -Url (Get-ReadyUrl)) {
    return
  }

  $runningServices = Invoke-DockerChecked -Arguments ($composeArgs + @("ps", "--services", "--status", "running")) -IgnoreFailure
  $runningSet = @{}
  foreach ($service in ($runningServices -split "`r?`n")) {
    if ($service.Trim()) {
      $runningSet[$service.Trim()] = $true
    }
  }

  $appPort = Get-ValidatedPortValue -VariableName "LEGACY_LENS_PORT" -DisplayName "LEGACY_LENS_PORT"
  if ((Test-HostPortInUse -Port $appPort) -and -not $runningSet.ContainsKey("app")) {
    Fail-Startup "Application port $appPort is already in use. Stop the conflicting process or set LEGACY_LENS_PORT to another port."
  }

  $dbPort = Get-ValidatedPortValue -VariableName "LEGACY_LENS_DB_PORT" -DisplayName "LEGACY_LENS_DB_PORT"
  if ((Test-HostPortInUse -Port $dbPort) -and -not $runningSet.ContainsKey("db")) {
    Fail-Startup "Database port $dbPort is already in use. Stop the conflicting process or set LEGACY_LENS_DB_PORT to another port."
  }
}

function Start-ComposeDetached {
  Initialize-LogFile

  Write-Step "Starting Legacy Lens..."

  $stdoutPath = Join-Path $repoRoot ".tmp\f5-start.stdout.log"
  $stderrPath = Join-Path $repoRoot ".tmp\f5-start.stderr.log"
  Remove-Item -Path $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue

  $process = Start-Process -FilePath "docker" `
    -ArgumentList ($composeArgs + @("up", "-d", "--build")) `
    -WorkingDirectory $repoRoot `
    -NoNewWindow `
    -Wait `
    -PassThru `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath

  foreach ($capturePath in @($stdoutPath, $stderrPath)) {
    if (Test-Path $capturePath) {
      Get-Content -Path $capturePath | Out-File -FilePath $script:logPath -Append -Encoding utf8
    }
  }

  if ($process.ExitCode -ne 0) {
    Fail-Startup (Get-StartupFailureReason)
  }
}

function Wait-ForReadiness {
  Write-Step "Waiting for the application..."

  $deadline = (Get-Date).AddSeconds($startupTimeoutSeconds)
  $readyUrl = Get-ReadyUrl
  while ((Get-Date) -lt $deadline) {
    if (Invoke-ReadyCheck -Url $readyUrl) {
      return
    }

    $appState = Get-ComposeServiceState -ServiceName "app"
    if ($null -ne $appState -and ($appState.Status -eq "exited" -or $appState.Status -eq "dead")) {
      Fail-Startup "The app container exited before Legacy Lens became ready."
    }

    $migrateState = Get-ComposeServiceState -ServiceName "migrate"
    if ($null -ne $migrateState -and $migrateState.Status -eq "exited" -and $migrateState.ExitCode -ne 0) {
      Fail-Startup "The migrate container failed before Legacy Lens became ready."
    }

    $dbState = Get-ComposeServiceState -ServiceName "db"
    if ($null -ne $dbState -and ($dbState.Status -eq "exited" -or $dbState.Status -eq "dead")) {
      Fail-Startup "The database container exited before Legacy Lens became ready."
    }

    Start-Sleep -Seconds $pollIntervalSeconds
  }

  Fail-Startup "Timed out waiting for /ready after $startupTimeoutSeconds seconds."
}

Initialize-DefaultEnvironment

try {
  Get-ValidatedPortValue -VariableName "LEGACY_LENS_PORT" -DisplayName "LEGACY_LENS_PORT" | Out-Null
  Get-ValidatedPortValue -VariableName "LEGACY_LENS_DB_PORT" -DisplayName "LEGACY_LENS_DB_PORT" | Out-Null
  Assert-Prerequisites

  $appUrl = Get-AppUrl
  $readyUrl = Get-ReadyUrl

  $startupAction = Get-F5StartupAction -ReadyHealthy (Invoke-ReadyCheck -Url $readyUrl)

  if ($startupAction -eq "OpenExisting") {
    Write-Step "Legacy Lens is already running."
    Write-Step "Opening $appUrl"
    Start-Process $appUrl
    exit 0
  }

  Assert-PortsAvailableForStartup
  Start-ComposeDetached
  Wait-ForReadiness

  Write-Step "Legacy Lens is ready."
  Write-Step "Opening $appUrl"
  Start-Process $appUrl
  exit 0
} catch {
  $originalErrorMessage = $_.Exception.Message

  Write-Host ""
  Write-Host "Legacy Lens failed to start."
  Write-Host $originalErrorMessage

  try {
    Show-LogTail
  } catch {
    Write-Host ""
    Write-Host "Unable to read startup log:"
    Write-Host $_.Exception.Message
  }

  try {
    Show-ComposeDiagnostics
  } catch {
    Write-Host ""
    Write-Host "Unable to collect Docker diagnostics:"
    Write-Host $_.Exception.Message
  }

  exit 1
}
