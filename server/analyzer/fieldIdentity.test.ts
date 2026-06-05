import { describe, expect, it } from "vitest";
import { buildFieldIdentityKey, normalizeFieldIdentity } from "./fieldIdentity";

describe("field identity normalization", () => {
  it("canonicalizes quoted, cased, and default-schema SQL field names", () => {
    const inputs = [
      { table: "Customer", field: "Id" },
      { table: "customer", field: "id" },
      { table: "dbo.Customer", field: "Id" },
      { table: "[Customer]", field: "[Id]" },
      { table: "`customer`", field: "`id`" },
      { table: "", field: "`customer`.`id`" },
    ];

    const keys = inputs.map((input) => buildFieldIdentityKey(input));

    expect(new Set(keys).size).toBe(1);
    expect(normalizeFieldIdentity({ table: "[Customer]", field: "[Id]" })).toMatchObject({
      schema: null,
      table: "customer",
      field: "id",
      originalTable: "Customer",
      originalField: "Id",
      originalName: "Customer.Id",
    });
  });

  it("keeps non-default schemas distinct while normalizing identifier wrappers", () => {
    expect(buildFieldIdentityKey({ table: "erp.Customer", field: "Id" })).toBe(
      buildFieldIdentityKey({ table: "[erp].[customer]", field: "`id`" })
    );
    expect(buildFieldIdentityKey({ table: "erp.Customer", field: "Id" })).not.toBe(buildFieldIdentityKey({ table: "Customer", field: "Id" }));
  });
});
