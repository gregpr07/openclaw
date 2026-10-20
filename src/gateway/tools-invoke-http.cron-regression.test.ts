import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestGatewayHttpServer } from "./http-server.test-support.js";

const TEST_GATEWAY_TOKEN = "test-gateway-token-1234567890";
let cfg: Record<string, unknown> = {};

vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => cfg }));
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => cfg }));

vi.mock("../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions.js")>();
  return {
    ...actual,
    resolveMainSessionKey: () => "agent:main:main",
  };
});

vi.mock("./auth.js", () => ({
  authorizeHttpGatewayConnect: async () => ({ ok: true as const }),
}));

vi.mock("../logger.js", () => ({ logWarn: () => {} }));

vi.mock("../agents/agent-tools.js", () => ({
  resolveToolLoopDetectionConfig: () => ({ warnAt: 3 }),
}));

vi.mock("../agents/agent-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: async ({ params }: { params: unknown }) => ({
    blocked: false as const,
    params,
  }),
}));

vi.mock("../plugins/config-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/config-state.js")>();
  return {
    ...actual,
    isTestDefaultMemorySlotDisabled: () => false,
  };
});

// mock-isolation: Exercise the HTTP denylist with inert automation and Gateway tools.
vi.mock("../agents/openclaw-tools.js", () => {
  const tools = ["automations", "gateway"].map((name) => ({
    name,
    parameters: { type: "object", properties: { action: { type: "string" } } },
    execute: async () => ({ ok: true, via: name }),
  }));
  return { createOpenClawToolsAsync: async () => tools };
});

const { handleToolsInvokeHttpRequest } = await import("./tools-invoke-http.js");

let url: string;
const server = createTestGatewayHttpServer((req, res) =>
  handleToolsInvokeHttpRequest(req, res, {
    auth: { mode: "token", token: TEST_GATEWAY_TOKEN, allowTailscale: false },
  }),
);
beforeAll(async () => {
  url = `http://127.0.0.1:${await server.listen()}/tools/invoke`;
});
afterAll(() => server.close());

async function invoke(tool: string, scopes = "operator.write") {
  return await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TEST_GATEWAY_TOKEN}`,
      "x-openclaw-scopes": scopes,
    },
    body: JSON.stringify({ tool, action: "status", args: {}, sessionKey: "main" }),
  });
}

it.each([
  {
    name: "defaults",
    config: {},
    checks: [
      ["gateway", 404],
      ["cron", 404],
    ],
  },
  {
    name: "normalized deny over canonical allow",
    config: { gateway: { tools: { allow: ["automations"], deny: [" CRON "] } } },
    checks: [["cron", 404]],
  },
  {
    name: "explicit cron allow under coding profile",
    config: { tools: { profile: "coding" }, gateway: { tools: { allow: ["cron"] } } },
    checks: [
      ["cron", 200],
      ["gateway", 404],
    ],
  },
] as const)("HTTP tool denylist: $name", async ({ config, checks }) => {
  cfg = config;
  for (const [tool, status] of checks) {
    const scopes = tool === "cron" ? "operator.admin" : "operator.write";
    expect((await invoke(tool, scopes)).status).toBe(status);
  }
});
