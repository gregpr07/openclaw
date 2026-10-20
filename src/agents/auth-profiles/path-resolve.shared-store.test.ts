import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { resolveAuthStatePathForDisplay, resolveAuthStorePathForDisplay } from "./paths.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import { hasLocalAuthProfileStoreSource } from "./source-check.js";
import {
  inspectPersistedAuthProfileStoreRaw,
  writePersistedAuthProfileStoreRaw,
} from "./sqlite.js";
import type { AuthProfileStore } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const persistedStore = {
  version: 1,
  profiles: {
    "openai:test": { type: "api_key", provider: "openai", key: "test-key" },
  },
} satisfies AuthProfileStore;

function makeStateEnv(): NodeJS.ProcessEnv {
  const stateDir = tempDirs.make("openclaw-shared-auth-store-");
  return { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: undefined };
}

let env: NodeJS.ProcessEnv;
let paths: typeof import("./path-resolve.js");
beforeEach(async () => {
  vi.resetModules();
  env = makeStateEnv();
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  vi.stubEnv("OPENCLAW_AGENT_DIR", undefined);
  paths = await import("./path-resolve.js");
});

afterEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  vi.unstubAllEnvs();
  for (const stateDir of tempDirs.dirs) {
    await cleanupSessionStateForTest({ stateDir });
  }
  closeOpenClawStateDatabaseForTest();
});

it("keeps the absent ownership record pinned to the shipped legacy-main path", async () => {
  const { resolveSharedMainAuthAgentDir } = await import("./shared-main-dir.js");
  const legacyDir = resolveSharedMainAuthAgentDir(env);
  const expectedPath = path.join(legacyDir, "openclaw-agent.sqlite");

  await paths.prepareSharedAuthStoreOwnership(env);
  expect(paths.resolveSharedAuthStorePath(env)).toBe(expectedPath);

  writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env });
  const aliasEnv = {
    ...env,
    OPENCLAW_STATE_DIR: path.join(env.OPENCLAW_STATE_DIR ?? "", "."),
  };

  expect(paths.resolveSharedAuthStorePath(aliasEnv)).toBe(expectedPath);

  writePersistedAuthProfileStoreRaw(persistedStore, legacyDir);
  expect(resolveAuthStorePathForDisplay(legacyDir)).toBe(expectedPath);
  expect(resolveAuthStatePathForDisplay(legacyDir)).toBe(expectedPath);
  expect(inspectPersistedAuthProfileStoreRaw(legacyDir)).toMatchObject({
    status: "readable",
    raw: persistedStore,
  });
  expect(existsSync(expectedPath)).toBe(true);
});

it("ignores runtime-only external profiles when displaying store ownership", async () => {
  writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env });
  const agentDir = path.join(env.OPENCLAW_STATE_DIR ?? "", "agents", "helper", "agent");

  writePersistedAuthProfileStoreRaw(persistedStore);
  setRuntimeAuthProfileStoreSnapshot(
    {
      ...persistedStore,
      runtimeExternalProfileIds: ["openai:test"],
    },
    agentDir,
  );

  expect(hasLocalAuthProfileStoreSource(agentDir)).toBe(true);
  expect(inspectPersistedAuthProfileStoreRaw(agentDir).status).toBe("missing");
  expect(resolveAuthStorePathForDisplay(agentDir)).toBe(resolveOpenClawStateSqlitePath(env));
  expect(resolveAuthStatePathForDisplay(agentDir)).toBe(resolveOpenClawStateSqlitePath(env));
});

it("caches ownership independently for each canonical state root", async () => {
  const firstEnv = env;
  const secondEnv = makeStateEnv();
  await paths.prepareSharedAuthStoreOwnership(firstEnv);
  expect(paths.resolveSharedAuthStoreOwnership(firstEnv)).toEqual({ location: "legacy-main" });

  writeConfigMachineState(
    "auth.sharedStore",
    { location: "legacy-main", extra: true },
    { env: secondEnv },
  );

  await expect(paths.prepareSharedAuthStoreOwnership(secondEnv)).rejects.toThrow(
    expect.objectContaining({
      name: "InvalidSharedAuthStoreOwnershipError",
      code: "INVALID_SHARED_AUTH_STORE_OWNERSHIP",
      action: "openclaw doctor --fix",
    }),
  );
  expect(paths.resolveSharedAuthStoreOwnership(firstEnv)).toEqual({ location: "legacy-main" });
});

it("requires preparation and follows committed ownership without another database read", async () => {
  expect(() => paths.resolveSharedAuthStoreOwnership(env)).toThrow("ownership is not prepared");
  await paths.prepareSharedAuthStoreOwnership(env);
  paths.noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, env);
  expect(paths.resolveSharedAuthStorePath(env)).toBe(resolveOpenClawStateSqlitePath(env));
  expect(await paths.prepareSharedAuthStoreOwnership(env)).toEqual({ location: "state-db" });
  vi.resetModules();
  const sdkPaths = await import("./path-resolve.js");
  expect(sdkPaths.resolveSharedAuthStorePath(env)).toBe(resolveOpenClawStateSqlitePath(env));
});
