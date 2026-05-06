import { spawn } from "node:child_process";

const composeProjectName = globalThis.process.env.COMPOSE_PROJECT_NAME ?? `legacy-lens-smoke-${Date.now()}`;
const hostPort = globalThis.process.env.LEGACY_LENS_PORT ?? "38080";
const hostDbPort = globalThis.process.env.LEGACY_LENS_DB_PORT ?? "33306";
const pollTimeoutMs = Number.parseInt(globalThis.process.env.LEGACY_LENS_SMOKE_TIMEOUT_MS ?? "180000", 10);

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: "inherit",
      env: {
        ...globalThis.process.env,
        COMPOSE_PROJECT_NAME: composeProjectName,
        LEGACY_LENS_PORT: hostPort,
        LEGACY_LENS_DB_PORT: hostDbPort,
        ...options.env,
      },
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}

function formatDockerError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.toLowerCase().includes("docker api") || message.toLowerCase().includes("daemon")) {
    return `${message}. Make sure Docker Desktop or the Docker daemon is running before retrying.`;
  }

  return message;
}

async function waitForHttp(url, validator) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < pollTimeoutMs) {
    try {
      const response = await globalThis.fetch(url, { redirect: "manual" });
      if (await validator(response)) {
        return;
      }

      lastError = new Error(`Unexpected response ${response.status} from ${url}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => globalThis.setTimeout(resolve, 2000));
  }

  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

async function main() {
  globalThis.console.log(
    `Using COMPOSE_PROJECT_NAME=${composeProjectName}, LEGACY_LENS_PORT=${hostPort}, LEGACY_LENS_DB_PORT=${hostDbPort}`
  );
  let composeStarted = false;
  try {
    await runCommand("docker", ["compose", "up", "--build", "-d"]);
    composeStarted = true;

    await waitForHttp(`http://127.0.0.1:${hostPort}/health`, async (response) => response.ok);
    await waitForHttp(`http://127.0.0.1:${hostPort}/api/health`, async (response) => response.ok);
    await waitForHttp(
      `http://127.0.0.1:${hostPort}/api/dev/login?next=%2F`,
      async (response) => response.status >= 300 && response.status < 400
    );

    globalThis.console.log("Docker smoke test passed.");
  } catch (error) {
    throw new Error(formatDockerError(error));
  } finally {
    if (composeStarted) {
      await runCommand("docker", ["compose", "down", "-v"]).catch((error) => {
        globalThis.console.error("Failed to tear down docker compose stack:", error);
      });
    }
  }
}

await main();
