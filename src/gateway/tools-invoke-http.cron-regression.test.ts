import { createServer } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";

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
const server = createServer((req, res) => {
  void (async () => {
    const handled = await handleToolsInvokeHttpRequest(req, res, {
      auth: { mode: "token", token: TEST_GATEWAY_TOKEN, allowTailscale: false },
    });
    if (handled) {
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  })().catch((err: unknown) => {
    res.statusCode = 500;
    res.end(String(err));
  });
});
beforeAll(async () => {
  url = `${await listenLoopback(server)}/tools/invoke`;
});
afterAll(() => closeHttpServer(server));

beforeEach(() => {
  cfg = {};
});

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

describe("tools invoke HTTP denylist", () => {
  it("blocks cron and gateway by default", async () => {
    const gatewayRes = await invoke("gateway");
    const cronRes = await invoke("cron", "operator.admin");

    expect(gatewayRes.status).toBe(404);
    expect(cronRes.status).toBe(404);
  });

  it("keeps a normalized deny authoritative over a canonical allow", async () => {
    cfg = { gateway: { tools: { allow: ["automations"], deny: [" CRON "] } } };

    const cronRes = await invoke("cron", "operator.admin");

    expect(cronRes.status).toBe(404);
  });

  it("keeps gateway denied under the coding profile while honoring explicit cron allow", async () => {
    cfg = { tools: { profile: "coding" }, gateway: { tools: { allow: ["cron"] } } };

    const cronRes = await invoke("cron", "operator.admin");
    const gatewayRes = await invoke("gateway");

    expect(cronRes.status).toBe(200);
    expect(gatewayRes.status).toBe(404);
  });
});
