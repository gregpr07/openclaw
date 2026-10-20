import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  readSqliteCleanCloseSeal,
  writeSqliteCleanCloseSeal,
} from "../infra/sqlite-clean-close-seal.js";

const inputs = vi.hoisted(() => ({
  version: "2026.10.1",
  commit: "first",
  build: "first",
  agent: "CREATE TABLE session_nodes (session_key TEXT);",
  state: "CREATE TABLE user_profiles (id TEXT);",
  agentVersion: 31,
  stateVersion: 28,
  storageIdentity: { sourceId: "source", compileOptions: "COMPILER=clang-21,ENABLE_FTS5" } as
    | { sourceId: string; compileOptions: string }
    | undefined,
}));
vi.mock("../infra/sqlite-native-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/sqlite-native-runtime.js")>();
  return {
    ...actual,
    captureSqliteNativeRuntimeAdmission: () => ({
      ...actual.captureSqliteNativeRuntimeAdmission(),
      version: "3.53.4",
      runtime: { nodeVersion: "26.0.0" },
      storageIdentity: inputs.storageIdentity,
    }),
  };
});
vi.mock("./openclaw-schema-versions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-schema-versions.js")>()),
  get OPENCLAW_AGENT_SCHEMA_VERSION() {
    return inputs.agentVersion;
  },
  get OPENCLAW_STATE_SCHEMA_VERSION() {
    return inputs.stateVersion;
  },
}));
vi.mock("./openclaw-agent-schema.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-agent-schema.js")>()),
  get OPENCLAW_AGENT_SCHEMA_SQL() {
    return inputs.agent;
  },
}));
vi.mock("./openclaw-state-schema.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-state-schema.js")>()),
  get OPENCLAW_STATE_SCHEMA_SQL() {
    return inputs.state;
  },
}));
vi.mock("../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version.js")>()),
  get VERSION() {
    return inputs.version;
  },
  resolveRuntimeServiceCommit: () => inputs.commit,
  resolveRuntimeServiceBuildId: () => inputs.build,
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  inputs.version = "2026.10.1";
  inputs.agent = "CREATE TABLE session_nodes (session_key TEXT);";
  inputs.state = "CREATE TABLE user_profiles (id TEXT);";
  inputs.agentVersion = 31;
  inputs.stateVersion = 28;
  inputs.storageIdentity = { sourceId: "source", compileOptions: "COMPILER=clang-21,ENABLE_FTS5" };
});

async function loadSchema() {
  vi.resetModules();
  return (await import("./openclaw-database-seal-schema.js")).sqliteDatabaseSealSchemaFor;
}

it.each([
  ["agent", "sql"],
  ["state", "sql"],
  ["agent", "version"],
  ["state", "version"],
] as const)("invalidates %s proof only for its own %s change", async (kind, change) => {
  let schema = await loadSchema();
  const before = schema(kind);
  const unknown = schema("other");
  const mutate = async (owner: "agent" | "state") => {
    if (change === "version") {
      inputs[owner === "agent" ? "agentVersion" : "stateVersion"]++;
    } else {
      inputs[owner] += "\nCREATE TABLE changed (id TEXT);";
      schema = await loadSchema();
    }
  };
  await mutate(kind === "agent" ? "state" : "agent");
  expect(schema(kind)).toEqual(before);
  expect(schema("other")).not.toEqual(unknown);
  await mutate(kind);
  expect(schema(kind)).not.toEqual(before);
});

it("reuses a clean seal across builds and app-version changes", async () => {
  const pathname = path.join(tempDirs.make("seal-build-identity-"), "database.sqlite");
  fs.writeFileSync(pathname, "unchanged synthetic database");
  const file = fs.statSync(pathname, { bigint: true });
  const proof = { verifiedAt: Date.now(), facts: "validated facts" };
  const schemaIdentity = (await loadSchema())("agent")!.schemaIdentity;
  expect(writeSqliteCleanCloseSeal(pathname, schemaIdentity, file, proof)).toBe(true);
  expect(readSqliteCleanCloseSeal(pathname, file)).toEqual({ ...proof, schemaIdentity });

  inputs.commit = "second";
  inputs.build = "second";
  const rebuilt = await loadSchema();
  expect(rebuilt("agent")?.schemaIdentity).toBe(schemaIdentity);
  expect(readSqliteCleanCloseSeal(pathname, file)?.schemaIdentity).toBe(
    rebuilt("agent")?.schemaIdentity,
  );

  inputs.version = "2026.10.2";
  const upgraded = await loadSchema();
  expect(readSqliteCleanCloseSeal(pathname, file)?.schemaIdentity).toBe(
    upgraded("agent")?.schemaIdentity,
  );
});

it("invalidates proof for a different or unknown SQLite storage stack", async () => {
  const schema = await loadSchema();
  const before = schema("agent");
  inputs.storageIdentity = { sourceId: "new-source", compileOptions: "ENABLE_FTS5" };
  expect(schema("agent")).not.toEqual(before);
  inputs.storageIdentity = undefined;
  expect(schema("agent")).toBeUndefined();
});

it("compares feature options without compiler metadata and preserves the legacy digest", async () => {
  const { sqliteDatabaseSealSchemaFor } = await import("./openclaw-database-seal-schema.js");
  const before = sqliteDatabaseSealSchemaFor("agent")!;
  // Persisted by the combined-hash implementation with this synthetic native tuple.
  expect(before.schemaIdentity).toBe(
    "9f93c4304456e20100a54354c11099c82974e1ff9711eeb07f6335302d41b4df",
  );
  inputs.storageIdentity = { sourceId: "source", compileOptions: "COMPILER=gcc-14,ENABLE_FTS5" };
  const rebuilt = sqliteDatabaseSealSchemaFor("agent")!;
  expect(rebuilt.identity).toEqual(before.identity);
  expect(rebuilt.identity.sqlite.compileOptions).toBe("ENABLE_FTS5");
  expect(rebuilt.schemaIdentity).not.toBe(before.schemaIdentity);
  inputs.storageIdentity.compileOptions += ",OMIT_JSON";
  expect(sqliteDatabaseSealSchemaFor("agent")!.identity.sqlite.compileOptions).toBe(
    "ENABLE_FTS5,OMIT_JSON",
  );
});
