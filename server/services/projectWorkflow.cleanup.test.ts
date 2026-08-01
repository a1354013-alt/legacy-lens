import { afterEach, describe, expect, it, vi } from "vitest";

const dbState = vi.hoisted(() => ({
  rows: [] as Array<{
    id: number;
    type: "import_zip";
    status: "queued" | "running";
    payloadJson: string | null;
  }>,
  error: null as Error | null,
  hasDb: true,
}));

vi.mock("../db", () => ({
  getDb: vi.fn(async () => {
    if (!dbState.hasDb) {
      return null;
    }

    return {
      select() {
        return {
          from() {
            return {
              where: async () => {
                if (dbState.error) {
                  throw dbState.error;
                }

                return dbState.rows;
              },
            };
          },
        };
      },
    };
  }),
}));

describe("getActiveImportZipTempFilePaths", () => {
  afterEach(() => {
    dbState.rows = [];
    dbState.error = null;
    dbState.hasDb = true;
    vi.resetModules();
  });

  it("returns protected temp ZIP paths for queued and running import jobs", async () => {
    dbState.rows = [
      {
        id: 1,
        type: "import_zip",
        status: "queued",
        payloadJson: JSON.stringify({
          type: "import_zip",
          tempFilePath: "C:/tmp/queued.zip",
        }),
      },
      {
        id: 2,
        type: "import_zip",
        status: "running",
        payloadJson: JSON.stringify({
          type: "import_zip",
          tempFilePath: "C:/tmp/running.zip",
          originalFileName: "project.zip",
        }),
      },
    ];

    const { getActiveImportZipTempFilePaths } = await import("./projectWorkflow");

    await expect(getActiveImportZipTempFilePaths()).resolves.toEqual(
      new Set(["C:/tmp/queued.zip", "C:/tmp/running.zip"])
    );
  });

  it.each([
    { label: "null payload", payloadJson: null },
    { label: "blank payload", payloadJson: "   " },
  ])("fails closed on $label", async ({ payloadJson }) => {
    dbState.rows = [
      {
        id: 41,
        type: "import_zip",
        status: "queued",
        payloadJson,
      },
    ];

    const { getActiveImportZipTempFilePaths } = await import("./projectWorkflow");

    await expect(getActiveImportZipTempFilePaths()).rejects.toMatchObject({
      code: "UPLOAD_TEMP_CLEANUP_ACTIVE_JOB_PAYLOAD_INVALID",
      message: "Upload temp cleanup aborted because active import job 41 has no payload.",
    });
  });

  it("fails closed on malformed JSON payloads", async () => {
    dbState.rows = [
      {
        id: 42,
        type: "import_zip",
        status: "running",
        payloadJson: "{not-json",
      },
    ];

    const { getActiveImportZipTempFilePaths } = await import("./projectWorkflow");

    await expect(getActiveImportZipTempFilePaths()).rejects.toMatchObject({
      code: "UPLOAD_TEMP_CLEANUP_ACTIVE_JOB_PAYLOAD_INVALID",
      message:
        "Upload temp cleanup aborted because active import job 42 has an invalid payload.",
    });
  });

  it("fails closed when an active import job payload has no temp ZIP path", async () => {
    dbState.rows = [
      {
        id: 43,
        type: "import_zip",
        status: "queued",
        payloadJson: JSON.stringify({
          type: "import_zip",
          zipContent: "UEsDBAoAAAAAA",
        }),
      },
    ];

    const { getActiveImportZipTempFilePaths } = await import("./projectWorkflow");

    await expect(getActiveImportZipTempFilePaths()).rejects.toMatchObject({
      code: "UPLOAD_TEMP_CLEANUP_ACTIVE_JOB_PAYLOAD_INVALID",
      message:
        "Upload temp cleanup aborted because active import job 43 has no temp ZIP path.",
    });
  });

  it("fails closed when the active job lookup rejects", async () => {
    dbState.error = new Error("Query timeout");

    const { getActiveImportZipTempFilePaths } = await import("./projectWorkflow");

    await expect(getActiveImportZipTempFilePaths()).rejects.toMatchObject({
      code: "UPLOAD_TEMP_CLEANUP_ACTIVE_JOB_LOOKUP_FAILED",
      message: "Upload temp cleanup could not load active import jobs.",
      details: "Query timeout",
    });
  });

  it("fails closed when the database is unavailable", async () => {
    dbState.hasDb = false;

    const { getActiveImportZipTempFilePaths } = await import("./projectWorkflow");

    await expect(getActiveImportZipTempFilePaths()).rejects.toMatchObject({
      code: "UPLOAD_TEMP_CLEANUP_ACTIVE_JOB_LOOKUP_FAILED",
      message:
        "Upload temp cleanup could not load active import jobs because the database connection is not configured.",
    });
  });
});
