import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readProjectFile(relativePath) {
  return readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function isExecutableOnPath(executable) {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const candidateNames = process.platform === "win32" && !path.extname(executable) ? [executable, `${executable}.exe`] : [executable];

  for (const entry of pathEntries) {
    for (const candidateName of candidateNames) {
      const candidatePath = path.join(entry, candidateName);
      try {
        accessSync(candidatePath, constants.X_OK);
        return true;
      } catch {
        // Keep scanning PATH entries until a matching executable is found.
      }
    }
  }

  return false;
}

function powerShellExecutableCandidates(platform = process.platform) {
  return platform === "win32" ? ["powershell.exe", "pwsh"] : ["pwsh", "powershell"];
}

function resolvePowerShellExecutable(platform = process.platform, hasExecutable = isExecutableOnPath) {
  const candidates = powerShellExecutableCandidates(platform);

  for (const candidate of candidates) {
    if (hasExecutable(candidate)) {
      return candidate;
    }
  }

  throw new Error(`PowerShell executable was not found on PATH. Tried: ${candidates.join(", ")}`);
}

function runPowerShellCommand(command) {
  const executable = resolvePowerShellExecutable();

  try {
    return execFileSync(executable, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      cwd: projectRoot,
      encoding: "utf8",
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`PowerShell executable '${executable}' was not found on PATH. Tried: ${powerShellExecutableCandidates().join(", ")}`);
    }

    throw error;
  }
}

const launcherPolicyTestTimeoutMs = 15_000;

function policyPathCommandPreamble() {
  const policyPath = path.join(projectRoot, "scripts", "f5-startup-policy.ps1");
  return `. '${policyPath.replaceAll("'", "''")}'`;
}

function runPowerShellJson(command) {
  return JSON.parse(runPowerShellCommand(command));
}

function getStartupDecision(readyHealthy) {
  const command = [
    policyPathCommandPreamble(),
    `Get-F5StartupDecision -ReadyHealthy $${readyHealthy ? "true" : "false"} | ConvertTo-Json -Compress`,
  ].join("; ");
  return runPowerShellJson(command);
}

function getRecoveryDecision({
  readyHealthy,
  appStatus,
  migrateStatus,
  migrateExitCode,
  recoveryAlreadyAttempted,
}) {
  const command = [
    policyPathCommandPreamble(),
    `Get-F5RecoveryDecision -ReadyHealthy $${readyHealthy ? "true" : "false"} -AppStatus '${appStatus.replaceAll("'", "''")}' -MigrateStatus '${migrateStatus.replaceAll("'", "''")}' -MigrateExitCode ${migrateExitCode} -RecoveryAlreadyAttempted $${recoveryAlreadyAttempted ? "true" : "false"} | ConvertTo-Json -Compress`,
  ].join("; ");
  return runPowerShellJson(command);
}

describe("VS Code F5 launcher", () => {
  it("resolves PowerShell executables deterministically across Windows and non-Windows runners", () => {
    expect(powerShellExecutableCandidates("win32")).toEqual(["powershell.exe", "pwsh"]);
    expect(powerShellExecutableCandidates("linux")).toEqual(["pwsh", "powershell"]);
    expect(resolvePowerShellExecutable("win32", (candidate) => candidate === "pwsh")).toBe("pwsh");
    expect(resolvePowerShellExecutable("linux", (candidate) => candidate === "powershell")).toBe("powershell");
    expect(() => resolvePowerShellExecutable("linux", () => false)).toThrow("Tried: pwsh, powershell");
  });

  it("keeps exactly one launch configuration and points it at scripts/f5-start.ps1", () => {
    const launchJson = JSON.parse(readProjectFile(".vscode/launch.json"));

    expect(Array.isArray(launchJson.configurations)).toBe(true);
    expect(launchJson.configurations).toHaveLength(1);
    expect(launchJson.configurations[0]).toMatchObject({
      name: "Legacy Lens: Start and Open",
      type: "node-terminal",
      request: "launch",
      cwd: "${workspaceFolder}",
    });
    expect(launchJson.configurations[0].command).toContain("scripts\\f5-start.ps1");
  });

  it("keeps reset as a separate explicit task and exposes start, stop, and logs tasks", () => {
    const tasksJson = JSON.parse(readProjectFile(".vscode/tasks.json"));
    const labels = tasksJson.tasks.map((task) => task.label);

    expect(labels).toEqual([
      "Legacy Lens: Start and Open",
      "Legacy Lens: Stop Demo",
      "Legacy Lens: Reset Demo DB",
      "Legacy Lens: Show Demo Logs",
    ]);

    const startTask = tasksJson.tasks.find((task) => task.label === "Legacy Lens: Start and Open");
    expect(startTask.args.join(" ")).toContain("scripts\\f5-start.ps1");

    const stopTask = tasksJson.tasks.find((task) => task.label === "Legacy Lens: Stop Demo");
    expect(stopTask.args.join(" ")).toContain("scripts\\f5-stop.ps1");

    const resetTask = tasksJson.tasks.find((task) => task.label === "Legacy Lens: Reset Demo DB");
    expect(resetTask.command).toBe("docker compose -f docker-compose.demo.yml down -v");

    const logsTask = tasksJson.tasks.find((task) => task.label === "Legacy Lens: Show Demo Logs");
    expect(logsTask.command).toBe("docker compose -f docker-compose.demo.yml logs --tail 200 -f app migrate db");
  });
});

