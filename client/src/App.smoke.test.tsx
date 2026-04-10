import React from "react";
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import App from "./App";

describe("App", () => {
  it("renders the router shell without crashing", () => {
    const html = renderToString(<App />);
    expect(html).toContain("Loading");
  });
});
