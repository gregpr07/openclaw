import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GatewayClient,
  GatewayClientRequestTimeoutError,
} from "../../packages/gateway-client/src/client.js";
import type { GatewayProtocolSocket } from "../../packages/gateway-client/src/protocol-client.js";
import type { RequestFrame } from "../../packages/gateway-protocol/src/schema/frames.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createAgentDatabaseInspectionRefusal,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { authorizationClient } from "./server-methods.authorization.test-support.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestContext, GatewayRequestHandler } from "./server-methods/types.js";

type ProtocolHarness = {
  handleMessage(socket: GatewayProtocolSocket, generation: number, raw: string): void;
};

const methods = ["sessions.create", "agent", "chat.send", "sessions.send"] as const;

const fixtures: Array<{ dispose(): Promise<void> }> = [];
const tempDirs = createTempDirTracker();

function createFixture(method: (typeof methods)[number]) {
  const reachedAdmission = createDeferred();
  const connection = new AbortController();
  const preparation = createDeferred();
  let pending = true;
  const cfg: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { main: {} } },
  };
  recordAgentDatabaseAdmissions(
    [
      createAgentDatabaseInspectionRefusal({
        agentId: "main",
        paths: [],
        reason: "Synthetic startup inspection is pending.",
        pending: true,
      }),
    ],
    { source: "startup" },
  );
  const context = {
    getRuntimeConfig: () => cfg,
    logGateway: { warn: vi.fn(), info: vi.fn() },
    agentDatabaseStartup: {
      get hasPendingAgents() {
        return pending;
      },
      waitForAgentPreparation: () => {
        reachedAdmission.resolve();
        return pending ? preparation.promise : undefined;
      },
    },
  };
  const writes: RequestFrame[] = [];
  const handler: GatewayRequestHandler = ({ req, respond }) => {
    writes.push(req);
    respond(true, { status: "written" });
  };
  const client = new GatewayClient({});
  const protocol = (client as unknown as { protocol: ProtocolHarness }).protocol;
  const sent: string[] = [];
  const active = new Set<Promise<void>>();
  const errors: unknown[] = [];
  const socket: GatewayProtocolSocket = {
    isOpen: () => true,
    close: () => {},
    send: (raw) => {
      sent.push(raw);
      const req = JSON.parse(raw) as RequestFrame;
      const work = handleGatewayRequest({
        req,
        client: authorizationClient(
          "startup-deadline",
          ["operator.admin"],
          { connectionSignal: connection.signal },
          { client: { id: "cli", version: "test", platform: "linux", mode: "cli" } },
        ),
        signal: connection.signal,
        isWebchatConnect: () => false,
        context: context as unknown as GatewayRequestContext,
        extraHandlers: { [method]: handler },
        respond: (ok, payload, error) => {
          reachedAdmission.resolve();
          protocol.handleMessage(
            socket,
            1,
            JSON.stringify({ type: "res", id: req.id, ok, payload, error }),
          );
        },
      }).catch((error: unknown) => {
        errors.push(error);
      });
      active.add(work);
      void work.then(() => active.delete(work));
    },
  };
  Object.assign(protocol, { socket, stopped: false, generation: 1 });
  const fixture = {
    client,
    sent,
    writes,
    reachedAdmission: reachedAdmission.promise,
    params: {
      agentId: "main",
      message: "Synthetic request",
      idempotencyKey: "startup-write",
      ...(method === "chat.send" ? { sessionKey: "agent:main:test" } : {}),
      ...(method === "sessions.send" ? { key: "agent:main:test" } : {}),
    },
    ready() {
      pending = false;
      recordAgentDatabaseAdmissions([], { source: "startup" });
      preparation.resolve();
    },
    async drain() {
      await Promise.all(active);
      if (errors.length > 0) {
        throw new AggregateError(errors, "Synthetic Gateway request failed");
      }
    },
    async dispose() {
      client.stop();
      connection.abort();
      fixture.ready();
      await Promise.allSettled(active);
    },
  };
  fixtures.push(fixture);
  return fixture;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("gateway-startup-deadline-"));
});

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  recordAgentDatabaseAdmissions([], { source: "startup" });
  vi.unstubAllEnvs();
  vi.useRealTimers();
  tempDirs.cleanup();
});

describe("startup write deadlines through GatewayClient and the request router", () => {
  it.each(
    ([false, true] as const).flatMap((abort) => methods.map((method) => ({ method, abort }))),
  )(
    "never dispatches $method after startup cancellation (abort=$abort)",
    async ({ method, abort }) => {
      const fixture = createFixture(method);
      const controller = new AbortController();
      const outcome = fixture.client
        .request(
          method,
          fixture.params,
          abort ? { timeoutMs: 60_000, signal: controller.signal } : undefined,
        )
        .catch((error: unknown) => error);
      await fixture.reachedAdmission;
      await vi.advanceTimersByTimeAsync(abort ? 35_000 : 30_000);
      if (abort) {
        controller.abort();
        expect(await outcome).toMatchObject({ message: `gateway request aborted for ${method}` });
      } else {
        expect(await outcome).toBeInstanceOf(GatewayClientRequestTimeoutError);
        expect(fixture.writes).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(15_000);
      }
      fixture.ready();
      await fixture.drain();
      await vi.advanceTimersByTimeAsync(abort ? 30_000 : 1_000);
      expect(fixture.writes).toHaveLength(0);
    },
  );

  it.each(["sessions.create", "agent"] as const)(
    "waits for 45-second startup and dispatches %s exactly once",
    async (method) => {
      const fixture = createFixture(method);
      const request = fixture.client.request(method, fixture.params, { timeoutMs: 60_000 });
      const outcome = request.catch((error: unknown) => error);
      const settled = vi.fn();
      void outcome.then(settled);
      await fixture.reachedAdmission;
      await vi.advanceTimersByTimeAsync(45_000);
      expect(settled).not.toHaveBeenCalled();
      expect(fixture.writes).toHaveLength(0);
      fixture.ready();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(outcome).resolves.toEqual({ status: "written" });
      await fixture.drain();
      expect(fixture.writes).toHaveLength(1);
      expect(fixture.sent.length).toBeGreaterThan(1);
      expect(new Set(fixture.sent).size).toBe(1);
      expect(fixture.writes[0]).toMatchObject({
        params: { idempotencyKey: "startup-write" },
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fixture.writes).toHaveLength(1);
    },
  );
});