describe("shared launcher implementation", () => {
  it("starts docker compose in detached mode, waits for /ready, opens the configured port, and uses a bounded timeout", () => {
    const launcher = readProjectFile("scripts/f5-start.ps1");

    expect(launcher).toContain('-ArgumentList ($composeArgs + @("up", "-d", "--build"))');
    expect(launcher).toContain('http://localhost:$($env:LEGACY_LENS_PORT)/ready');
    expect(launcher).toContain('Start-Process $appUrl');
    expect(launcher).toContain("$startupTimeoutSeconds = 180");
    expect(launcher).toContain("Timed out waiting for /ready");
    expect(launcher).toContain("Legacy Lens is already running.");
    expect(launcher).toContain("Get-F5StartupDecision");
    expect(launcher).toContain("Start-ComposeDetached");
    expect(launcher).not.toContain("Test-ComposeStackActive");
    expect(launcher).toContain('Get-PackageVersion');
    expect(launcher).toContain('must be an integer between 1 and 65535');
    expect(launcher).toContain('Get-ValidatedPortValue -VariableName "LEGACY_LENS_PORT"');
    expect(launcher).toContain('Get-ValidatedPortValue -VariableName "LEGACY_LENS_DB_PORT"');
  });

  it("uses readiness, not partial containers, as the only startup decision", () => {
    const launcher = readProjectFile("scripts/f5-start.ps1");

    expect(launcher).toContain("$startupDecision = Get-F5StartupDecision -ReadyHealthy (Invoke-ReadyCheck -Url $readyUrl)");
    expect(launcher).toContain('$startupAction = [string] $startupDecision.startupAction');
    expect(launcher).toContain('if ($startupAction -eq "OpenExisting")');
    expect(launcher).toMatch(/Assert-PortsAvailableForStartup\s+Start-ComposeDetached\s+\$readyAfterStartup = Wait-ForReadiness/s);
    expect(launcher).toMatch(/Restart-AppServiceForRecovery\s+}\s+Wait-ForReadiness/s);
  });

  it("keeps a healthy ready app on the existing stack without compose up", () => {
    const decision = getStartupDecision(true);

    expect(decision).toMatchObject({
      startupAction: "OpenExisting",
      shouldRunComposeUp: false,
      shouldAttemptAppRecovery: false,
      reason: "ready_healthy",
    });
  }, launcherPolicyTestTimeoutMs);

  it("repairs a DB-only stack with exactly one compose up decision", () => {
    const decision = getStartupDecision(false);

    expect(decision).toMatchObject({
      startupAction: "ComposeUp",
      shouldRunComposeUp: true,
      shouldAttemptAppRecovery: false,
      reason: "partial_stack",
    });
  }, launcherPolicyTestTimeoutMs);

  it("repairs a DB plus migrate stack with exactly one compose up decision", () => {
    const decision = getStartupDecision(false);

    expect(decision).toMatchObject({
      startupAction: "ComposeUp",
      shouldRunComposeUp: true,
      shouldAttemptAppRecovery: false,
      reason: "partial_stack",
    });
  }, launcherPolicyTestTimeoutMs);

  it("repairs a running unhealthy app stack with exactly one compose up decision before any recovery logic", () => {
    const decision = getStartupDecision(false);

    expect(decision).toMatchObject({
      startupAction: "ComposeUp",
      shouldRunComposeUp: true,
      shouldAttemptAppRecovery: false,
      reason: "partial_stack",
    });
  }, launcherPolicyTestTimeoutMs);

  it("uses app-only recovery only for a running unhealthy app", () => {
    const decision = getRecoveryDecision({
      readyHealthy: false,
      appStatus: "running",
      migrateStatus: "exited",
      migrateExitCode: 0,
      recoveryAlreadyAttempted: false,
    });

    expect(decision).toMatchObject({
      recoveryAction: "ForceRecreateApp",
      shouldAttemptAppRecovery: true,
      reason: "running_unhealthy_app",
    });
  }, launcherPolicyTestTimeoutMs);

  it("does not use app-only recovery for a healthy ready app", () => {
    const decision = getRecoveryDecision({
      readyHealthy: true,
      appStatus: "running",
      migrateStatus: "exited",
      migrateExitCode: 0,
      recoveryAlreadyAttempted: false,
    });

    expect(decision).toMatchObject({
      recoveryAction: "None",
      shouldAttemptAppRecovery: false,
      reason: "ready_healthy",
    });
  }, launcherPolicyTestTimeoutMs);

  it("does not use app-only recovery when the app service is missing", () => {
    const decision = getRecoveryDecision({
      readyHealthy: false,
      appStatus: "",
      migrateStatus: "exited",
      migrateExitCode: 0,
      recoveryAlreadyAttempted: false,
    });

    expect(decision).toMatchObject({
      recoveryAction: "None",
      shouldAttemptAppRecovery: false,
      reason: "app_not_running",
    });
  }, launcherPolicyTestTimeoutMs);

  it("does not use app-only recovery when the app service is stopped", () => {
    const decision = getRecoveryDecision({
      readyHealthy: false,
      appStatus: "exited",
      migrateStatus: "exited",
      migrateExitCode: 0,
      recoveryAlreadyAttempted: false,
    });

    expect(decision).toMatchObject({
      recoveryAction: "None",
      shouldAttemptAppRecovery: false,
      reason: "app_not_running",
    });
  }, launcherPolicyTestTimeoutMs);

  it("does not use app-only recovery after migrate failure", () => {
    const decision = getRecoveryDecision({
      readyHealthy: false,
      appStatus: "running",
      migrateStatus: "exited",
      migrateExitCode: 1,
      recoveryAlreadyAttempted: false,
    });

    expect(decision).toMatchObject({
      recoveryAction: "None",
      shouldAttemptAppRecovery: false,
      reason: "migrate_failed",
    });
  }, launcherPolicyTestTimeoutMs);

  it("uses app-only recovery at most once", () => {
    const decision = getRecoveryDecision({
      readyHealthy: false,
      appStatus: "running",
      migrateStatus: "exited",
      migrateExitCode: 0,
      recoveryAlreadyAttempted: true,
    });

    expect(decision).toMatchObject({
      recoveryAction: "None",
      shouldAttemptAppRecovery: false,
      reason: "recovery_already_attempted",
    });

    const launcher = readProjectFile("scripts/f5-start.ps1");
    expect((launcher.match(/Restart-AppServiceForRecovery/g) ?? []).length).toBe(2);
    expect(launcher).toContain("-RecoveryAlreadyAttempted $false");
    expect(launcher).toContain('"--force-recreate", "app"');
  }, launcherPolicyTestTimeoutMs);

  it("parses every PowerShell launcher script and reports all syntax errors together", () => {
    const scriptPaths = [
      "scripts/f5-start.ps1",
      "scripts/f5-stop.ps1",
      "scripts/start-demo.ps1",
      "scripts/f5-startup-policy.ps1",
    ].map((relativePath) => path.join(projectRoot, relativePath));
    const quotedScriptPaths = scriptPaths.map((scriptPath) => `'${scriptPath.replaceAll("'", "''")}'`).join(", ");
    const command = [
      "$parseFailures = @()",
      `foreach ($scriptPath in @(${quotedScriptPaths})) {`,
      "  $tokens = $null",
      "  $parseErrors = $null",
      "  [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref] $tokens, [ref] $parseErrors) | Out-Null",
      "  foreach ($parseError in $parseErrors) {",
      "    $parseFailures += \"$($scriptPath): $($parseError.Message)\"",
      "  }",
      "}",
      "if ($parseFailures.Count -gt 0) { throw ($parseFailures -join \"`n\") }",
      "'OK'",
    ].join("; ");

    expect(runPowerShellCommand(command).trim()).toBe("OK");
  }, launcherPolicyTestTimeoutMs);

  it("keeps the legacy Windows entrypoints delegating to the shared launcher", () => {
    const legacyPowerShellLauncher = readProjectFile("scripts/start-demo.ps1");
    const legacyCmdLauncher = readProjectFile("start-demo.cmd");

    expect(legacyPowerShellLauncher).toContain('Join-Path $PSScriptRoot "f5-start.ps1"');
    expect(legacyCmdLauncher).toContain('scripts\\start-demo.ps1');
    expect((legacyCmdLauncher.match(/pause/gi) ?? []).length).toBe(1);
  });

  it("keeps temporary launcher logs ignored by git", () => {
    const gitignore = readProjectFile(".gitignore");
    expect(gitignore).toContain(".tmp/");
    expect(gitignore).toContain("!.vscode/launch.json");
  });

  it("keeps the invalid-port validation in the production launcher", () => {
    const launcher = readProjectFile("scripts/f5-start.ps1");

    expect(launcher).toContain('must be an integer between 1 and 65535');
    expect(launcher).toContain('Get-ValidatedPortValue -VariableName "LEGACY_LENS_PORT"');
    expect(launcher).toContain('Get-ValidatedPortValue -VariableName "LEGACY_LENS_DB_PORT"');
  });

  it("keeps the missing-Docker failure in the production launcher", () => {
    const launcher = readProjectFile("scripts/f5-start.ps1");

    expect(launcher).toContain('Docker is not installed or is not available on PATH.');
    expect(launcher).toContain('Docker Compose is unavailable. Install or update Docker Desktop and try again.');
  });
});
