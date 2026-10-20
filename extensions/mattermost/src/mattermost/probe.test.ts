import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeMattermost } from "./probe.js";

const { mockFetchGuard, mockRelease } = vi.hoisted(() => ({
  mockFetchGuard: vi.fn(),
  mockRelease: vi.fn(async () => {}),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return { ...original, fetchWithSsrFGuard: mockFetchGuard };
});

function respond(response = Response.json({ id: "bot-1" })) {
  mockFetchGuard.mockResolvedValueOnce({ response, release: mockRelease });
}

function expectResult(result: Awaited<ReturnType<typeof probeMattermost>>, expected: object) {
  const { elapsedMs, ...stableResult } = result;
  expect(stableResult).toStrictEqual(expected);
  expect(elapsedMs).toBeGreaterThanOrEqual(0);
  expect(mockRelease).toHaveBeenCalledTimes(1);
}

describe("probeMattermost", () => {
  beforeEach(() => {
    mockFetchGuard.mockReset();
    mockRelease.mockClear();
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns baseUrl missing for empty base URL", async () => {
    await expect(probeMattermost(" ", "token")).resolves.toEqual({
      ok: false,
      error: "baseUrl missing",
    });
    expect(mockFetchGuard).not.toHaveBeenCalled();
  });

  it("normalizes base URL and returns bot info", async () => {
    respond(Response.json({ id: "bot-1", username: "clawbot" }));
    const result = await probeMattermost("https://mm.example.com/api/v4/", "bot-token");
    expect(mockFetchGuard.mock.calls[0]?.[0]).toEqual({
      url: "https://mm.example.com/api/v4/users/me",
      init: { headers: { Authorization: "Bearer bot-token" } },
      timeoutMs: 2500,
      auditContext: "mattermost-probe",
      policy: undefined,
    });
    expectResult(result, {
      ok: true,
      status: 200,
      bot: { id: "bot-1", username: "clawbot" },
    });
  });

  it("bounds and cancels oversized probe success JSON bodies", async () => {
    let canceled = false;
    let pulled = 0;
    const oversizeChunk = new Uint8Array(2 * 1024 * 1024).fill(0x7b); // 2 MiB of "{"
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(oversizeChunk);
      },
      cancel() {
        canceled = true;
      },
    });
    respond(new Response(stream, { status: 200, headers: { "content-type": "application/json" } }));

    const result = await probeMattermost("https://mm.example.com", "bot-token");

    expect(result).toMatchObject({ ok: false, status: null });
    expect(result.error).toContain("JSON response exceeds 16777216 bytes");
    expect(canceled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(12);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("forwards allowPrivateNetwork to the SSRF guard policy", async () => {
    respond();
    await probeMattermost("https://mm.example.com", "bot-token", 2500, true);

    expect(mockFetchGuard.mock.calls[0]?.[0].policy).toStrictEqual({ allowPrivateNetwork: true });
  });

  it("clamps oversized probe timeouts before the guard-owned deadline", async () => {
    respond();
    await probeMattermost("https://mm.example.com", "bot-token", Number.MAX_SAFE_INTEGER);

    expect(mockFetchGuard.mock.calls[0]?.[0].timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("returns a string diagnostic without a reflected active credential in an object message", async () => {
    mockFetchGuard.mockImplementationOnce(async ({ init }: { init: RequestInit }) => {
      const authorization = new Headers(init.headers).get("Authorization");
      expect(authorization).toBe("Bearer abcdefghijklmnopqrstuvwxyz");
      return {
        response: Response.json(
          { message: { context: "retry later", echoed: authorization?.slice(7) } },
          { status: 503 },
        ),
        release: mockRelease,
      };
    });

    const result = await probeMattermost("https://mm.example.com", "abcdefghijklmnopqrstuvwxyz");

    expect(result).toMatchObject({
      ok: false,
      status: 503,
      error: '{"message":{"context":"retry later","echoed":"***"}}',
    });
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("falls back to statusText when error body is empty", async () => {
    respond(
      new Response("", {
        status: 403,
        statusText: "Forbidden",
        headers: { "content-type": "text/plain" },
      }),
    );

    expectResult(await probeMattermost("https://mm.example.com", "token"), {
      ok: false,
      status: 403,
      error: "Forbidden",
    });
  });
});
