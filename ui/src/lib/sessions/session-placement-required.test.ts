import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  readSessionPlacementRecovery,
  writeSessionPlacementRecovery,
  type SessionPlacementRecovery,
} from "./session-placement-recovery.ts";
import { startSessionPlacementInitialTurn } from "./session-placement-startup.ts";
import { advanceSessionPlacementDraft } from "./session-placement-submit.ts";

const target = { kind: "profile", profileId: "dedicated", required: true } as const;
const catalog = {
  sessionPlacement: { requiredProfile: { id: target.profileId, providerId: "device" } },
};
const params = {
  key: "agent:main:required",
  agentId: "main",
  target,
  message: "Inspect workspace",
  messageId: "first-turn",
  mode: "dispatch" as const,
};
function clientWith(
  request: ReturnType<typeof vi.fn>,
): Parameters<typeof startSessionPlacementInitialTurn>[0] {
  const client = { request: request as GatewayBrowserClient["request"] };
  return {
    client,
    describe: (requestParams, options) => {
      expect(options?.client).toBe(client);
      return client.request("sessions.describe", requestParams);
    },
  };
}
const methods = (request: ReturnType<typeof vi.fn>) => request.mock.calls.map(([method]) => method);
const started = { status: "started", messageId: "first-turn" };
const start = (
  request: ReturnType<typeof vi.fn>,
  mode: Parameters<typeof startSessionPlacementInitialTurn>[1]["mode"] = "dispatch",
  current = () => true,
) => startSessionPlacementInitialTurn(clientWith(request), { ...params, mode }, current);
function placementRequest(state: () => string) {
  return vi.fn(async (method: string) =>
    method === "agents.list"
      ? catalog
      : method === "sessions.describe"
        ? { session: { placement: { state: state() } } }
        : { runId: "first-turn", status: "started" },
  );
}
function restore(overrides: Partial<SessionPlacementRecovery>) {
  const recovery: SessionPlacementRecovery = {
    sessionKey: params.key,
    agentId: params.agentId,
    target,
    message: params.message,
    messageId: params.messageId,
    gatewayUrl: "ws://gateway.example",
    recoveryScope: "principal",
    phase: "sending",
    ...overrides,
  };
  expect(writeSessionPlacementRecovery(recovery)).toBe(true);
  return readSessionPlacementRecovery(
    recovery.gatewayUrl,
    recovery.recoveryScope,
    recovery.sessionKey,
  )!;
}
afterEach(() => {
  vi.useRealTimers();
  sessionStorage.clear();
});

it.each([
  ["provisioning", "dispatch"],
  ["failed", "retry"],
  ["reclaimed", "retry"],
  ["local", "retry"],
] as const)("starts required %s placement via %s without admin dispatch", async (initial, mode) => {
  vi.useFakeTimers();
  let state: string = initial;
  const request = placementRequest(() => state);
  const pending = start(request, mode);
  if (initial === "provisioning") {
    await vi.advanceTimersByTimeAsync(0);
    expect(methods(request)).toEqual(["agents.list", "sessions.describe"]);
    state = "active";
    await vi.advanceTimersByTimeAsync(250);
  }
  expect(await pending).toEqual(started);
  expect(methods(request)).toEqual(
    initial === "provisioning"
      ? ["agents.list", "sessions.describe", "sessions.describe", "sessions.send"]
      : ["agents.list", "sessions.describe", "sessions.send"],
  );
});

it.each([undefined, "replacement"])(
  "does not send or dispatch when the required policy changes to %s",
  async (requiredProfile) => {
    const request = vi.fn(async () => ({
      sessionPlacement: {
        requiredProfile: requiredProfile
          ? { id: requiredProfile, providerId: "device" }
          : undefined,
      },
    }));
    expect(await start(request)).toMatchObject({ status: "dispatch-rejected" });
    expect(request.mock.calls).toHaveLength(1);
  },
);

it("Stop fences a late active placement reply and retains the existing reclaim owner", async () => {
  const active = createDeferred<unknown>();
  const read = createDeferred();
  let current = true;
  const request = vi.fn(async (method: string) => {
    if (method === "agents.list") {
      return catalog;
    }
    if (method === "sessions.describe") {
      read.resolve();
      return active.promise;
    }
    return {};
  });
  const pending = start(request, "dispatch", () => current);
  await read.promise;
  current = false;
  active.resolve({ session: { placement: { state: "active" } } });
  expect(await pending).toEqual({ status: "cancelled" });
  expect(methods(request)).toEqual(["agents.list", "sessions.describe", "sessions.reclaim"]);
});

it("restores a required target and reconciles uncertain delivery without a duplicate send", async () => {
  const restored = restore({});
  expect(restored.target).toEqual(target);
  const request = vi.fn(async (_method: string) => ({ messages: [] }));
  const result = await advanceSessionPlacementDraft({
    ...clientWith(request),
    recovery: restored,
    mode: "recover",
    isLifecycleCurrent: () => true,
    ownsRecovery: () => true,
    clearRecovery: vi.fn(),
    setRecoveryPhase: vi.fn(),
    cleanupOnCancellation: () => false,
  });
  expect(result).toMatchObject({ status: "paused", recovery: { reason: "unconfirmed", target } });
  expect(methods(request)).toEqual(["chat.history"]);
});

it("retains an explicit native runtime while a required create is restored", () => {
  const createParams: SessionPlacementRecovery["createParams"] = {
    key: params.key,
    agentId: params.agentId,
    message: "",
    model: "openai/available-model",
    agentRuntime: "openclaw",
    worktree: true,
    worktreeSource: "empty",
  };
  expect(restore({ phase: "creating", createParams }).createParams).toEqual(createParams);
});
