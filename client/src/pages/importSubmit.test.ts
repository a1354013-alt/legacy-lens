import { describe, expect, it, vi } from "vitest";
import {
  acquireSubmitLock,
  buildImportProjectFormData,
  invalidateProjectsListAfterImportSuccess,
  releaseSubmitLock,
  submitImportProject,
} from "./importSubmit";

describe("import submit helpers", () => {
  it("hard-locks repeated submit attempts until released", () => {
    const lock = { current: false };

    expect(acquireSubmitLock(lock)).toBe(true);
    expect(acquireSubmitLock(lock)).toBe(false);

    releaseSubmitLock(lock);

    expect(acquireSubmitLock(lock)).toBe(true);
  });

  it("keeps the selected Delphi language in the submit payload", () => {
    const formData = buildImportProjectFormData({
      projectName: " Delphi demo ",
      description: "",
      focusLanguage: "delphi",
      sourceType: "git",
      uploadedFile: null,
      gitUrl: " https://example.com/legacy.git ",
    });

    expect(formData.get("name")).toBe("Delphi demo");
    expect(formData.get("focusLanguage")).toBe("delphi");
    expect(formData.get("sourceType")).toBe("git");
    expect(formData.get("gitUrl")).toBe("https://example.com/legacy.git");
  });

  it("posts to the atomic import API and returns the queued job only on success", async () => {
    const fetchImport = vi.fn(async () => Response.json({ projectId: 7, jobId: 9, jobType: "import_zip" }));

    await expect(
      submitImportProject(
        {
          projectName: "demo",
          description: "",
          focusLanguage: "go",
          sourceType: "upload",
          uploadedFile: new File(["zip"], "demo.zip", { type: "application/zip" }),
          gitUrl: "",
        },
        async () => "failed",
        fetchImport
      )
    ).resolves.toEqual({ projectId: 7, jobId: 9, jobType: "import_zip" });

    expect(fetchImport).toHaveBeenCalledTimes(1);
    expect(fetchImport).toHaveBeenCalledWith(
      "/api/projects/import",
      expect.objectContaining({ method: "POST", credentials: "include", body: expect.any(FormData) })
    );
  });

  it("rejects invalid import API success payloads", async () => {
    const fetchImport = vi.fn(async () => Response.json({ projectId: 7, jobType: "import_zip" }));

    await expect(
      submitImportProject(
        {
          projectName: "demo",
          description: "",
          focusLanguage: "go",
          sourceType: "upload",
          uploadedFile: new File(["zip"], "demo.zip", { type: "application/zip" }),
          gitUrl: "",
        },
        async () => "failed",
        fetchImport
      )
    ).rejects.toThrow();
  });

  it("does not invalidate the project list on failed import", async () => {
    const invalidate = vi.fn();
    const fetchImport = vi.fn(async () => new Response("nope", { status: 500 }));

    await expect(
      submitImportProject(
        {
          projectName: "demo",
          description: "",
          focusLanguage: "go",
          sourceType: "git",
          uploadedFile: null,
          gitUrl: "https://example.com/repo.git",
        },
        async () => "import failed",
        fetchImport
      )
    ).rejects.toThrow("import failed");

    expect(invalidate).not.toHaveBeenCalled();
  });

  it("invalidates the project list only from the success path", async () => {
    const invalidate = vi.fn();

    await invalidateProjectsListAfterImportSuccess({ projects: { list: { invalidate } } });

    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
