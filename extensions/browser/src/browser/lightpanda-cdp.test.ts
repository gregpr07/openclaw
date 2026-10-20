import assert from "node:assert/strict";
import type { Browser, ConnectOverCDPTransport } from "playwright-core";
import { afterEach, expect, it, vi } from "vitest";
import { createLightpandaCdpNormalizer } from "./engines/lightpanda-cdp.js";
import { connectOverCdpTransport } from "./pw-session-cdp-transport.js";

const { connectMock } = vi.hoisted(() => ({
  connectMock: vi.fn<(transport: ConnectOverCDPTransport) => Promise<Browser>>(),
}));
vi.mock("./playwright-core.runtime.js", () => ({
  getPlaywrightCore: () => ({ chromium: { connectOverCDP: connectMock } }),
}));

afterEach(() => {
  vi.useRealTimers();
  connectMock.mockReset();
});

const attachedPage = {
  method: "Target.attachedToTarget",
  sessionId: "browser-session",
  params: { sessionId: "page-session", targetInfo: { type: "page", targetId: "page-one" } },
};
const targetCommand = (id: number, sessionId = "browser-session") => ({
  id,
  method: "Target.getTargets",
  sessionId,
});
const pageCommand = (id: number) => ({
  ...targetCommand(id, "page-session"),
  method: "Target.getTargetInfo",
});

it.each([undefined, "lightpanda"] as const)(
  "normalizes the observed protocol defect only for explicit engine %s",
  async (engine) => {
    vi.useFakeTimers();
    const sent: object[] = [];
    const received: object[] = [];
    const wire: ConnectOverCDPTransport = {
      send: (message) => sent.push(message),
      close: vi.fn(),
    };
    connectMock.mockResolvedValue({} as Browser);
    await connectOverCdpTransport("ws://127.0.0.1:9222", {
      engine,
      headers: {},
      timeout: 1000,
      preparedTransport: wire,
    });
    const connection = connectMock.mock.calls[0];
    assert(connection, "Playwright transport was not connected");
    const [client] = connection;
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Playwright exposes a transport callback, not EventTarget.
    client.onmessage = (message) => received.push(message);
    wire.onmessage?.(attachedPage);
    const syntheticStartup = {
      method: "Target.attachedToTarget",
      params: {
        sessionId: "STARTUP",
        targetInfo: { type: "page", targetId: "TID-STARTUP", browserContextId: "BID-STARTUP" },
      },
    };
    wire.onmessage?.(syntheticStartup);
    const command = pageCommand(41);
    client.send(command);
    const reply = { id: 41, result: { targetInfo: { targetId: "page-one" } } };
    wire.onmessage?.(reply);
    await vi.runAllTimersAsync();
    expect(sent).toEqual([
      engine === "lightpanda" ? { ...command, params: { targetId: "page-one" } } : command,
    ]);
    expect(received).toEqual([
      attachedPage,
      ...(engine === "lightpanda" ? [] : [syntheticStartup]),
      engine === "lightpanda" ? { ...reply, sessionId: "page-session" } : reply,
    ]);
  },
);

it("correlates concurrent replies by request and preserves explicit routing", () => {
  const normalize = createLightpandaCdpNormalizer();
  normalize.receive(attachedPage);
  expect(
    normalize.send({
      ...pageCommand(1),
      params: { targetId: "explicit-target" },
    }),
  ).toMatchObject({ params: { targetId: "explicit-target" } });
  normalize.send(targetCommand(2));
  const reply = { id: 2, result: {} };
  expect(normalize.receive(reply)).toEqual({ ...reply, sessionId: "browser-session" });
  const error = { id: 1, error: { message: "not found" } };
  expect(normalize.receive(error)).toEqual({ ...error, sessionId: "page-session" });
  expect(normalize.receive({ id: 1, result: {} })).toEqual({ id: 1, result: {} });
  normalize.send(targetCommand(3));
  const routed = { id: 3, result: {}, sessionId: "engine-session" };
  expect(normalize.receive(routed)).toEqual(routed);
});

it("forgets detached targets and all state when the connection closes", () => {
  const normalize = createLightpandaCdpNormalizer();
  normalize.receive(attachedPage);
  normalize.receive({
    method: "Target.detachedFromTarget",
    params: { sessionId: "page-session" },
  });
  const command = pageCommand(1);
  expect(normalize.send(command)).toBe(command);
  normalize.receive(attachedPage);
  normalize.clear();
  expect(normalize.receive({ id: 1, result: {} })).toEqual({ id: 1, result: {} });
  expect(normalize.send({ ...command, id: 2 })).not.toHaveProperty("params");
});

it("bounds unanswered target requests instead of retaining them indefinitely", () => {
  const normalize = createLightpandaCdpNormalizer();
  for (let id = 1; id <= 4096; id += 1) {
    normalize.send(targetCommand(id));
  }
  expect(() => normalize.send(targetCommand(4097))).toThrow("too many unanswered target commands");
  normalize.receive({ id: 1, result: {} });
  expect(() => normalize.send(targetCommand(4097))).not.toThrow();
});
