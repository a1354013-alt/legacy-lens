$launcherPath = Join-Path $PSScriptRoot "f5-start.ps1"
& $launcherPath @args
exit $LASTEXITCODE
