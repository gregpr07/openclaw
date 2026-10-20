import { afterEach, beforeEach } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "./session-transcript-reconcile.js";
import type { InternalSessionEntry } from "./types.js";

export const agentId = "main";
export const sessionKey = "agent:main:message-cut";
export const sourceExpectedState = {
  lifecycleRevision: "source-lifecycle-revision",
  sessionId: "message-cut-source",
};

export function useSessionMessageCutFixtures() {
  const tempDirs = createTempDirTracker();
  beforeEach(() => setRuntimeConfigSnapshot({}));
  afterEach(async () => {
    // Keep drains and resets together: consumer afterEach hooks run before this hook.
    // A synchronous reset there would retire native handles before workers finish.
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    clearRuntimeConfigSnapshot();
    tempDirs.cleanup();
  });
  async function createSiblingSession(params: {
    env: NodeJS.ProcessEnv;
    headline: string;
    sessionId: string;
    sessionKey: string;
  }) {
    const scope = { agentId, ...params };
    await upsertSessionEntryCore(scope, { sessionId: params.sessionId, updatedAt: Date.now() });
    await appendTranscriptEvent(scope, {
      type: "session",
      id: params.sessionId,
      version: 3,
      timestamp: "2026-07-18T01:00:00.000Z",
    });
    await appendTranscriptMessage(scope, {
      eventId: `${params.sessionId}-user`,
      message: { role: "user", content: params.headline },
      now: Date.parse("2026-07-18T01:00:01.000Z"),
      parentId: null,
    });
    return scope;
  }

  async function createSession(options: { activeLeafTarget?: string; incognito?: boolean } = {}) {
    const stateDir = tempDirs.make("openclaw-message-cut-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const sessionId = "message-cut-source";
    const scope = {
      agentId,
      env,
      sessionId,
      sessionKey: options.incognito ? "agent:main:dashboard:incognito-message-cut" : sessionKey,
    };
    const entry: InternalSessionEntry = {
      agentHarnessId: "embedded",
      claudeCliSessionId: "claude-conversation",
      cliSessionBindings: { "claude-cli": { sessionId: "claude-conversation" } },
      cliSessionIds: { "claude-cli": "claude-conversation" },
      compactionCount: 2,
      transcriptByteCompactionLatch: { activeBytes: 20_000, sessionId, maxBytes: 10_000 },
      contextTokens: 100_000,
      contextTokensSource: "runtime",
      createdVia: "operator",
      createdActor: { type: "human", source: "profile", id: "profile-1" },
      createdAt: 1_000,
      delivery: normalizeSessionDeliveryState({
        context: { channel: "telegram", to: "chat-123" },
      }),
      forkSource: { sessionKey: "agent:main:root", sessionId: "root-session" },
      lifecycleRevision: "source-lifecycle-revision",
      lifecycleRunId: "source-run",
      lastRunId: "settled-source-run",
      modelOverride: "gpt-5",
      modelOverrideSource: "user",
      providerOverride: "openai",
      sessionId,
      updatedAt: Date.now(),
    };
    await upsertSessionEntryCore(scope, entry);
    const startedAt = Date.parse("2026-07-18T00:00:00.000Z");
    await appendTranscriptEvent(scope, {
      type: "session",
      id: sessionId,
      version: 3,
      timestamp: new Date(startedAt).toISOString(),
    });
    const messages: Array<
      [string, string | null, Parameters<typeof appendTranscriptMessage>[1]["message"]]
    > = [
      ["user-1", null, { role: "user", content: "first prompt" }],
      ["assistant-1", "user-1", { role: "assistant", content: "first answer" }],
      [
        "user-2",
        "assistant-1",
        {
          role: "user",
          content: [
            { type: "text", text: "second prompt" },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
          ],
          __openclaw: {
            media: [
              { path: "/state/media/inbound/stored-image.png", contentType: "image/png" },
              { path: "/state/media/inbound/notes.txt", contentType: "text/plain" },
            ],
          },
        },
      ],
      ["assistant-2", "user-2", { role: "assistant", content: "second answer" }],
      ["off-path-user", "user-1", { role: "user", content: "inactive prompt" }],
    ];
    for (const [index, [eventId, parentId, message]] of messages.entries()) {
      await appendTranscriptMessage(scope, {
        eventId,
        parentId,
        message,
        now: startedAt + (index + 1) * 1_000,
      });
    }
    await appendTranscriptEvent(scope, {
      type: "leaf",
      id: "active-leaf",
      parentId: "off-path-user",
      timestamp: new Date(startedAt + 6_000).toISOString(),
      targetId: options.activeLeafTarget ?? "assistant-2",
    });
    // Leaf selection schedules projection writes; read/close tests need setup ownership settled.
    await waitForSessionTranscriptIndexReconcilesInStateDir(stateDir);
    return { env, scope };
  }

  return { tempDirs, createSession, createSiblingSession };
}
