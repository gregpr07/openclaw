import { createServer, type IncomingHttpHeaders } from "node:http";
import { createApiRegistry, createLlmRuntime } from "@openclaw/ai";
import type { Model, StreamOptions } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";
import { registerProviderStreamForModel } from "./provider-stream.js";

describe("registered managed completion API session affinity", () => {
  it.each<
    [
      name: string,
      options: StreamOptions,
      expected: string | undefined,
      openrouter?: boolean,
      configured?: boolean,
    ]
  >([
    ["explicit cache key", { sessionId: "session", promptCacheKey: "cache-key" }, "cache-key"],
    ["long cache key", { sessionId: "session", promptCacheKey: "k".repeat(80) }, "k".repeat(64)],
    ["missing session", {}, undefined],
    ["cache disabled", { sessionId: "session", cacheRetention: "none" }, undefined],
    [
      "caller precedence",
      {
        sessionId: "session",
        headers: {
          SESSION_ID: "caller",
          "X-CLIENT-REQUEST-ID": "caller",
          "X-SESSION-AFFINITY": "caller",
        },
      },
      "caller",
    ],
    ["OpenRouter", { sessionId: "session" }, "session", true],
    ["OpenRouter configured", { sessionId: "session" }, "configured", true, true],
    [
      "OpenRouter caller",
      { sessionId: "session", headers: { "X-SESSION-ID": "caller" } },
      "caller",
      true,
      true,
    ],
  ])(
    "preserves %s through registered native and managed API aliases",
    async (name, options, expected, openrouter, configured) => {
      const requests: IncomingHttpHeaders[] = [];
      const server = createServer((request, response) => {
        requests.push(request.headers);
        request.resume();
        request.on("end", () => {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            `data: ${JSON.stringify({
              id: "affinity",
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "affinity-ok" },
                  finish_reason: "stop",
                },
              ],
            })}\n\ndata: [DONE]\n\n`,
          );
        });
      });
      try {
        await new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Loopback receiver did not bind");
        }
        const model = attachModelProviderRequestTransport<Model<"openai-completions">>(
          {
            id: "affinity-fixture",
            name: "Affinity fixture",
            provider: "affinity-fixture",
            api: "openai-completions",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            reasoning: false,
            input: ["text"],
            contextWindow: 128000,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            compat: {
              sendSessionAffinityHeaders: true,
              ...(openrouter ? { thinkingFormat: "openrouter" } : {}),
            },
            headers: configured
              ? { "X-Session-ID": "configured" }
              : name === "caller precedence"
                ? {
                    Session_ID: "configured",
                    "X-Client-Request-ID": "configured",
                    "X-Session-Affinity": "configured",
                  }
                : undefined,
          },
          { tls: { insecureSkipVerify: false } },
        );
        const registry = createApiRegistry();
        const streamFn = registerProviderStreamForModel({
          model,
          apiRegistry: registry,
          allowRuntimePluginLoad: false,
        });
        if (!streamFn) {
          throw new Error("Managed completion provider did not register");
        }
        ensureCustomApiRegistered(registry, "openclaw-openai-completions-transport", streamFn);
        const runtime = createLlmRuntime(registry);
        for (const api of ["openai-completions", "openclaw-openai-completions-transport"]) {
          const dispatchModel: Model = { ...model, api };
          const response = await runtime.complete(
            dispatchModel,
            {
              messages: [{ role: "user", content: "Reply affinity-ok", timestamp: 1 }],
            },
            { apiKey: "synthetic-loopback-key", ...options },
          );
          expect(response).toMatchObject({
            stopReason: "stop",
            content: [{ type: "text", text: "affinity-ok" }],
          });
        }
        expect(requests).toHaveLength(2);
        for (const headers of requests) {
          for (const header of ["session_id", "x-client-request-id", "x-session-affinity"]) {
            expect(headers[header], header).toBe(openrouter ? undefined : expected);
          }
          expect(headers["x-session-id"]).toBe(openrouter ? expected : undefined);
        }
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );
});
