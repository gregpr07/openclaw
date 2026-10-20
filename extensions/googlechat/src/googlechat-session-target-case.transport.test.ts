import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { text } from "node:stream/consumers";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const loopback = vi.hoisted(() => ({ baseUrl: "" }));
const requests = vi.hoisted(() => [] as Array<{ method: string; path: string; body: string }>);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    // Keep the real guarded fetch; only send it at the loopback origin.
    fetchWithSsrFGuard: (...[params]: Parameters<typeof actual.fetchWithSsrFGuard>) =>
      actual.fetchWithSsrFGuard({
        ...params,
        url: params.url.replace("https://chat.googleapis.com", loopback.baseUrl),
        policy: { allowPrivateNetwork: true },
      }),
  };
});

vi.mock("./auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.js")>()),
  getGoogleChatAccessToken: vi.fn(async () => "transport-proof-token"),
}));

import { googlechatPlugin } from "../api.js";

const CANONICAL_SPACE = "spaces/AAQA1bC2dEf";
const FOLDED_SPACE = "spaces/aaqa1bc2def";
const SESSION_KEY = `agent:main:googlechat:group:${FOLDED_SPACE}`;

let server: Server;

afterEach(clearRuntimeConfigSnapshot);

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const body = await text(request);
    const path = request.url ?? "";
    requests.push({ method: request.method ?? "", path, body });
    response.writeHead(200, { "content-type": "application/json" });
    if (request.method === "POST" && path.includes("/messages")) {
      const space = path.replace(/^\/v1\//, "").replace(/\/messages.*$/, "");
      response.end(JSON.stringify({ name: `${space}/messages/proof-1` }));
      return;
    }
    response.end(JSON.stringify({ name: path.replace(/^\/v1\//, ""), spaceType: "SPACE" }));
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  loopback.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  setActivePluginRegistry(createTestRegistry([]));
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

it("uses the session's mixed-case Google Chat space", async () => {
  await withOpenClawTestState({ prefix: "googlechat-session-target-" }, async (state) => {
    const account = {
      serviceAccount: '{"client_email":"bot@example.test","private_key":"key"}',
    };
    const config: OpenClawConfig = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      channels: { googlechat: { accounts: { default: account } } },
    };
    setRuntimeConfigSnapshot(config);

    await upsertSessionEntry({
      agentId: "main",
      env: process.env,
      sessionKey: SESSION_KEY,
      entry: {
        sessionId: "proof-session",
        updatedAt: Date.now(),
        delivery: {
          kind: "external",
          route: { channel: "googlechat", target: { to: `googlechat:${CANONICAL_SPACE}` } },
          context: { channel: "googlechat", to: `googlechat:${CANONICAL_SPACE}` },
          origin: { provider: "googlechat", to: `googlechat:${CANONICAL_SPACE}` },
        },
      },
    });

    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "googlechat", source: "test", origin: "bundled", plugin: googlechatPlugin },
      ]),
    );

    // The webchat caller has no explicit destination; use the stored canonical target.
    const tools = createOpenClawCodingTools({
      config,
      agentId: "main",
      sessionKey: SESSION_KEY,
      sessionId: "proof-session",
      messageProvider: "webchat",
      workspaceDir: state.workspaceDir,
    });
    const tool = tools.find((entry) => entry.name === "message");
    expect(tool, "message tool present in the harness tool list").toBeDefined();

    const result = await tool!.execute("proof-1", {
      action: "send",
      message: "session-derived reply",
    });

    const sends = requests.filter((entry) => entry.method === "POST");
    expect(result.details).toMatchObject({ ok: true, to: CANONICAL_SPACE });
    expect(sends.map(({ path, body }) => ({ path, body: JSON.parse(body) }))).toEqual([
      { path: `/v1/${CANONICAL_SPACE}/messages`, body: { text: "session-derived reply" } },
    ]);
  });
}, 60_000);
