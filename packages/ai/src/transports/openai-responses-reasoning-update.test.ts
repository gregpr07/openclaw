import type { ResponseOutputMessage } from "openai/resources/responses/responses.js";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { cleanupSessionResources } from "../session-resources.js";
import {
  claimOpenAIResponsesHttpContinuation,
  resolveResponsesContinuationRequest,
  type ResponsesContinuationRequest,
  type ResponsesContinuationState,
} from "./openai-responses-continuation.js";

const user = (text: string) => ({
  type: "message" as const,
  role: "user" as const,
  content: [{ type: "input_text" as const, text }],
});
const answer: ResponseOutputMessage = {
  type: "message",
  role: "assistant",
  id: "msg_answer",
  status: "completed",
  content: [{ type: "output_text", text: "answer", annotations: [] }],
};
const update = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });
const initial = (
  extra: Record<string, unknown> = {},
  mode?: "pro",
): ResponsesContinuationState => ({
  lastRequest: {
    model: "gpt-6-astra",
    reasoning: { effort: "low", summary: "auto", mode },
    input: [user("first")],
    store: true,
    ...extra,
  },
  lastResponseId: "resp_1",
  lastResponseItems: [answer],
});
const next = (effort = "high", extra: Record<string, unknown> = {}, mode?: "pro") =>
  ({
    ...initial().lastRequest,
    reasoning: { effort, summary: "auto", mode },
    input: [user("first"), answer, user("second")],
    ...extra,
  }) satisfies ResponsesContinuationRequest;
function expectContinuation(
  result: ReturnType<typeof resolveResponsesContinuationRequest>,
  id: string,
  effort: string,
  turn: string,
) {
  expect(result.request).toMatchObject({
    previous_response_id: id,
    reasoning: { effort: "low" },
    input: [update(effort), user(turn)],
  });
  assert(result.fullRequest);
  return result.fullRequest;
}
function expectUnchanged(request: ResponsesContinuationRequest, previous = initial()) {
  const result = resolveResponsesContinuationRequest(previous, request);
  expect(result.request).toBe(request);
  expect(result.fullRequest).toBeUndefined();
  return result.request;
}

afterEach(() => {
  cleanupSessionResources();
  vi.useRealTimers();
});

describe("cache-preserving Responses reasoning changes", () => {
  it.each(["high", "max", "xhigh"])(
    "keeps the request effort and original update positions through %s turns",
    (effort) => {
      const first = initial();
      const second = next(effort);
      const before = structuredClone({ first, second });
      const high = resolveResponsesContinuationRequest(first, second);
      const highFull = expectContinuation(high, "resp_1", effort, "second");
      const prefix = [user("first"), answer, update(effort), user("second")];
      expect(highFull.input).toEqual(prefix);
      expect({ first, second }).toEqual(before);
      const third = {
        ...next("medium"),
        input: [...second.input, answer, user("third")],
      };
      const medium = resolveResponsesContinuationRequest(
        { ...first, lastRequest: highFull, lastResponseId: "resp_2" },
        third,
      );
      const mediumFull = expectContinuation(medium, "resp_2", "medium", "third");
      expect(mediumFull.input).toEqual([...prefix, answer, update("medium"), user("third")]);
      const unchanged = resolveResponsesContinuationRequest(
        { ...first, lastRequest: mediumFull, lastResponseId: "resp_3" },
        { ...third, input: [...third.input, answer, user("fourth")] },
      );
      expect(unchanged.request.input).toEqual([user("fourth")]);
      expect(unchanged.request.reasoning).toMatchObject({ effort: "low" });
    },
  );

  it.each<{
    name: string;
    extra: Record<string, unknown>;
    mode?: "pro";
  }>([
    { name: "another model", extra: { model: "gpt-5.6-luna" } },
    { name: "pro mode", extra: {}, mode: "pro" },
    { name: "multi-agent", extra: { multi_agent: { enabled: true } } },
    { name: "automatic truncation", extra: { truncation: "auto" } },
    {
      name: "automatic compaction",
      extra: { context_management: [{ type: "compaction", compact_threshold: 1000 }] },
    },
  ])("leaves $name on request-level effort", ({ extra, mode }) => {
    expectUnchanged(next("high", extra, mode), initial(extra, mode));
  });

  it("drops provisional updates when the original history changed or no new user exists", () => {
    for (const input of [
      [user("edited"), answer, user("second")],
      [user("first"), answer],
    ]) {
      const request = { ...next(), input };
      expect(expectUnchanged(request).reasoning).toMatchObject({ effort: "high" });
    }
  });

  it.each([
    { input: [], expectedStatus: "history_shorter" },
    { input: [user("edited"), answer, user("second")], expectedStatus: "history_changed" },
    {
      input: [user("first"), { ...answer, content: [] }, user("second")],
      expectedStatus: "history_changed",
    },
  ])("keeps required-input history validation: $expectedStatus", ({ input, expectedStatus }) => {
    const request = { ...next(), max_output_tokens: 512, input };
    const result = resolveResponsesContinuationRequest(initial(), request, "required-input");
    expect(result).toEqual({ request, continuationStatus: expectedStatus });
    expect(result.request.previous_response_id).toBeUndefined();
  });

  it("replays unstored HTTP input and resets to the chosen effort after cache expiry", () => {
    vi.useFakeTimers();
    // Exceed private HTTP_CONTINUATION_IDLE_TTL_MS.
    const idleTtlMs = 90 * 60 * 1000;
    const claim = (request: ResponsesContinuationRequest) =>
      claimOpenAIResponsesHttpContinuation({
        sessionId: "reasoning-session",
        apiKey: "test-api-key",
        baseUrl: "https://api.openai.com/v1",
        headers: {},
        request: { ...request, store: false },
      });
    const first = claim(initial().lastRequest);
    assert(first);
    first.commit(first.fullRequest, { id: "resp_1", output: [answer] });
    const second = claim(next());
    assert(second);
    expect(second.request.previous_response_id).toBeUndefined();
    expect(second.request.reasoning).toMatchObject({ effort: "low" });
    expect(second.request.input).toEqual([user("first"), answer, update("high"), user("second")]);
    second.commit(second.fullRequest, { id: "resp_2", output: [answer] });
    vi.advanceTimersByTime(idleTtlMs + 1);
    const third = claim({ ...next("medium"), input: [...next().input, answer, user("third")] });
    assert(third);
    expect(third.request.previous_response_id).toBeUndefined();
    expect(third.request.reasoning).toMatchObject({ effort: "medium" });
    expect(third.request.input).not.toContainEqual(update("high"));
    third.release();
  });
});
