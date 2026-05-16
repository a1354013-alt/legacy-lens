import { spawn } from "node:child_process";

const composeProjectName = globalThis.process.env.COMPOSE_PROJECT_NAME ?? `legacy-lens-smoke-${Date.now()}`;
const hostPort = globalThis.process.env.LEGACY_LENS_PORT ?? "38080";
const hostDbPort = globalThis.process.env.LEGACY_LENS_DB_PORT ?? "33306";
const pollTimeoutMs = Number.parseInt(globalThis.process.env.LEGACY_LENS_SMOKE_TIMEOUT_MS ?? "180000", 10);
const pollIntervalMs = 2_000;
const services = ["db", "migrate", "app"];

let lastMigrateOutput = "";

function buildCommandEnv(extraEnv = {}) {
  return {
    ...globalThis.process.env,
    COMPOSE_PROJECT_NAME: composeProjectName,
    LEGACY_LENS_PORT: hostPort,
    LEGACY_LENS_DB_PORT: hostDbPort,
    ...extraEnv,
  };
}

function commandToString(command, args) {
  return `${command} ${args.join(" ")}`.trim();
}

function formatDockerError(error) {
  const details =
    error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr.trim()
      : "";
  const message = error instanceof Error ? error.message : String(error);
  const combinedMessage = details ? `${message}\n${details}` : message;
  const normalized = combinedMessage.toLowerCase();
  if (
    normalized.includes("docker api") ||
    normalized.includes("docker daemon") ||
    normalized.includes("dockerdesktoplinuxengine") ||
    normalized.includes("the system cannot find the file specified")
  ) {
    return `${combinedMessage}. Make sure Docker Desktop or the Docker daemon is running before retrying.`;
  }

  return combinedMessage;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: buildCommandEnv(options.env),
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdoutChunks.push(text);
      if (options.printStdout !== false) {
        globalThis.process.stdout.write(text);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrChunks.push(text);
      if (options.printStderr !== false) {
        globalThis.process.stderr.write(text);
      }
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      const stdout = stdoutChunks.join("");
      const stderr = stderrChunks.join("");
      if (code === 0) {
        resolve({ code, stdout, stderr });
        return;
      }

      const detailSuffix = stderr.trim() ? `\n${stderr.trim()}` : stdout.trim() ? `\n${stdout.trim()}` : "";
      const error = new Error(`${commandToString(command, args)} exited with code ${code ?? "unknown"}${detailSuffix}`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

async function runCompose(args, options = {}) {
  return runCommand("docker", ["compose", ...args], options);
}

async function captureCompose(args) {
  try {
    const result = await runCompose(args, {
      printStdout: false,
      printStderr: false,
    });
    return result.stdout.trim();
  } catch (error) {
    return `Unable to run ${commandToString("docker", ["compose", ...args])}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function dumpDiagnostics(contextMessage) {
  globalThis.console.error(`\n[diagnostics] ${contextMessage}`);

  const composePs = await captureCompose(["ps"]);
  if (composePs) {
    globalThis.console.error("\n[docker compose ps]");
    globalThis.console.error(composePs);
  }

  for (const service of services) {
    const logs = await captureCompose(["logs", "--no-color", service]);
    if (logs) {
      globalThis.console.error(`\n[docker compose logs ${service}]`);
      globalThis.console.error(logs);
    }
  }

  if (lastMigrateOutput) {
    globalThis.console.error("\n[migrate run output]");
    globalThis.console.error(lastMigrateOutput.trimEnd());
  }
}

async function getComposeContainerId(service) {
  const result = await runCompose(["ps", "-q", service], {
    printStdout: false,
    printStderr: false,
  });
  return result.stdout.trim();
}

async function inspectContainerState(containerId) {
  const result = await runCommand(
    "docker",
    [
      "inspect",
      "--format",
      "{{json .State}}",
      containerId,
    ],
    {
      printStdout: false,
      printStderr: false,
    }
  );

  return JSON.parse(result.stdout.trim());
}

async function waitForServiceHealthy(service) {
  const startedAt = Date.now();
  let lastStateSummary = "container not created";

  while (Date.now() - startedAt < pollTimeoutMs) {
    const containerId = await getComposeContainerId(service);
    if (!containerId) {
      lastStateSummary = "container id unavailable";
      await new Promise((resolve) => globalThis.setTimeout(resolve, pollIntervalMs));
      continue;
    }

    const state = await inspectContainerState(containerId);
    const healthStatus = state.Health?.Status ?? state.Status ?? "unknown";
    lastStateSummary = healthStatus;

    if (healthStatus === "healthy") {
      return;
    }

    if (healthStatus === "exited" || healthStatus === "dead") {
      throw new Error(`Service "${service}" is ${healthStatus}.`);
    }

    await new Promise((resolve) => globalThis.setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Timed out waiting for service "${service}" to become healthy. Last state: ${lastStateSummary}.`);
}

async function waitForHttp(url, validator) {
  const startedAt = Date.now();
  let lastError = null;
  let lastStatus = null;

  while (Date.now() - startedAt < pollTimeoutMs) {
    try {
      const response = await globalThis.fetch(url, { redirect: "manual" });
      lastStatus = response.status;
      if (await validator(response)) {
        return;
      }

      lastError = new Error(`Unexpected response ${response.status} from ${url}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => globalThis.setTimeout(resolve, pollIntervalMs));
  }

  if (lastError instanceof Error) {
    throw new Error(`${lastError.message}${lastStatus ? ` (last status: ${lastStatus})` : ""}`);
  }

  throw new Error(`Timed out waiting for ${url}${lastStatus ? ` (last status: ${lastStatus})` : ""}`);
}

async function verifyDockerAvailable() {
  await runCommand("docker", ["version"], {
    printStdout: false,
    printStderr: false,
  });
}

async function runMigrate() {
  const result = await runCompose(["run", "--rm", "migrate"], {
    printStdout: false,
    printStderr: false,
  });
  lastMigrateOutput = [result.stdout, result.stderr].filter(Boolean).join("");
  if (lastMigrateOutput) {
    globalThis.console.log(lastMigrateOutput.trimEnd());
  }
}

async function main() {
  globalThis.console.log(
    `Using COMPOSE_PROJECT_NAME=${composeProjectName}, LEGACY_LENS_PORT=${hostPort}, LEGACY_LENS_DB_PORT=${hostDbPort}`
  );

  let shouldTearDown = false;
  try {
    await verifyDockerAvailable();

    globalThis.console.log("\n[step] docker compose build");
    await runCompose(["build"]);
    shouldTearDown = true;

    globalThis.console.log("\n[step] docker compose up -d db");
    await runCompose(["up", "-d", "db"]);

    globalThis.console.log("\n[step] wait for db healthy");
    await waitForServiceHealthy("db");

    globalThis.console.log("\n[step] docker compose run --rm migrate");
    await runMigrate();

    globalThis.console.log("\n[step] docker compose up -d --no-deps app");
    await runCompose(["up", "-d", "--no-deps", "app"]);

    globalThis.console.log("\n[step] wait for /health");
    await waitForHttp(`http://127.0.0.1:${hostPort}/health`, async (response) => response.ok);

    globalThis.console.log("\n[step] wait for /api/health");
    await waitForHttp(`http://127.0.0.1:${hostPort}/api/health`, async (response) => response.ok);

    globalThis.console.log("\n[step] wait for /api/dev/login redirect");
    await waitForHttp(
      `http://127.0.0.1:${hostPort}/api/dev/login?next=%2F`,
      async (response) => response.status >= 300 && response.status < 400
    );

    globalThis.console.log("\nDocker smoke test passed.");
  } catch (error) {
    await dumpDiagnostics(error instanceof Error ? error.message : String(error));
    throw new Error(formatDockerError(error));
  } finally {
    if (shouldTearDown) {
      await runCompose(["down", "-v"], {
        printStdout: true,
        printStderr: true,
      }).catch((error) => {
        globalThis.console.error("Failed to tear down docker compose stack:", error);
      });
    }
  }
}

await main();
