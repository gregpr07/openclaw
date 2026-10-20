import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { CUSTOM_LOCAL_AUTH_MARKER } from "../agents/model-auth-markers.js";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "./audio.test-helpers.js";
import { transcribeOpenAiCompatibleAudio } from "./openai-compatible-audio.js";
import { describeOpenAiCompatibleVideo } from "./openai-compatible-video.js";
import type { AudioTranscriptionRequest } from "./types.js";

installPinnedHostnameTestHooks();

const noAuth = { kind: "none", source: "local provider" } as const;
const typedAuth = { kind: "api-key", apiKey: "typed-key" } as const;
const bearerRequest = { auth: { mode: "authorization-bearer", token: "request-key" } } as const;
type AuthCase = [
  name: string,
  request: Partial<Pick<AudioTranscriptionRequest, "apiKey" | "auth" | "headers" | "request">>,
  authorization: string | null,
  customHeader?: string,
];

describe.each([
  { capability: "audio", send: transcribeOpenAiCompatibleAudio, errorLabel: "Audio transcription" },
  {
    capability: "video",
    send: describeOpenAiCompatibleVideo,
    errorLabel: "Local media video description",
  },
])("OpenAI-compatible $capability authentication", ({ send, errorLabel }) => {
  const defaults = {
    buffer: Buffer.from("media"),
    fileName: "media.bin",
    apiKey: "legacy-key",
    timeoutMs: 1000,
    provider: "local-media",
    defaultBaseUrl: "https://media.example.com/v1",
    defaultModel: "local-model",
    defaultPrompt: "Describe the media.",
    providerLabel: "Local media",
  };
  it.each<AuthCase>([
    ["no-auth suppresses the marker", { apiKey: CUSTOM_LOCAL_AUTH_MARKER, auth: noAuth }, null],
    ["typed key overrides legacy key", { auth: typedAuth }, "Bearer typed-key"],
    ["legacy key", {}, "Bearer legacy-key"],
    ["empty legacy key", { apiKey: "" }, null],
    [
      "caller headers override provider and request auth",
      {
        auth: noAuth,
        headers: { Authorization: "Bearer caller-key" },
        request: bearerRequest,
      },
      "Bearer caller-key",
    ],
    [
      "request bearer overrides no-auth",
      { auth: noAuth, request: bearerRequest },
      "Bearer request-key",
    ],
    [
      "custom auth replaces provider bearer",
      {
        auth: typedAuth,
        request: { auth: { mode: "header", headerName: "X-Custom-Key", value: "custom-key" } },
      },
      null,
      "custom-key",
    ],
  ])("%s", async (_name, request, authorization, customHeader) => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      text: "ok",
      choices: [{ message: { content: "ok" } }],
    });
    const result = await send({ ...defaults, fetchFn, ...request });

    expect(result.text).toBe("ok");
    const headers = new Headers(getRequest().init?.headers);
    expect(headers.get("authorization")).toBe(authorization);
    expect(headers.get("x-custom-key")).toBe(customHeader ?? null);
  });

  it.each([400, 200])(
    "redacts reflected request credentials from HTTP %s diagnostics",
    async (status) => {
      const credential = "synthetic-only";
      const fetchFn = vi.fn<typeof fetch>().mockImplementationOnce(async (_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${credential}`);
        return new Response(
          status === 400
            ? JSON.stringify({ error: { message: `Rejected ${credential}`, code: credential } })
            : credential,
          { status, headers: { "x-request-id": credential } },
        );
      });

      const error = await send({
        ...defaults,
        headers: { authorization: `Bearer ${credential}` },
        fetchFn,
      }).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        message:
          status === 400
            ? `${errorLabel} failed (HTTP 400): Rejected *** [code=***] [request_id=***]`
            : `${errorLabel} failed: malformed JSON response`,
      });
      expect(inspect(error)).not.toContain(credential);
    },
  );
});
