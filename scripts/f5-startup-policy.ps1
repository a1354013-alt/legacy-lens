function Get-F5StartupDecision {
  param(
    [bool] $ReadyHealthy
  )

  if ($ReadyHealthy) {
    return [pscustomobject]@{
      startupAction            = "OpenExisting"
      shouldRunComposeUp       = $false
      shouldAttemptAppRecovery = $false
      reason                   = "ready_healthy"
    }
  }

  return [pscustomobject]@{
    startupAction            = "ComposeUp"
    shouldRunComposeUp       = $true
    shouldAttemptAppRecovery = $false
    reason                   = "partial_stack"
  }
}

function Get-F5StartupAction {
  param(
    [bool] $ReadyHealthy
  )

  return (Get-F5StartupDecision -ReadyHealthy $ReadyHealthy).startupAction
}

function Get-F5RecoveryDecision {
  param(
    [bool] $ReadyHealthy,
    [string] $AppStatus,
    [string] $MigrateStatus,
    [int] $MigrateExitCode,
    [bool] $RecoveryAlreadyAttempted
  )

  if ($ReadyHealthy) {
    return [pscustomobject]@{
      recoveryAction            = "None"
      shouldAttemptAppRecovery  = $false
      reason                    = "ready_healthy"
    }
  }

  if ($RecoveryAlreadyAttempted) {
    return [pscustomobject]@{
      recoveryAction            = "None"
      shouldAttemptAppRecovery  = $false
      reason                    = "recovery_already_attempted"
    }
  }

  if ($MigrateStatus -eq "exited" -and $MigrateExitCode -ne 0) {
    return [pscustomobject]@{
      recoveryAction            = "None"
      shouldAttemptAppRecovery  = $false
      reason                    = "migrate_failed"
    }
  }

  if ($AppStatus -eq "running") {
    return [pscustomobject]@{
      recoveryAction            = "ForceRecreateApp"
      shouldAttemptAppRecovery  = $true
      reason                    = "running_unhealthy_app"
    }
  }

  return [pscustomobject]@{
    recoveryAction            = "None"
    shouldAttemptAppRecovery  = $false
    reason                    = "app_not_running"
  }
}

function Get-F5RecoveryAction {
  param(
    [bool] $ReadyHealthy,
    [string] $AppStatus,
    [string] $MigrateStatus,
    [int] $MigrateExitCode,
    [bool] $RecoveryAlreadyAttempted
  )

  return (
    Get-F5RecoveryDecision `
      -ReadyHealthy $ReadyHealthy `
      -AppStatus $AppStatus `
      -MigrateStatus $MigrateStatus `
      -MigrateExitCode $MigrateExitCode `
      -RecoveryAlreadyAttempted $RecoveryAlreadyAttempted
  ).recoveryAction
}
