import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { patchSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import type { ResolvedSqliteScope } from "./session-accessor.sqlite-scope.js";
import type { patchSessionEntryInWorker } from "./session-entry-patch.js";
import type { InternalSessionEntry } from "./types.js";

const boundary = vi.hoisted(() => ({
  ready: Promise.resolve(),
  queue: vi.fn(async (_scope: ResolvedSqliteScope, run: () => Promise<unknown>) => {
    await boundary.ready;
    return await run();
  }),
  worker: vi.fn<typeof patchSessionEntryInWorker>(async (params) => {
    params.assertCurrent();
    const prepared = await params.prepare([]);
    params.assertCurrent();
    return { entry: prepared?.next ?? null, wrote: prepared?.next !== undefined };
  }),
  maintain: vi.fn(),
  history: vi.fn(),
}));

// This suite exercises the capture producer without opening a database or scheduling maintenance.
vi.mock("node:sqlite", () => ({
  DatabaseSync: function DatabaseSync() {
    throw new Error("native SQLite is outside this environment-capture test");
  },
}));
vi.mock("../../auto-reply/internal-turn-source.js", () => ({}));
vi.mock("../../state/openclaw-agent-db-identity.js", () => ({}));
vi.mock("../../state/openclaw-agent-db-readonly-scope.js", () => ({}));
vi.mock("../../state/openclaw-agent-db-readonly.js", () => ({}));
vi.mock("../../state/openclaw-agent-db-transaction.js", () => ({
  runOpenClawAgentWriteWithYieldingAdmission: () => {
    throw new Error("native entry writes are outside this worker environment-capture test");
  },
}));
// mock-isolation: Synthetic platform paths must never acquire real database owners.
vi.mock("../../state/openclaw-agent-db.js", () => ({
  getOpenClawAgentDatabaseIfOpen: () => undefined,
  isIncognitoOpenClawAgentSqlitePath: () => false,
  resolveOpenClawAgentSqlitePath: (options: OpenClawAgentDatabaseOptions) =>
    options.path ?? `${options.env?.OPENCLAW_STATE_DIR}/${options.agentId}.sqlite`,
}));
vi.mock("../../state/openclaw-agent-execution.js", () => ({
  captureOpenClawAgentDatabaseExecution: () => ({ release: async () => {} }),
  supportsOpenClawAgentDatabaseExecution: () => true,
}));
vi.mock("../future-version-guard.js", () => ({
  ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV: "OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS",
}));
vi.mock("../paths.js", async () => ({
  resolveStateDir: (await import("../state-dir.js")).resolveStateDir,
}));
vi.mock("./metadata.js", () => ({}));
vi.mock("./session-accessor.sqlite-entry-cache.js", () => ({}));
vi.mock("./session-accessor.sqlite-entry-store.js", () => ({
  readSessionEntrySelectionSnapshot: () => [],
  writeSessionEntry: (_database: unknown, _key: string, entry: InternalSessionEntry) => entry,
}));
vi.mock("./session-accessor.sqlite-exact-read.js", () => ({}));
vi.mock("./session-accessor.sqlite-history.js", () => ({}));
vi.mock("./session-accessor.sqlite-identity.js", () => ({
  prepareSessionIdentityPublication: () => () => {},
}));
vi.mock("./session-accessor.sqlite-initial-entry.js", () => ({}));
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite: boundary.maintain,
}));
vi.mock("./session-accessor.sqlite-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-accessor.sqlite-scope.js")>()),
  resolveSqliteTranscriptArchiveDirectory: () => "/synthetic/archive",
  runExclusiveSqliteSessionWrite: boundary.queue,
}));
vi.mock("./session-accessor.sqlite-status.js", () => ({}));
vi.mock("./session-canonical-key.js", () => ({ assertCanonicalSessionKeyWrite() {} }));
// mock-isolation: Observe captured worker inputs without starting persistence on synthetic paths.
vi.mock("./session-entry-patch.js", () => ({ patchSessionEntryInWorker: boundary.worker }));
vi.mock("./session-history-eviction.js", () => ({
  kickSessionHistoryDiskBudgetMaintenance: boundary.history,
}));
vi.mock("./session-store-path.js", () => ({
  resolveSessionStorePathForScope: () => "/synthetic/store",
}));

afterEach(() => {
  boundary.ready = Promise.resolve();
  vi.clearAllMocks();
});

it.each([
  ["win32", "plain", "OpenClaw_State_Dir", "OpenClaw_Config_Readonly"],
  ["win32", "precloned", "OpenClaw_State_Dir", "OpenClaw_Config_Readonly"],
  ["linux", "plain", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_READONLY"],
  ["linux", "plain", "OpenClaw_State_Dir", "OpenClaw_Config_Readonly"],
] as const)(
  "retains %s %s session-write environment with %s",
  async (platform, input, key, readonlyKey) => {
    await withMockedPlatform(platform, async () => {
      const root = path.resolve("/synthetic/captured");
      const home = path.resolve("/synthetic/home");
      const rawEnv = {
        [key]: root,
        [readonlyKey]: "1",
        HOME: home,
        OPENCLAW_TEST_FAST: "1",
      };
      const env = input === "precloned" ? cloneEnvWithPlatformSemantics(rawEnv) : rawEnv;
      const scope = { agentId: "main", sessionKey: "agent:main:capture", env };
      const caseSensitiveMiss = platform === "linux" && key !== "OPENCLAW_STATE_DIR";
      const expectedRoot = caseSensitiveMiss ? path.join(home, ".openclaw") : root;
      const expectedReadonly = caseSensitiveMiss ? undefined : "1";
      const ready = createDeferredCore();
      boundary.ready = ready.promise;
      const update = vi.fn((entry: InternalSessionEntry) => ({ ...entry, label: "captured" }));
      const write = patchSessionEntryCore(scope, update, {
        fallbackEntry: { sessionId: "session", updatedAt: 1 },
        replaceEntry: true,
      });
      try {
        const queued = boundary.queue.mock.calls[0]?.[0];
        expect(queued?.path).toBe(`${expectedRoot}/main.sqlite`);
        expect(queued?.env?.OPENCLAW_STATE_DIR).toBe(expectedRoot);
        expect(queued?.env?.OPENCLAW_CONFIG_READONLY).toBe(expectedReadonly);
        expect(env[key]).toBe(root);
        expect(Object.keys(env)).toEqual(Object.keys(rawEnv));
        expect(update).not.toHaveBeenCalled();
        expect(boundary.worker).not.toHaveBeenCalled();
        env[key] = "/synthetic/changed";
        env[readonlyKey] = "0";
        scope.env = { OPENCLAW_STATE_DIR: "/synthetic/replaced" };
        ready.resolve();
        await expect(write).resolves.toMatchObject({ sessionId: "session", label: "captured" });
        expect(boundary.worker).toHaveBeenCalledOnce();
        const committed = boundary.worker.mock.calls[0]?.[0].database;
        expect(committed?.path).toBe(`${expectedRoot}/main.sqlite`);
        expect(committed?.env?.OPENCLAW_STATE_DIR).toBe(expectedRoot);
        expect(committed?.env?.OPENCLAW_CONFIG_READONLY).toBe(expectedReadonly);
        expect(committed?.env).toBe(queued?.env);
        expect(boundary.maintain.mock.calls[0]?.[0].scope.env).toBe(queued?.env);
        expect(boundary.history.mock.calls[0]?.[0].env).toBe(queued?.env);
        expect(update).toHaveBeenCalledOnce();
      } finally {
        ready.resolve();
        await write.catch(() => undefined);
      }
    });
  },
);
