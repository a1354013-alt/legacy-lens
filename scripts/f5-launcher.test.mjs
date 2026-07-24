import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readProjectFile(relativePath) {
  return readFileSync(path.join(projectRoot, relativePath), "utf8");
}

describe("VS Code F5 launcher", () => {
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
    expect(launcher).toContain("Get-F5StartupAction");
    expect(launcher).toContain("Start-ComposeDetached");
    expect(launcher).not.toContain("Test-ComposeStackActive");
    expect(launcher).toContain('Get-PackageVersion');
    expect(launcher).toContain('must be an integer between 1 and 65535');
    expect(launcher).toContain('Get-ValidatedPortValue -VariableName "LEGACY_LENS_PORT"');
    expect(launcher).toContain('Get-ValidatedPortValue -VariableName "LEGACY_LENS_DB_PORT"');
  });

  it("uses readiness, not partial containers, as the only startup decision", () => {
    const launcher = readProjectFile("scripts/f5-start.ps1");

    expect(launcher).toContain("$startupAction = Get-F5StartupAction -ReadyHealthy (Invoke-ReadyCheck -Url $readyUrl)");
    expect(launcher).toContain('if ($startupAction -eq "OpenExisting")');
    expect(launcher).toMatch(/Assert-PortsAvailableForStartup\s+Start-ComposeDetached\s+Wait-ForReadiness/s);
  });

  it("repairs DB-only, DB+migrate, and unhealthy-app stacks with exactly one compose up decision", () => {
    const policyPath = path.join(projectRoot, "scripts", "f5-startup-policy.ps1");
    const command = [
      `. '${policyPath.replaceAll("'", "''")}'`,
      "[pscustomobject]@{ Ready = Get-F5StartupAction -ReadyHealthy $true",
      "DbOnly = Get-F5StartupAction -ReadyHealthy $false",
      "DbAndMigrate = Get-F5StartupAction -ReadyHealthy $false",
      "UnhealthyApp = Get-F5StartupAction -ReadyHealthy $false",
      "} | ConvertTo-Json -Compress",
    ].join("; ");
    const output = execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    const decisions = JSON.parse(output);

    expect(decisions.Ready).toBe("OpenExisting");
    expect(decisions.DbOnly).toBe("ComposeUp");
    expect(decisions.DbAndMigrate).toBe("ComposeUp");
    expect(decisions.UnhealthyApp).toBe("ComposeUp");

    const launcher = readProjectFile("scripts/f5-start.ps1");
    expect((launcher.match(/Start-ComposeDetached/g) ?? []).length).toBe(2);
  });

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
});
