import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { EmbeddedAgentRunResult } from "../agents/embedded-agent-runner/types.js";
import * as embeddedAgent from "../agents/embedded-agent.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePublicationSupersededError,
} from "../agents/prepared-model-runtime.errors.js";
import {
  AGENT_RUN_SUPERSEDED_STOP_REASON,
  createAgentRunSupersededAbortError,
} from "../agents/run-termination.js";
import * as configModule from "../config/config.js";
import { createSnapshot } from "../config/mutate.test-support.js";
import type { OpenClawConfig } from "../config/types.js";
import { createSystemAgentSession, runSystemAgentTurn } from "./agent-turn.js";
import { SystemAgentInferenceUnavailableError } from "./inference-error.js";
import {
  createSystemAgentVerifiedInferenceTestFixture as createFixture,
  createSystemAgentPluginMetadataTestSnapshot as prepareMetadata,
} from "./system-agent.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let metadata: ReturnType<typeof prepareMetadata>;
beforeAll(() => {
  metadata = prepareMetadata();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

vi.mock("../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/embedded-agent.js")>()),
  runEmbeddedAgent: vi.fn(),
}));

function output(
  payloads?: EmbeddedAgentRunResult["payloads"],
  meta: Partial<EmbeddedAgentRunResult["meta"]> = {},
) {
  return async (): Promise<EmbeddedAgentRunResult> => ({
    payloads,
    meta: { durationMs: 0, ...meta },
  });
}

const rejection = (error: Error) => () => Promise.reject(error);

describe("system-agent terminal failure cleanup", () => {
  it.each([
    [
      "runner rejection",
      rejection(new Error("provider unavailable")),
      "The inference request failed",
    ],
    ["superseded generation", rejection(createAgentRunSupersededAbortError()), "superseded"],
    [
      "superseded prepared runtime generation",
      rejection(
        new PreparedModelRuntimePublicationSupersededError(
          "prepared model runtime plugin generation was superseded",
        ),
      ),
      "runtime was superseded",
    ],
    [
      "unpublished prepared runtime owner",
      rejection(new PreparedModelRuntimeOwnerNotPublishedError("no runtime owner published")),
      "prepared inference runtime became unavailable or was superseded",
    ],
    [
      "superseded terminal result with retained text",
      output(undefined, {
        finalAssistantVisibleText: "An obsolete reply",
        aborted: true,
        stopReason: AGENT_RUN_SUPERSEDED_STOP_REASON,
      }),
      "runtime was superseded",
    ],
    ["empty model output", output([]), "The inference request failed"],
    ["hidden reasoning", output([{ text: "Considering the answer", isReasoning: true }])],
    ["hidden commentary", output([{ text: "Checking the gateway", isCommentary: true }])],
    ["explicitly hidden output", output([{ text: "Private model output", visible: false }])],
    ["status notice", output([{ text: "Still working", isStatusNotice: true }])],
    [
      "silent reply despite a retained payload",
      output([{ text: "NO_REPLY" }], { terminalReply: { disposition: "silent" } }),
    ],
    [
      "silent terminal fact with an earlier visible draft",
      output([{ text: "Retained draft, not a final result." }], {
        terminalReply: { disposition: "silent" },
      }),
    ],
    ["raw-only hidden metadata", output(undefined, { finalAssistantRawText: "Hidden draft" })],
    [
      "timed-out turn with retained visible text",
      output([{ text: "The setup turn timed out.", isError: true }], {
        finalAssistantVisibleText: "I'll begin by checking the available models.",
        error: { kind: "incomplete_turn", message: "The setup turn timed out." },
        stopReason: "timeout",
      }),
      "timed out",
    ],
    [
      "failed turn with partial payload text",
      output([{ text: "I'll check the gateway." }], {
        error: { kind: "incomplete_turn", message: "The provider failed." },
      }),
    ],
    [
      "blocked turn with partial payload text",
      output([{ text: "I'll check the gateway." }], { livenessState: "blocked" }),
    ],
    [
      "abandoned turn with retained visible text",
      output(undefined, {
        finalAssistantVisibleText: "I'll check the gateway.",
        livenessState: "abandoned",
      }),
    ],
  ] satisfies Array<[string, () => Promise<EmbeddedAgentRunResult>, string?]>)(
    "clears partial session state after %s",
    async (_name, runEmbeddedAgent, guidance) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-turn-failure-"));

      const config: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      };
      const { binding } = await metadata.run(() => createFixture(config), config);
      const session = createSystemAgentSession(binding);
      session.proposalRef.current = "partial-proposal";
      session.proposalRef.operation = { kind: "setup" };
      session.cliSession = {
        routeKey: "stale-route",
        binding: { sessionId: "uncertain-cli-session" },
      };

      vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation(async (params) => {
        expect(params.terminalReplyExpectation).toBe("result-required");
        return runEmbeddedAgent();
      });
      vi.spyOn(configModule, "readConfigFileSnapshot").mockResolvedValue({
        ...createSnapshot({ sourceConfig: config, hash: "hash" }),
        raw: null,
      });
      const failure = metadata.run(() =>
        runSystemAgentTurn({
          input: "hello",
          surface: "gateway",
          approvalArmed: false,
          session,
        }),
      );
      await expect(failure).rejects.toBeInstanceOf(SystemAgentInferenceUnavailableError);
      const message = await failure.catch((error: unknown) =>
        error instanceof Error ? error.message : String(error),
      );
      expect(message).not.toContain("openclaw onboard");
      if (guidance) {
        expect(message).toContain(guidance);
      }
      expect(session.proposalRef.current).toBeUndefined();
      expect(session.proposalRef.operation).toBeUndefined();
      expect(session.cliSession).toBeUndefined();
    },
  );
});
