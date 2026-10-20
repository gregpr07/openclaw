import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { z } from "zod";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import retirementManifest from "./openclaw-schema-retirements.json" with { type: "json" };
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";

type DatabaseOwner = "state" | "agent";
const manifestSchema = z.object({
  retirements: z.array(
    z.object({
      database: z.enum(["state", "agent"]),
      status: z.enum(["planned", "completed"]),
      targetVersion: z.number().int().nonnegative(),
      table: z.string().min(1),
      indexes: z.array(z.string().min(1)),
      note: z.string().optional(),
    }),
  ),
});

function hasSchemaObject(database: DatabaseSync, type: "table" | "index", name: string): boolean {
  return (
    database.prepare("SELECT 1 FROM sqlite_schema WHERE type = ? AND name = ?").get(type, name) !==
    undefined
  );
}

it("keeps the schema retirement ledger aligned with canonical database schemas", () => {
  const { retirements } = manifestSchema.parse(retirementManifest);
  const keys = retirements.map(({ database, table }) => `${database}/${table}`);
  expect(new Set(keys).size, "duplicate database/table retirement").toBe(keys.length);

  const databases = {
    state: {
      currentVersion: OPENCLAW_STATE_SCHEMA_VERSION,
      schemaUrl: new URL("./openclaw-state-schema.sql", import.meta.url),
      database: new DatabaseSync(":memory:"),
    },
    agent: {
      currentVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
      schemaUrl: new URL("./openclaw-agent-schema.sql", import.meta.url),
      database: new DatabaseSync(":memory:"),
    },
  } satisfies Record<
    DatabaseOwner,
    { currentVersion: number; schemaUrl: URL; database: DatabaseSync }
  >;

  try {
    for (const database of Object.values(databases)) {
      database.database.exec(readFileSync(database.schemaUrl, "utf8"));
    }

    for (const retirement of retirements) {
      const { currentVersion, database } = databases[retirement.database];
      const shouldExist = retirement.status === "planned";

      if (shouldExist) {
        expect(retirement.targetVersion).toBe(currentVersion + 1);
      } else {
        expect(retirement.targetVersion).toBeLessThanOrEqual(currentVersion);
      }

      expect(hasSchemaObject(database, "table", retirement.table)).toBe(shouldExist);
      for (const index of retirement.indexes) {
        expect(hasSchemaObject(database, "index", index)).toBe(shouldExist);
      }
    }
  } finally {
    for (const database of Object.values(databases)) {
      database.database.close();
    }
  }
});
