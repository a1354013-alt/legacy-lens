import { defineConfig } from "drizzle-kit";

const isGenerateCommand = process.argv.some((arg) => arg === "generate");

function resolveConnectionString() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  if (isGenerateCommand) {
    // `drizzle-kit generate` only needs schema metadata. Use a non-routable placeholder
    // instead of silently pointing at a local root database.
    return "mysql://drizzle:drizzle@invalid.local:3306/legacy_lens_generate";
  }

  throw new Error("DATABASE_URL is required for drizzle-kit commands that touch a real database.");
}

const connectionString = resolveConnectionString();

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle",
  dialect: "mysql",
  dbCredentials: {
    url: connectionString,
  },
});
