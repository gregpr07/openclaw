import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it, vi } from "vitest";
import { nestedToolHistoryFixture } from "../test/nested-tool-activity-fixture.js";
import { createQaBusState } from "./bus-state.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

const searchCallId = "call-session-memory-ranking";
const searchQuery = "current Project Nebula codename";
const currentQuestionResult = {
  path: "sessions/qa/current-session-memory-ranking.jsonl",
  source: "sessions",
  snippet: "User: Session memory ranking check: what is the current Project Nebula codename?",
  score: 0.98,
};
const currentSessionResult = {
  path: "sessions/qa-session-memory-ranking.jsonl",
  source: "sessions",
  snippet: "The current Project Nebula codename is ORBIT-10.",
  score: 0.8,
};
const staleDurableResult = {
  path: `memory/${new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10)}.md`,
  source: "memory",
  snippet: "Project Nebula current codename: ORBIT-9.",
  score: 0.9,
};

async function runSessionMemoryRankingFlow(
  params: {
    results?: (typeof currentSessionResult)[];
    providerMode?: "mock-openai" | "live-frontier";
  } = {},
) {
  const state = createQaBusState();
  const results = params.results ?? [currentSessionResult, staleDurableResult];
  const providerMode = params.providerMode ?? "mock-openai";
  const plannedToolArgs = { query: searchQuery, maxResults: 6 };
  const directHistoryMessages = [
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: searchCallId, name: "memory_search", arguments: plannedToolArgs },
      ],
    },
    {
      role: "toolResult",
      toolCallId: searchCallId,
      toolName: "memory_search",
      isError: false,
      content: [{ type: "text", text: JSON.stringify({ results }) }],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "The current Project Nebula codename is ORBIT-10." }],
    },
  ];
  const historyMessages =
    providerMode === "live-frontier"
      ? [
          nestedToolHistoryFixture({
            toolName: "memory_search",
            toolCallId: searchCallId,
            input: plannedToolArgs,
            text: JSON.stringify({ results }),
          }),
        ]
      : directHistoryMessages;
  const gatewayCall = vi.fn(
    async (method: string, request: { sessionKey?: string; limit?: number }) => {
      expect(method).toBe("chat.history");
      expect(request.sessionKey).toBe("agent:qa:session-memory-ranking");
      return { messages: historyMessages };
    },
  );
  const fetchJson = vi.fn(async (input: string) => {
    throw new Error(`unexpected QA mock request: ${input}`);
  });
  const runAgentPrompt = vi.fn(async (_env: unknown, options: { message: string }) => {
    expect(options.message).not.toContain("ORBIT-10");
    state.addOutboundMessage({
      accountId: "qa-channel",
      to: "dm:qa-operator",
      text: "The current Project Nebula codename is ORBIT-10.",
    });
  });

  const result = await runLoadedScenarioFlow("session-memory-ranking", {
    state,
    api: {
      env: {
        providerMode,
        gateway: { workspaceDir: "/qa/workspace", call: gatewayCall },
        ...(providerMode === "mock-openai" ? { mock: { baseUrl: "http://qa.mock" } } : {}),
      },
      path,
      fs: {
        mkdir: async () => undefined,
        writeFile: vi.fn(async () => undefined),
        utimes: vi.fn(async () => undefined),
      },
      readConfigSnapshot: async () => ({ config: {} }),
      patchConfig: async () => undefined,
      seedQaSessionTranscript: async () => undefined,
      forceMemoryIndex: vi.fn(async () => undefined),
      runAgentPrompt,
      normalizeLowercaseStringOrEmpty,
      fetchJson,
    },
  });

  return { result, fetchJson, gatewayCall, runAgentPrompt };
}

describe("session memory ranking scenario evidence", () => {
  it.each(["live-frontier"] as const)(
    "requires successful provider-independent persisted search evidence (%s)",
    async (providerMode) => {
      const { fetchJson, gatewayCall, runAgentPrompt } = await runSessionMemoryRankingFlow({
        providerMode,
      });

      expect(runAgentPrompt).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          transcriptToolName: "memory_search",
          requireSuccessfulTranscriptToolResult: true,
        }),
      );
      expect(gatewayCall).toHaveBeenCalledWith(
        "chat.history",
        expect.objectContaining({ sessionKey: "agent:qa:session-memory-ranking" }),
        expect.anything(),
      );
      expect(fetchJson).not.toHaveBeenCalled();
    },
  );

  it("rejects stale facts ahead of current facts even when the current question ranks first", async () => {
    await expect(
      runSessionMemoryRankingFlow({
        results: [currentQuestionResult, staleDurableResult, currentSessionResult],
      }),
    ).rejects.toThrow(/rank|stale|durable/i);
  });
});
