function Get-F5StartupAction {
  param(
    [bool] $ReadyHealthy
  )

  if ($ReadyHealthy) {
    return "OpenExisting"
  }

  return "ComposeUp"
}
