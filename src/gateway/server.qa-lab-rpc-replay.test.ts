import { once } from "node:events";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startTestGatewayServer,
  testState,
  trackConnectChallengeNonce,
} from "./test-helpers.js";

// The public artifact crosses the plugin boundary without importing its compiler graph.
type QaGatewayFixture = {
  baseUrl: string;
  pid: number | null;
  call(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
};
const qaModule = "../../extensions/qa-lab/api.js";
const { createQaGatewayChild } = (await import(qaModule)) as {
  createQaGatewayChild(): {
    start(params: ReturnType<typeof gatewayOptions>): Promise<QaGatewayFixture>;
    stop(): Promise<{ process: string; errors: unknown[] }>;
  };
};
installGatewayTestHooks({ scope: "suite" });

type ProxySnapshot = { events: Array<{ kind: string; key?: string }> };
const dirs = createTempDirTracker();
const owner = createQaGatewayChild();
let child: Awaited<ReturnType<typeof owner.start>>;
let backend: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
let observer: WebSocket | undefined;
let childPid: number | null;
let token: string;
let claimHandedOff = false;

function gatewayOptions(root: string, claim: Awaited<ReturnType<typeof acquireTestPortBlock>>) {
  return {
    repoRoot: process.cwd(),
    providerMode: "mock-openai" as const,
    controlUiEnabled: false,
    transportBaseUrl: "http://127.0.0.1:1",
    command: {
      executablePath: process.execPath,
      argsPrefix: [
        path.resolve("test/fixtures/qa-gateway-rpc-proxy.mjs"),
        String(claim.port),
        process.cwd(),
        path.join(root, "proxy-events.jsonl"),
      ],
      tempParentDir: root,
      usePackagedPlugins: true,
    },
    onListening: async (context: { token: string }) => {
      token = context.token;
      testState.gatewayAuth = { mode: "token", token };
      vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", token);
      claimHandedOff = true;
      backend = await startTestGatewayServer(claim, { auth: { mode: "token", token } });
    },
  };
}

async function control(action = "snapshot"): Promise<ProxySnapshot> {
  const response = await fetch(`${child.baseUrl}/__fixture`, {
    method: "POST",
    headers: { "x-qa-fixture-token": token, "content-type": "application/json" },
    body: JSON.stringify({ action }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`proxy control failed: ${response.status}`);
  }
  return (await response.json()) as ProxySnapshot;
}

beforeAll(async () => {
  vi.stubEnv("OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN", undefined);
  vi.stubEnv("OPENCLAW_LIVE_SETUP_TOKEN_VALUE", undefined);
  const root = dirs.make("qa-rpc-replay-");
  const backendPortClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
  const backendPort = backendPortClaim.port;
  try {
    child = await owner.start(gatewayOptions(root, backendPortClaim));
  } finally {
    if (!claimHandedOff) {
      await backendPortClaim.release();
    }
  }
  childPid = child.pid;
  observer = new WebSocket(`ws://127.0.0.1:${backendPort}`);
  trackConnectChallengeNonce(observer);
  await once(observer, "open");
  await connectOk(observer, { token, scopes: ["operator.admin"] });
  // Family loading is fixture preparation, not the RPC's behavior deadline.
  await rpcReq(observer, "sessions.create", { displayName: "QA replay setup" }, 30_000);
  await rpcReq(observer, "sessions.describe", { key: "main" }, 30_000);
}, 180_000);

afterAll(async () => {
  const result = await owner
    .stop()
    .catch((error: unknown) => ({ process: "failed", errors: [error] }));
  if (observer) {
    await closeGatewayTestWebSocket(observer);
  }
  await backend?.close().catch((error: unknown) => result.errors.push(error));
  dirs.cleanup();
  vi.unstubAllEnvs();
  expect(result).toMatchObject({ process: "confirmed-stopped", errors: [] });
}, 30_000);

it("does not replay a committed create after losing its response", async () => {
  testState.gatewayAuth = { mode: "token", token };
  vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", token);
  await control("reset");
  await control("drop-response");
  const request = child.call(
    "sessions.create",
    { displayName: "QA replay lost response" },
    { timeoutMs: 10_000 },
  );
  await expect.soft(request).rejects.toThrow("gateway closed (1006");
  await expect.soft(request).rejects.not.toThrow("label already in use");
  const { events } = await control();
  const ofKind = (kind: string) => events.filter((event) => event.kind === kind);
  expect(ofKind("response-dropped")).toHaveLength(1);
  expect(child.pid).toBe(childPid);
  expect.soft(ofKind("mutation-request")).toHaveLength(1);
  const keys = ofKind("mutation-success").map((event) => event.key);
  expect.soft(keys).toHaveLength(1);
  for (const key of keys) {
    expect(typeof key).toBe("string");
    const read = await rpcReq<{ session: { key: string } | null }>(observer!, "sessions.describe", {
      key,
    });
    expect(read).toMatchObject({ ok: true, payload: { session: { key } } });
  }
});
