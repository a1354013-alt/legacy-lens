import { describe, expect, it } from "vitest";
import { buildChartThemeCss } from "./chart";

describe("buildChartThemeCss", () => {
  it("sanitizes chart ids and config keys before generating css", () => {
    const css = buildChartThemeCss('chart-1"][data-bad="x', {
      'users.total;background:url(javascript:1)': {
        color: "#123456",
      },
    });

    expect(css).toContain('[data-chart="chart-1___data-bad__x"]');
    expect(css).toContain("--color-users_total_background_url_javascript_1_: #123456;");
    expect(css).not.toContain("javascript:1)]");
  });
});
