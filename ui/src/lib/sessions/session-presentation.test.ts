import { expect, it, onTestFinished } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createSessionCapability } from "./index.ts";
import { createGatewayHarness, sessionsResult } from "./session-capability.test-support.ts";
import { gatewayRequest, sessionRow, sessionSelection } from "./session-fixtures.test-support.ts";

const row = sessionRow("agent:main:dashboard:museum", {
  sessionId: "museum-session",
  derivedTitle: "Museum itinerary",
});

function harness() {
  let result: SessionsListResult | Promise<SessionsListResult> = sessionsResult([row], 1);
  const client = createTestGatewayClient(
    gatewayRequest({
      "sessions.list": () => result,
      "sessions.subscribe": () => ({ subscribed: true }),
    }),
  );
  const source = createGatewayHarness(client, undefined, {
    selfUser: { id: "one" },
    initial: {
      hello: {
        ...gatewayHelloForMethods([]),
        auth: { method: "token", role: "operator", scopes: ["operator.admin"] },
      },
    },
  });
  const selection = sessionSelection();
  const gateway = Object.assign(source.gateway, {
    connection: { gatewayUrl: "ws://museum.test", token: "synthetic-test-token" },
    connectionRevision: 0,
  });
  const sessions = createSessionCapability(gateway, selection);
  let finishRead: (() => void) | undefined;
  onTestFinished(() => {
    finishRead?.();
    sessions.dispose();
  });
  return {
    sessions,
    gateway,
    client,
    refreshWith(next: SessionsListResult) {
      result = next;
      return sessions.refresh({ agentId: "main", force: true });
    },
    defer(fallback = sessionsResult([], 2)) {
      const deferred = createDeferred<SessionsListResult>();
      result = deferred.promise;
      finishRead = () => deferred.resolve(fallback);
      return deferred;
    },
    publish: source.update,
    select: selection.select,
  };
}

it("presents accepted history while the first canonical roster is pending", async () => {
  const h = harness();
  h.defer(sessionsResult([row], 1));
  h.publish({ phase: "reconnecting", client: null });
  h.publish({ phase: "connected", client: h.client });
  h.sessions.reconcile(row);
  expect(h.sessions.canonicalListRevision).toBe(0);
  expect(h.sessions.presentation.result?.sessions[0]?.derivedTitle).toBe(row.derivedTitle);
});

it("notifies subscribers immediately when a connected profile changes before refresh", async () => {
  const h = harness();
  await h.sessions.refresh({ agentId: "main" });
  h.defer();
  const observed: Array<SessionsListResult | null> = [];
  h.sessions.subscribe(() => observed.push(h.sessions.presentation.result));
  h.publish({ phase: "connected", selfUser: { id: "two" } });
  expect(h.sessions.captureBootRoster()).toBeNull();
  expect(observed.length).toBeGreaterThan(0);
  expect(observed.every((result) => result === null)).toBe(true);
});

it("retains the paired roster through reconnect partial reads, then accepts canonical changes", async () => {
  const h = harness();
  await h.sessions.refresh({ agentId: "main" });
  const title = () => h.sessions.presentation.result?.sessions[0]?.derivedTitle;
  const presentation = h.sessions.presentation;
  const reconnect = h.defer(sessionsResult([], 5));
  h.publish({ phase: "reconnecting" });
  expect(h.sessions.state.result).toBeNull();
  expect(h.sessions.presentation).toBe(presentation);
  h.publish({ phase: "connected" });
  h.sessions.reconcile({ ...row, derivedTitle: "Partial" });
  expect(h.sessions.presentation).toBe(presentation);
  const renamed = sessionsResult([{ ...row, derivedTitle: "Renamed" }], 2);
  reconnect.resolve(renamed);
  await expect.poll(title).toBe("Renamed");
  expect(h.sessions.presentation.agentId).toBe("main");
  await h.refreshWith(sessionsResult([{ ...row, derivedTitle: "" }], 3));
  expect(title()).toBe("");
  await h.refreshWith(sessionsResult([], 4));
  expect(h.sessions.presentation.result?.sessions).toEqual([]);
});

it.each(["credential", "gateway", "profile", "selection", "dispose"] as const)(
  "retires retained metadata for %s before listeners can read it",
  async (boundary) => {
    const h = harness();
    await h.sessions.refresh({ agentId: "main" });
    h.defer();
    h.publish({ phase: "reconnecting" });
    const observed: Array<SessionsListResult | null> = [];
    h.sessions.subscribe(() => observed.push(h.sessions.presentation.result));
    if (boundary === "credential") {
      h.gateway.connectionRevision += 1;
      h.publish({});
    } else if (boundary === "gateway") {
      h.gateway.connection.gatewayUrl = "ws://other.test";
      h.publish({});
    } else if (boundary === "profile") {
      h.publish({ phase: "connected", selfUser: { id: "two" } });
    } else if (boundary === "selection") {
      h.select("writer");
    } else {
      h.sessions.dispose();
    }
    expect(h.sessions.presentation).toEqual({ result: null, agentId: null });
    expect(observed.every((result) => result === null)).toBe(true);
  },
);
