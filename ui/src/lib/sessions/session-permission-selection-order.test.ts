// @vitest-environment node
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createSessionCapability } from "./index.ts";
import { createGatewayHarness, sessionsResult } from "./session-capability.test-support.ts";
import { gatewayRequest, sessionRow, sessionSelection } from "./session-fixtures.test-support.ts";

it.each(["success", "dynamic"] as const)(
  "preserves a queued selection across a permission acknowledgment (%s)",
  async (outcome) => {
    const key = "agent:main:permission-selection";
    const sessionId = "permission-selection-generation";
    const initial = sessionsResult([sessionRow(key, { sessionId, permissionMode: "guarded" })]);
    const blocker = createDeferred<SessionsListResult>();
    const selected = createDeferred<SessionsListResult>();
    const queries: Array<unknown> = [];
    const entry = { sessionId, updatedAt: 2, permissionMode: "workspace" };
    const request = gatewayRequest({
      "sessions.patch": () => ({ ok: true, path: "(sessions)", key, entry }),
      "sessions.subscribe": () => ({ subscribed: true }),
      "sessions.list": (params) => {
        queries.push(asOptionalRecord(params)?.agentId);
        return queries.length === 1
          ? initial
          : queries.length === 2
            ? blocker.promise
            : selected.promise;
      },
    });
    const client = new GatewayBrowserClient({ url: "ws://gateway.example.test" });
    vi.spyOn(client, "request").mockImplementation(request);
    const harness = createGatewayHarness(client);
    const { state, select, ...selection } = sessionSelection();
    const sessions = createSessionCapability(harness.gateway, { state, ...selection });
    const pending: Array<Promise<unknown>> = [];
    onTestFinished(async () => {
      blocker.resolve(initial);
      selected.resolve(initial);
      await Promise.allSettled(pending);
      sessions.dispose();
    });
    harness.publish(true);
    await vi.waitFor(() => expect(sessions.state.result?.sessions[0]?.key).toBe(key));
    pending.push(sessions.refresh({ agentId: "main", force: true }));
    select("writer");
    if (outcome === "dynamic") {
      select("main");
    }
    const patch = sessions.patch(key, { permissionMode: "workspace" });
    pending.push(patch);
    await vi.waitFor(() =>
      expect(sessions.state.result?.sessions[0]?.permissionMode).toBe("workspace"),
    );
    if (outcome === "dynamic") {
      // The selection supplier is live when the queued request drains.
      state.selectedId = "writer";
      harness.emitEvent({
        type: "event",
        event: "session.message",
        payload: {
          ...initial.sessions[0],
          sessionKey: key,
          updatedAt: 3,
          permissionMode: "full",
          archived: false,
          hasActiveRun: true,
          status: "running",
        },
      });
    }
    blocker.resolve(initial);
    await vi.waitFor(() => expect(queries).toEqual(["main", "main", "writer"]));
    const expected =
      outcome === "success" ? { agentId: "writer" } : { error: "Writer roster unavailable" };
    if (outcome === "success") {
      selected.resolve(sessionsResult([{ key: "agent:writer:chat", kind: "direct" }], 3));
    } else {
      selected.reject(new Error("Writer roster unavailable"));
    }
    await Promise.all(pending);
    expect(sessions.state).toMatchObject({ loading: false, ...expected });
    await expect(patch).resolves.not.toHaveProperty("listRefreshError");
  },
);
