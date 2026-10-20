import { createRequire } from "node:module";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import {
  createMattermostClient,
  createMattermostDirectChannelWithRetry,
  fetchMattermostMe,
} from "./client.js";

// Undici's testing-only reset releases timers that retain Vitest's retired clock.
const undiciTimers: { reset: () => void } = createRequire(import.meta.url)(
  "undici/lib/util/timers.js",
);

type OperationOutcome =
  | { status: "resolved" }
  | { status: "rejected"; error: unknown }
  | { status: "pending" };

async function settleWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<OperationOutcome> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ),
      new Promise<OperationOutcome>((resolve) => {
        timeout = setTimeout(() => resolve({ status: "pending" }), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function expectTimeoutOutcome(outcome: OperationOutcome): void {
  expect(outcome).toEqual({ status: "rejected", error: expect.any(Error) });
  if (outcome.status === "rejected") {
    expect(outcome.error).toMatchObject({
      name: expect.stringMatching(/^(AbortError|TimeoutError)$/),
    });
  }
}

function clientAt(baseUrl: string, timeoutMs: number) {
  return createMattermostClient({
    baseUrl,
    botToken: "bot-token",
    allowPrivateNetwork: true,
    timeoutMs,
  });
}

async function withHangingMattermostServer(
  run: (server: {
    client: ReturnType<typeof createMattermostClient>;
    received: Promise<void>;
    requestCount: () => number;
  }) => Promise<void>,
  timeoutMs = 50,
): Promise<void> {
  let requestCount = 0;
  const received = Promise.withResolvers<void>();
  await withServer(
    (request) => {
      requestCount += 1;
      received.resolve();
      request.resume();
    },
    async (baseUrl) => {
      // Keep real socket I/O, but advance deadlines only after the request arrives.
      // A loaded worker can otherwise exhaust the 50ms deadline before connecting.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        await run({
          client: clientAt(baseUrl, timeoutMs),
          received: received.promise,
          requestCount: () => requestCount,
        });
      } finally {
        undiciTimers.reset();
        vi.useRealTimers();
      }
    },
  );
}

async function expire(request: Promise<unknown>, received: Promise<void>, cancel?: () => void) {
  const outcome = settleWithin(request, 750);
  await Promise.race([received, request]);
  cancel?.();
  await vi.advanceTimersByTimeAsync(750);
  expectTimeoutOutcome(await outcome);
}

describe("Mattermost REST client fetch timeout", () => {
  it("rejects a hanging real loopback request at the configured client timeout", async () => {
    await withHangingMattermostServer(async (server) => {
      await expire(fetchMattermostMe(server.client), server.received);
      expect(server.requestCount()).toBe(1);
    });
  });

  it("preserves a caller AbortSignal while applying the default request timeout", async () => {
    await withHangingMattermostServer(async (server) => {
      const controller = new AbortController();
      const request = server.client.request("/users/me", { signal: controller.signal });
      await expire(request, server.received, () => controller.abort());
    }, 30_000);
  });

  it("preserves caller cancellation through a guarded response body", async () => {
    const fetchResolved = Promise.withResolvers<void>();
    await withServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"id":"partial');
      },
      async (baseUrl) => {
        const guardedFetch = ssrfRuntime.fetchWithSsrFGuard;
        const guard = vi
          .spyOn(ssrfRuntime, "fetchWithSsrFGuard")
          .mockImplementation(async (params) => {
            const result = await guardedFetch(params);
            fetchResolved.resolve();
            return result;
          });
        const client = clientAt(baseUrl, 30_000);
        const controller = new AbortController();
        const reason = new Error("caller stopped after headers");
        const request = client.request("/users/me", { signal: controller.signal });

        try {
          await fetchResolved.promise;
          // Let the client's post-fetch cleanup run before cancellation so this
          // specifically covers the response-body phase.
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          controller.abort(reason);

          const outcome = await settleWithin(request, 750);
          expect(outcome).toEqual({ status: "rejected", error: reason });
        } finally {
          guard.mockRestore();
        }
      },
    );
  });

  it("preserves configured DM retry timeouts longer than the client default", async () => {
    await withHangingMattermostServer(async (server) => {
      const request = createMattermostDirectChannelWithRetry(
        server.client,
        ["bot-user", "dm-user"],
        {
          maxRetries: 0,
          timeoutMs: 250,
        },
      );
      const earlyOutcome = settleWithin(request, 120);

      await Promise.race([server.received, request]);
      await vi.advanceTimersByTimeAsync(120);
      expect(await earlyOutcome).toEqual({ status: "pending" });
      const outcome = settleWithin(request, 600);
      await vi.advanceTimersByTimeAsync(600);
      expectTimeoutOutcome(await outcome);
    });
  });
});
