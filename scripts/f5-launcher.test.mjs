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
  });
});
