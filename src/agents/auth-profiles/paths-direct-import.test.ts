import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveLegacyAuthProfilesPath as resolveAuthStorePath } from "../../commands/doctor-auth-legacy-paths.js";
import { AuthStorage } from "../../plugin-sdk/agent-sessions.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { withEnv } from "../../test-utils/env.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createApiKeyCredential } from "./credential-fixtures.test-support.js";
import { resolveSharedAuthStorePath } from "./path-resolve.js";
import { withPreparedAuthStorePathForDisplay, resolveAuthStorePathForDisplay } from "./paths.js";
import * as sqliteRead from "./sqlite-read.js";
import { closeAuthProfileReadPool } from "./sqlite.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("auth profile path helpers (direct-import coverage attribution)", () => {
  let stateDir = "";

  beforeEach(() => {
    stateDir = tempDirs.make("openclaw-path-direct-");
  });

  it("honors OPENCLAW_AGENT_DIR in both no-argument auth path implementations", () => {
    const relocatedAgentDir = path.join(stateDir, "relocated-main-agent");
    withEnv({ OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: relocatedAgentDir }, () => {
      expect(path.dirname(resolveAuthStorePath())).toBe(relocatedAgentDir);
      expect(resolveAuthStorePathForDisplay()).toBe(
        path.join(relocatedAgentDir, "openclaw-agent.sqlite"),
      );
    });
  });

  it("falls back to the shared owner for an agent dir that has no local store", () => {
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      // An unexpandable tilde path must fall back to the shared owner.
      const resolved = resolveAuthStorePathForDisplay("~fake-openclaw-no-expand");
      expect(resolved).toBe(resolveSharedAuthStorePath());
      expect(resolved.startsWith("~")).toBe(false);
    });
  });
});

it.each(["shared", "missing", "missing-row", "empty", "present", "unreadable"] as const)(
  "prepares the canonical display source without host SQL (%s)",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const agentId = "display";
      const agentDir = state.agentDir(agentId);
      const databasePath = path.join(agentDir, "openclaw-agent.sqlite");
      if (mode === "missing-row") {
        openOpenClawAgentDatabase({ agentId, env: state.env });
      } else if (mode !== "shared" && mode !== "missing") {
        const profiles =
          mode === "empty"
            ? {}
            : {
                "fixture:display": createApiKeyCredential("fixture", "synthetic-display"),
              };
        await state.writeAuthProfiles({ version: 1, profiles }, agentId);
      }
      await closeOpenClawAgentDatabasesAsync(state.stateDir);
      closeAuthProfileReadPool();
      if (mode === "unreadable") {
        fs.writeFileSync(databasePath, "not a SQLite database");
      }
      const sql = observeMainThreadSql();
      sql.calibrate();
      let displayPath: string;
      try {
        displayPath = await AuthStorage.resolvePathForDisplayAsync(
          mode === "shared" ? undefined : agentDir,
          state.env,
        );
        sql.expectIdle();
      } finally {
        sql.restore();
      }
      expect(displayPath).toBe(
        mode === "shared" || mode === "missing" || mode === "missing-row"
          ? resolveSharedAuthStorePath(state.env)
          : databasePath,
      );
      if (mode === "missing") {
        expect(fs.existsSync(databasePath)).toBe(false);
      }
    });
  },
);

it("does not invoke a withdrawn model build after its display worker read", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await state.writeAuthProfiles({ version: 1, profiles: {} });
    await closeOpenClawAgentDatabasesAsync(state.stateDir);
    closeAuthProfileReadPool();
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const original = sqliteRead.prepareAgentAuthProfileRowsRead;
    const held = vi
      .spyOn(sqliteRead, "prepareAgentAuthProfileRowsRead")
      .mockImplementation((options) => {
        const reader = original(options);
        return {
          ...reader,
          async read() {
            const rows = await reader.read();
            entered.resolve();
            await resume.promise;
            return rows;
          },
        };
      });
    const context = captureOpenClawStateWorkerContext({ env: state.env });
    const withdrawn = new Error("Model build authority was withdrawn");
    let current = true;
    const consume = vi.fn((pathname: string) => pathname);
    const reading = withPreparedAuthStorePathForDisplay(
      state.agentDir(),
      state.env,
      () => {
        context.admission.assertCurrent();
        if (!current) {
          throw withdrawn;
        }
      },
      consume,
    );
    const rejected = expect(reading).rejects.toBe(withdrawn);
    try {
      await Promise.race([
        entered.promise,
        rejected.then(() => {
          throw new Error("Display preparation settled before its worker read gate");
        }),
      ]);
      current = false;
      resume.resolve();
      await rejected;
      expect(consume).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await reading.catch(() => {});
      held.mockRestore();
    }
  });
});
