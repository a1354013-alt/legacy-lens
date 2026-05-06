import { describe, expect, it } from "vitest";
import { getErrorBoundaryContent } from "./errorBoundaryContent";

describe("getErrorBoundaryContent", () => {
  const error = new Error("boom");

  it("includes stack details in development", () => {
    const content = getErrorBoundaryContent(error, true);

    expect(content.title).toBe("Something went wrong.");
    expect(content.description).toContain("stack trace");
    expect(content.stack).toContain("boom");
  });

  it("hides stack details in production", () => {
    const content = getErrorBoundaryContent(error, false);

    expect(content.description).toBe("Please reload the page or try again later.");
    expect(content.stack).toBeNull();
  });
});
