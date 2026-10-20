import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime, RuntimeEnv } from "../../../runtime-api.js";
import { setMatrixRuntime } from "../../runtime.js";
import type { MatrixConfig } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { registerMatrixAutoJoin } from "./auto-join.js";
import { createMatrixMonitorTaskRunner } from "./task-runner.js";

type InviteHandler = (roomId: string, inviteEvent: unknown) => void;
const aliasConfig: MatrixConfig = {
  autoJoin: "allowlist",
  autoJoinAllowlist: ["#allowed:example.org"],
};
const runtime = (error = vi.fn()) => ({ log: vi.fn(), error }) as unknown as RuntimeEnv;
const taskRunner = () =>
  createMatrixMonitorTaskRunner({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    logVerboseMessage: vi.fn(),
  });

async function flushInviteTasks() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

function createClientStub() {
  let inviteHandler: InviteHandler | null = null;
  const mocks = {
    on: vi.fn((eventName: string, listener: unknown) => {
      if (eventName === "room.invite") {
        inviteHandler = listener as InviteHandler;
      }
      return client;
    }),
    off: vi.fn((eventName: string, listener: unknown) => {
      if (eventName === "room.invite" && inviteHandler === listener) {
        inviteHandler = null;
      }
      return client;
    }),
    joinRoom: vi.fn(async () => {}),
    resolveRoom: vi.fn<MatrixClient["resolveRoom"]>(async () => null),
  };
  const client: MatrixClient = mocks as unknown as MatrixClient;
  return { ...mocks, client, getInviteHandler: () => inviteHandler };
}

function registerAutoJoinHarness(params: {
  accountConfig?: MatrixConfig;
  resolveRoomValue?: string | null;
  resolveRoomValues?: Array<string | null>;
  error?: ReturnType<typeof vi.fn>;
}) {
  const harness = createClientStub();
  const runDetachedTask = vi.fn((_label: string, task: () => Promise<void>) =>
    Promise.resolve().then(task),
  );
  if (params.resolveRoomValues) {
    for (const value of params.resolveRoomValues) {
      harness.resolveRoom.mockResolvedValueOnce(value);
    }
  } else if (params.resolveRoomValue !== undefined) {
    harness.resolveRoom.mockResolvedValue(params.resolveRoomValue);
  }

  const dispose = registerMatrixAutoJoin({
    client: harness.client,
    accountConfig: params.accountConfig ?? {},
    runtime: runtime(params.error),
    runDetachedTask,
  });

  return { ...harness, dispose, runDetachedTask };
}

async function triggerInvite(
  getInviteHandler: () => InviteHandler | null,
  inviteEvent: unknown = {},
) {
  const inviteHandler = getInviteHandler();
  if (!inviteHandler) {
    throw new Error("expected Matrix invite handler");
  }
  inviteHandler("!room:example.org", inviteEvent);
  await flushInviteTasks();
}

const loggerWarn = vi.fn();

describe("registerMatrixAutoJoin", () => {
  beforeEach(() => {
    loggerWarn.mockReset();
    setMatrixRuntime({
      logging: {
        shouldLogVerbose: () => false,
        getChildLogger: () => ({ info: vi.fn(), warn: loggerWarn, error: vi.fn() }),
      },
    } as unknown as PluginRuntime);
  });

  it("does not auto-join invites by default", () => {
    const { getInviteHandler, joinRoom } = registerAutoJoinHarness({});

    expect(getInviteHandler()).toBeNull();
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it("retries alias resolution after an unresolved lookup", async () => {
    const { getInviteHandler, joinRoom, resolveRoom } = registerAutoJoinHarness({
      accountConfig: aliasConfig,
      resolveRoomValues: [null, "!room:example.org"],
    });

    await triggerInvite(getInviteHandler);
    await triggerInvite(getInviteHandler);

    expect(resolveRoom).toHaveBeenCalledTimes(2);
    expect(joinRoom).toHaveBeenCalledWith("!room:example.org");
  });

  it("does not join when the originating monitor retires during alias lookup", async () => {
    vi.useFakeTimers();
    const harness = createClientStub();
    const releaseLookup = createDeferred<void>();
    harness.resolveRoom.mockReturnValue(releaseLookup.promise.then(() => "!room:example.org"));
    const retired = taskRunner();
    const active = taskRunner();
    const register = (runner: ReturnType<typeof taskRunner>) =>
      registerMatrixAutoJoin({
        client: harness.client,
        accountConfig: aliasConfig,
        runtime: runtime(),
        runDetachedTask: runner.runDetachedTask,
      });
    register(retired);
    await triggerInvite(harness.getInviteHandler);
    expect(harness.resolveRoom).toHaveBeenCalled();
    const idle = retired.waitForIdle();
    await vi.advanceTimersByTimeAsync(30_000);
    await idle;
    releaseLookup.resolve();
    await flushInviteTasks();
    expect(harness.joinRoom).not.toHaveBeenCalled();

    harness.resolveRoom.mockResolvedValue("!room:example.org");
    register(active);
    await triggerInvite(harness.getInviteHandler);
    expect(harness.joinRoom).toHaveBeenCalledWith("!room:example.org");
    retired.close();
    active.close();
    vi.useRealTimers();
  });

  it("logs and skips allowlist alias resolution failures", async () => {
    const error = vi.fn();
    const { getInviteHandler, joinRoom, resolveRoom } = registerAutoJoinHarness({
      accountConfig: aliasConfig,
      error,
    });
    resolveRoom.mockRejectedValue(new Error("temporary homeserver failure"));

    await triggerInvite(getInviteHandler);

    expect(joinRoom).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "matrix: failed resolving allowlisted alias #allowed:example.org: Error: temporary homeserver failure",
    );
  });

  it("does not trust room-provided alias claims for allowlist joins", async () => {
    const { getInviteHandler, joinRoom } = registerAutoJoinHarness({
      accountConfig: aliasConfig,
      resolveRoomValue: "!different-room:example.org",
    });

    await triggerInvite(getInviteHandler);
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it("removes the exact invite listener on disposal", async () => {
    const { dispose, getInviteHandler, joinRoom, off, runDetachedTask } = registerAutoJoinHarness({
      accountConfig: {
        autoJoin: "always",
      },
    });
    const listener = getInviteHandler();
    if (!listener) {
      throw new Error("expected Matrix invite handler");
    }

    dispose();

    expect(off).toHaveBeenCalledWith("room.invite", listener);
    expect(getInviteHandler()).toBeNull();
    expect(runDetachedTask).not.toHaveBeenCalled();
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it("does not warn for room, alias, or wildcard allowlist entries", () => {
    registerAutoJoinHarness({
      accountConfig: {
        autoJoin: "allowlist",
        autoJoinAllowlist: ["!room:example.org", "#alias:example.org", "*"],
      },
    });

    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it("ignores an unmatchable user-ID allowlist entry without joining", async () => {
    const { getInviteHandler, joinRoom } = registerAutoJoinHarness({
      accountConfig: {
        autoJoin: "allowlist",
        autoJoinAllowlist: ["@ryan:example.org"],
      },
    });

    await triggerInvite(getInviteHandler, { sender: "@ryan:example.org" });

    expect(joinRoom).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith(
      "matrix: autoJoinAllowlist entries cannot match an invited room and are ignored: @ryan:example.org",
    );
  });
});
