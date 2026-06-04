import { describe, expect, it } from "vitest";
import { extractInsertId } from "./insertResult";

describe("extractInsertId", () => {
  it.each([
    [{ insertId: 123 }, 123],
    [[{ insertId: 123 }], 123],
    [[[{ insertId: 123 }]], 123],
    [{ insertId: "123" }, 123],
    [[{}, { insertId: 123 }], 123],
    [{ insertId: 0 }, 0],
    [{}, 0],
    [null, 0],
    [undefined, 0],
  ])("extracts insert id from %j", (insertResult, expected) => {
    expect(extractInsertId(insertResult)).toBe(expected);
  });
});
