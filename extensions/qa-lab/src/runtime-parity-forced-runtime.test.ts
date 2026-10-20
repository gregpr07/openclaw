import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeQaRuntimeStores } from "openclaw/plugin-sdk/qa-runtime";
import { resolveStorePath, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { formatSqliteSessionFileMarker } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { captureRuntimeParityCell } from "./runtime-parity.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness({ beforeCleanup: closeQaRuntimeStores });

afterEach(() => {
  resetPluginStateStoreForTests({ closeDatabase: false });
});

afterAll(() => tempDirs.cleanup());

async function captureForcedCodexCell(
  sessionId: string,
  assistant?: Record<string, unknown>,
  logs?: () => string,
) {
  const tempRoot = await tempDirs.makeTempDir("openclaw-qa-forced-runtime-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(tempRoot, "state") };
  const sessionKey = `agent:qa:${sessionId}`;
  const storePath = resolveStorePath(undefined, { agentId: "qa", env });
  const identity = { agentId: "qa", env, sessionId, sessionKey, storePath };
  await upsertSessionEntry({
    ...identity,
    entry: {
      sessionId,
      sessionFile: formatSqliteSessionFileMarker(identity),
      updatedAt: 100,
    },
  });
  const messages = [
    { role: "user", content: "runtime isolation check" },
    ...(assistant ? [assistant] : []),
  ];
  for (const [index, message] of messages.entries()) {
    await appendSessionTranscriptMessageByIdentity({
      ...identity,
      now: index + 1,
      message: message as never,
    });
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("[]", { headers: { "content-type": "application/json" } })),
  );
  return captureRuntimeParityCell({
    runtime: "codex",
    gateway: { tempRoot, ...(logs ? { logs } : {}) },
    mockBaseUrl: "http://127.0.0.1:43123",
    scenarioResult: { status: "pass" },
    wallClockMs: 10,
  });
}

describe("runtime parity forced runtime observer", () => {
  it("ignores Codex mirror records and shared logs without an OpenClaw selection", async () => {
    const cell = await captureForcedCodexCell(
      "forced-codex-embedded-runtime",
      {
        role: "assistant",
        content: [{ type: "text", text: "Codex mirror" }],
        provider: "openai",
        api: "openai-responses",
        stopReason: "stop",
        __openclaw: { mirrorOrigin: "codex-app-server" },
      },
      () => "[agent/embedded] fallback runner entered",
    );

    expect(cell.runtimeErrorClass).toBeUndefined();
  });

  it("fails a forced-Codex mock cell that selects the OpenClaw fallback", async () => {
    const cell = await captureForcedCodexCell(
      "forced-codex-openclaw-selection",
      undefined,
      () =>
        "agent harness selected requested=codex selected=openclaw reason=plugin_declared_fallback_openclaw",
    );

    expect(cell.runtimeErrorClass).toBe("forced-codex-embedded-runtime");
  });

  it("fails a forced-Codex mock cell containing any unmirrored Responses record", async () => {
    const cell = await captureForcedCodexCell("forced-codex-openai-egress", {
      role: "assistant",
      content: [],
      provider: "openai",
      api: "openai-responses",
      stopReason: "stop",
    });

    expect(cell.runtimeErrorClass).toBe("forced-codex-embedded-runtime");
  });
});
