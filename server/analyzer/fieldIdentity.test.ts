import { describe, expect, it } from "vitest";
import { buildFieldIdentityKey, hasExplicitFieldSchema, hasExplicitTableSchema, normalizeFieldIdentity } from "./fieldIdentity";

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

  it("detects explicit schemas without changing default-schema identity keys", () => {
    expect(hasExplicitTableSchema("erp.Customer")).toBe(true);
    expect(hasExplicitTableSchema("[dbo].[Customer]")).toBe(true);
    expect(hasExplicitTableSchema("Customer")).toBe(false);
    expect(hasExplicitFieldSchema({ table: "", field: "erp.Customer.Id" })).toBe(true);
    expect(hasExplicitFieldSchema({ table: "Customer", field: "Id" })).toBe(false);
    expect(buildFieldIdentityKey({ table: "dbo.Customer", field: "Id" })).toBe(buildFieldIdentityKey({ table: "Customer", field: "Id" }));
  });
});
