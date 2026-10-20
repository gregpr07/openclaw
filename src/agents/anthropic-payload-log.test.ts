import crypto from "node:crypto";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAnthropicPayloadLogger } from "./anthropic-payload-log.js";
import * as queuedFileWriter from "./queued-file-writer.js";

const capturedLines: string[] = [];

beforeEach(() => {
  capturedLines.length = 0;
  vi.spyOn(queuedFileWriter, "getQueuedFileWriter").mockImplementation(() => ({
    filePath: "memory",
    write: (line) => capturedLines.push(line),
    flush: async () => undefined,
  }));
  vi.stubEnv("OPENCLAW_ANTHROPIC_PAYLOAD_LOG", "1");
  vi.stubEnv("OPENCLAW_ANTHROPIC_PAYLOAD_LOG_FILE", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("createAnthropicPayloadLogger", () => {
  const bareAnthropicKey = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx"; // pragma: allowlist secret
  const bareGithubKey = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz1234567890"; // pragma: allowlist secret
  const bareGoogleKey = "AIzaSyA1bC2dE3fG4hI5jK6lM7nO8pQrStUvW"; // pragma: allowlist secret

  it.each(["dashboard", "subagent", "internal-session-effects"])(
    "does not record Incognito %s payloads or raw errors when logging is enabled",
    (surface) => {
      const logger = createAnthropicPayloadLogger({
        sessionKey: `agent:main:${surface}:incognito-private`,
      });
      logger?.recordUsage([], new Error("synthetic private provider error"));
      expect(capturedLines).toEqual([]);
      expect(logger).toBeNull();
    },
  );

  it("sanitizes credential fields and image base64 payload data before writing logs", async () => {
    const logger = createAnthropicPayloadLogger({});

    const payload = {
      messages: [
        {
          role: "user",
          authorization: "Bearer sk-secret", // pragma: allowlist secret
          diagnosticText: bareAnthropicKey,
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
            },
          ],
        },
      ],
      metadata: {
        api_key: "sk-test", // pragma: allowlist secret
        nestedToken: "shh", // pragma: allowlist secret
        tokenBudget: 1024,
        diagnosticText: bareGithubKey,
      },
    };
    const streamFn: StreamFn = (model, __, options) => {
      options?.onPayload?.(payload, model);
      return {} as never;
    };

    const wrapped = logger?.wrapStreamFn(streamFn);
    expect(typeof wrapped).toBe("function");
    if (!wrapped) {
      throw new Error("expected payload logger to wrap stream function");
    }
    await wrapped({ api: "anthropic-messages" } as never, { messages: [] } as never, {});

    const event: unknown = JSON.parse(capturedLines[0]?.trim() ?? "{}");
    expect(event).toMatchObject({
      payload: {
        messages: [
          {
            diagnosticText: expect.any(String),
            content: [
              {
                source: {
                  data: "<redacted>",
                  bytes: 4,
                  sha256: crypto.createHash("sha256").update("QUJDRA==").digest("hex"),
                },
              },
            ],
          },
        ],
        metadata: { tokenBudget: 1024, diagnosticText: expect.any(String) },
      },
      payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const serialized = JSON.stringify(event);
    for (const secret of [
      bareAnthropicKey,
      bareGithubKey,
      '"authorization"',
      '"api_key"',
      '"nestedToken"',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("sanitizes usage and error fields before writing logs", () => {
    const logger = createAnthropicPayloadLogger({});

    logger?.recordUsage(
      [
        {
          role: "assistant",
          content: "",
          usage: {
            input: 1,
            authorization: "Bearer sk-secret", // pragma: allowlist secret
            diagnosticText: bareGithubKey,
          },
        } as never,
      ],
      new Error(`failed with Bearer sk-secret and ${bareGoogleKey}`), // pragma: allowlist secret
    );

    const event = JSON.parse(capturedLines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event).toMatchObject({
      error: expect.stringContaining("failed with Bearer <redacted> and "),
    });
    expect(event.usage).toEqual({ input: 1, diagnosticText: expect.any(String) });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(bareGithubKey);
    expect(serialized).not.toContain(bareGoogleKey);
  });
});
