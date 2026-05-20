import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Drizzle migration safety", () => {
  it("drops and recreates the targetSymbolId foreign key before making the column nullable", () => {
    const migration = readFileSync(join(process.cwd(), "drizzle", "0006_opposite_ultimates.sql"), "utf8");

    const dropIndex = migration.indexOf("DROP FOREIGN KEY `dependencies_targetSymbolId_symbols_id_fk`");
    const modifyIndex = migration.indexOf("MODIFY COLUMN `targetSymbolId` int");
    const addIndex = migration.indexOf("ADD CONSTRAINT `dependencies_targetSymbolId_symbols_id_fk` FOREIGN KEY (`targetSymbolId`)");

    expect(dropIndex).toBeGreaterThanOrEqual(0);
    expect(modifyIndex).toBeGreaterThan(dropIndex);
    expect(addIndex).toBeGreaterThan(modifyIndex);
  });
});
