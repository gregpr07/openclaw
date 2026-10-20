import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it } from "vitest";
import { setMatrixRuntime } from "../../runtime.js";
import {
  resolveMatrixMonitorAccessState,
  resolveMatrixMonitorCommandAccess,
} from "./access-state.js";

beforeEach(() => {
  setMatrixRuntime(createPluginRuntimeMock());
});

function resolveAccess(overrides: Partial<Parameters<typeof resolveMatrixMonitorAccessState>[0]>) {
  return resolveMatrixMonitorAccessState({
    allowFrom: [],
    storeAllowFrom: [],
    groupAllowFrom: [],
    roomUsers: [],
    senderId: "@alice:example.org",
    isRoom: true,
    ...overrides,
  });
}

async function expectBlockedCommand(
  state: Parameters<typeof resolveMatrixMonitorCommandAccess>[0],
) {
  expect(
    await resolveMatrixMonitorCommandAccess(state, {
      useAccessGroups: true,
      allowTextCommands: true,
      hasControlCommand: true,
    }),
  ).toMatchObject({ authorized: false, shouldBlockControlCommand: true });
}

describe("resolveMatrixMonitorAccessState", () => {
  it("normalizes group allowlists and uses shared ingress matching", async () => {
    const state = await resolveAccess({
      allowFrom: ["matrix:@Alice:Example.org"],
      storeAllowFrom: ["user:@bob:example.org"],
      groupAllowFrom: ["@Carol:Example.org"],
      roomUsers: ["user:@Dana:Example.org"],
      senderId: "@Dana:Example.org",
      groupPolicy: "allowlist",
    });

    expect(state.effectiveGroupAllowFrom).toEqual(["@Carol:Example.org"]);
    expect(state.effectiveRoomUsers).toEqual(["user:@Dana:Example.org"]);
    expect(state.messageIngress.ingress.decision).toBe("allow");
  });

  it.each([
    { isRoom: false, allowFrom: ["@\u212A:example.org"], groupAllowFrom: [] },
    { isRoom: true, allowFrom: [], groupAllowFrom: ["@\u212A:example.org"] },
  ])("rejects case-folding collisions at ingress and command gates", async (params) => {
    const state = await resolveAccess({
      ...params,
      senderId: "@k:example.org",
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
    });

    expect(state.messageIngress.ingress.decision).toBe("block");
    await expectBlockedCommand(state);
  });

  it("does not let DM pairing-store entries authorize room control commands", async () => {
    const state = await resolveAccess({
      storeAllowFrom: ["@attacker:example.org"],
      senderId: "@attacker:example.org",
    });

    await expectBlockedCommand(state);
  });

  it("does not let pairing-store entries authorize open DMs without wildcard", async () => {
    const state = await resolveAccess({
      storeAllowFrom: ["@alice:example.org"],
      dmPolicy: "open",
      isRoom: false,
    });

    expect(state.messageIngress.senderAccess.effectiveAllowFrom).toEqual([]);
    expect(state.messageIngress.senderAccess.decision).toBe("block");
    expect(state.messageIngress.ingress.reasonCode).toBe("dm_policy_not_allowlisted");
  });

  it("does not let configured DM allowFrom authorize room control commands", async () => {
    const state = await resolveAccess({
      allowFrom: ["@owner:example.org"],
      groupAllowFrom: ["@admin:example.org"],
      senderId: "@owner:example.org",
    });

    await expectBlockedCommand(state);
  });

  it("treats unresolved configured room allowlists as configured but nonmatching", async () => {
    const groupState = await resolveAccess({
      groupAllowFrom: ["Alice"],
      groupPolicy: "allowlist",
    });
    const roomState = await resolveAccess({
      roomUsers: ["Dana"],
      senderId: "@dana:example.org",
      groupPolicy: "open",
    });

    expect(groupState.effectiveGroupAllowFrom).toEqual(["alice"]);
    expect(groupState.messageIngress.ingress.decision).toBe("block");
    expect(groupState.messageIngress.ingress.reasonCode).toBe("group_policy_not_allowlisted");
    expect(roomState.effectiveRoomUsers).toEqual(["dana"]);
    expect(roomState.messageIngress.ingress.decision).toBe("block");
    expect(roomState.messageIngress.ingress.reasonCode).toBe("group_policy_not_allowlisted");
    await expectBlockedCommand(groupState);
    await expectBlockedCommand(roomState);
  });

  it("keeps room-user allowlists out of dm traffic", async () => {
    const state = await resolveAccess({
      groupAllowFrom: ["@carol:example.org"],
      roomUsers: ["@dana:example.org"],
      senderId: "@dana:example.org",
      isRoom: false,
    });

    expect(state.messageIngress.senderAccess.decision).toBe("pairing");
    await expectBlockedCommand(state);
  });
});
