import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { inspectAcpSessionClaimsForDoctor } from "../acp/runtime/session-meta-doctor.js";
import {
  buildAcpDatabaseSessionKey,
  selectAcpSessionRow,
} from "../acp/runtime/session-meta-keys.js";
import { writeAcpSessionMetaForMigration } from "../acp/runtime/session-meta.js";
import { noteSessionTranscriptHealth } from "../commands/doctor-session-transcripts.js";
import { loadSessionTranscriptEvents as loadTranscriptEvents } from "../config/sessions/session-transcript-events.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { migrateLegacyAcpSessionMetadata } from "./state-migrations.session-store.js";

function metadata(runtimeSessionName: string, lastActivityAt = 100): SessionAcpMeta {
  return {
    backend: "acpx",
    agent: "fixture",
    runtimeSessionName,
    mode: "persistent",
    state: "idle",
    lastActivityAt,
  };
}

function migrate(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  pluginSessionStoreAgentIds: string[] = [],
) {
  return migrateLegacyAcpSessionMetadata({
    cfg,
    env,
    now: () => 300,
    pluginSessionStoreAgentIds,
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
  });
}

it("imports plugin-declared ACP owners outside the canonical roster", async () => {
  await withOpenClawTestState({ label: "acp-plugin-owner-import" }, async (state) => {
    const agentId = "voice";
    const sessionKey = "agent:voice:acp:plugin-session";
    const sessionId = "plugin-session";
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      session: { store: path.join(state.stateDir, "plugin-sessions", "{agentId}.json") },
      plugins: { enabled: false },
    };
    await state.writeConfig(cfg);
    const meta = metadata("plugin-owner-runtime");
    // A custom store cannot be found by scanning the conventional agents directory.
    const storePath = await state.writeJson("plugin-sessions/voice.json", {
      [sessionKey]: { sessionId, updatedAt: 100, acp: meta },
    });

    const result = await migrate(cfg, state.env, [agentId]);

    expect(result).toEqual({
      changes: ["Migrated 1 ACP session metadata row → shared SQLite state"],
      warnings: [],
    });
    const database = openOpenClawStateDatabase({ env: state.env });
    expect(
      selectAcpSessionRow(database.db, buildAcpDatabaseSessionKey(sessionKey, agentId)),
    ).toMatchObject({ session_id: sessionId, runtime_session_name: meta.runtimeSessionName });
    expect(JSON.parse(fs.readFileSync(storePath, "utf8"))[sessionKey]).not.toHaveProperty("acp");
    expect(cfg.agents?.entries).toEqual({ main: {} });
  });
});

it.each(["none", "matching", "different", "unbound"] as const)(
  "imports configured ACP binding ownership before session repair (current metadata: %s)",
  async (currentBinding) => {
    await withOpenClawTestState({ label: "acp-binding-owner-import" }, async (state) => {
      const agentId = "ops";
      // v2026.5.28 stored configured binding metadata in sessions.json. These
      // identities deliberately do not qualify for the later free-ACP alias repair.
      const sessionKey = "agent:ops:acp:binding:discord:default:af00112233445566";
      const sessionId = "configured-binding-session";
      const cfg: OpenClawConfig = {
        agents: { entries: { [agentId]: { workspace: state.workspaceDir } } },
        plugins: { enabled: false },
      };
      await state.writeConfig(cfg);
      const meta = metadata("legacy-binding-runtime");
      const currentMeta = metadata("current-binding-runtime", 200);
      const storePath = await state.writeJson(`agents/${agentId}/sessions/sessions.json`, {
        [sessionKey]: { sessionId, updatedAt: 100, acp: meta },
      });
      const message = {
        type: "message",
        id: "history-message",
        parentId: null,
        message: { role: "user", content: "Keep this binding's history." },
      };
      await state.writeText(
        `agents/${agentId}/sessions/${sessionId}.jsonl`,
        [{ type: "session", version: 3, id: sessionId }, message]
          .map((event) => JSON.stringify(event))
          .join("\n") + "\n",
      );
      const databaseKey = buildAcpDatabaseSessionKey(sessionKey, agentId);
      const row = (key = databaseKey) =>
        selectAcpSessionRow(openOpenClawStateDatabase({ env: state.env }).db, key);
      if (currentBinding !== "none") {
        writeAcpSessionMetaForMigration({
          sessionKey: databaseKey,
          sessionId:
            currentBinding === "unbound"
              ? undefined
              : currentBinding === "different"
                ? "different-binding-session"
                : sessionId,
          meta: currentMeta,
          env: state.env,
          now: () => 200,
        });
      }

      const run = () => migrate(cfg, state.env);
      if (currentBinding === "different" || currentBinding === "unbound") {
        const original = fs.readFileSync(storePath);
        const current = row();
        await expect(run()).rejects.toThrow(
          "Canonical ACP metadata has a conflicting session binding",
        );
        expect(fs.readFileSync(storePath)).toEqual(original);
        expect(row()).toEqual(current);
        expect(row(sessionKey)).toBeUndefined();
        return;
      }
      expect((await run()).warnings).toEqual([]);
      // Preserve Doctor's real order: metadata extraction precedes session import
      // and canonical-row repair; only then may a plugin inspect owner claims.
      await noteSessionTranscriptHealth({
        cfg,
        env: state.env,
        shouldRepair: true,
        postSessionPluginMigrationPlanBound: true,
      });
      const claims = await inspectAcpSessionClaimsForDoctor({
        config: cfg,
        env: state.env,
        pluginId: "acpx",
      });
      expect(claims.incomplete).toEqual([]);
      expect(claims.claims).toEqual([
        expect.objectContaining({
          agentId,
          sessionKey,
          binding: expect.objectContaining({ sessionId }),
          meta: currentBinding === "matching" ? currentMeta : meta,
        }),
      ]);
      expect(row()?.runtime_session_name).toBe(
        currentBinding === "matching" ? currentMeta.runtimeSessionName : meta.runtimeSessionName,
      );
      expect(row(sessionKey)).toBeUndefined();
      await expect(
        loadTranscriptEvents({ agentId, sessionKey, sessionId, storePath, env: state.env }),
      ).resolves.toContainEqual(message);
      await expect(run()).resolves.toEqual({ changes: [], warnings: [] });
      expect(fs.existsSync(path.join(path.dirname(storePath), `${sessionId}.jsonl`))).toBe(false);
    });
  },
);
