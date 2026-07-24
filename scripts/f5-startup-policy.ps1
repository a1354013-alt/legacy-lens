function Get-F5StartupAction {
  param(
    [bool] $ReadyHealthy
  )

  if ($ReadyHealthy) {
    return "OpenExisting"
  }

  return "ComposeUp"
}

function Get-F5RecoveryAction {
  param(
    [bool] $ReadyHealthy,
    [string] $AppStatus,
    [string] $MigrateStatus,
    [int] $MigrateExitCode,
    [bool] $RecoveryAlreadyAttempted
  )

  if ($ReadyHealthy -or $RecoveryAlreadyAttempted) {
    return "None"
  }

  if ($MigrateStatus -eq "exited" -and $MigrateExitCode -ne 0) {
    return "None"
  }

  if ($AppStatus -eq "running") {
    return "ForceRecreateApp"
  }

  return "None"
}
