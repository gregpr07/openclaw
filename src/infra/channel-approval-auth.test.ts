import { beforeEach, describe, expect, it, vi } from "vitest";
import { createResolvedApproverActionAuthAdapter } from "../plugin-sdk/approval-auth-helpers.js";
import type { ChannelApprovalKind } from "./approval-types.js";

const getChannelPluginMock = vi.hoisted(() => vi.fn());

vi.mock("../channels/plugins/index.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/index.js")>(
    "../channels/plugins/index.js",
  );
  return {
    ...actual,
    getChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
  };
});

import { resolveApprovalCommandAuthorization } from "./channel-approval-auth.js";

function authorize(
  overrides: Partial<Parameters<typeof resolveApprovalCommandAuthorization>[0]> = {},
) {
  return resolveApprovalCommandAuthorization({
    cfg: {},
    channel: "workspace",
    accountId: "work",
    senderId: "U123",
    kind: "exec",
    ...overrides,
  });
}

describe("resolveApprovalCommandAuthorization", () => {
  beforeEach(() => {
    getChannelPluginMock.mockReset();
  });

  it("allows commands by default when the channel has no approval override", async () => {
    expect(await authorize({ accountId: undefined })).toEqual({
      authorized: true,
      explicit: false,
    });
  });

  it("delegates to the channel approval override when present", async () => {
    getChannelPluginMock.mockReturnValue({
      approvalCapability: {
        authorizeActorAction: ({ approvalKind }: { approvalKind: ChannelApprovalKind }) =>
          approvalKind === "plugin"
            ? { authorized: false, reason: "plugin denied" }
            : { authorized: true },
      },
    });

    const actor = { channel: "guildchat", senderId: "123" };
    expect(await authorize(actor)).toEqual({ authorized: true, explicit: true });
    expect(await authorize({ ...actor, kind: "plugin" })).toEqual({
      authorized: false,
      reason: "plugin denied",
      explicit: true,
    });
  });

  it("rejects commands through an older channel capability with scoped plugin reviewers", async () => {
    const authorizeActorAction = vi.fn(() => ({ authorized: true }));
    getChannelPluginMock.mockReturnValue({ approvalCapability: { authorizeActorAction } });
    const cfg = {
      approvals: { plugin: { slack: { approvers: ["team:T11111111:user:U11111111"] } } },
    };

    expect(
      await authorize({
        cfg,
        channel: "slack",
        accountId: "default",
        senderId: "U22222222",
        kind: "plugin",
      }),
    ).toMatchObject({ authorized: false, explicit: true });
    expect(authorizeActorAction).not.toHaveBeenCalled();
  });

  it("keeps disabled approval availability implicit even when same-chat auth returns allow", async () => {
    const getActionAvailabilityState = vi.fn(() => ({ kind: "disabled" as const }));
    getChannelPluginMock.mockReturnValue({
      approvalCapability: {
        authorizeActorAction: () => ({ authorized: true }),
        getActionAvailabilityState,
      },
    });

    expect(await authorize()).toEqual({ authorized: true, explicit: false });
    expect(getActionAvailabilityState).toHaveBeenCalledWith({
      cfg: {},
      accountId: "work",
      action: "approve",
      approvalKind: "exec",
    });
  });

  it("keeps empty approver fallback implicit without bypassing channel sender auth", async () => {
    getChannelPluginMock.mockReturnValue({
      approvalCapability: createResolvedApproverActionAuthAdapter({
        channelLabel: "QuietChat",
        resolveApprovers: () => [],
      }),
    });

    expect(await authorize({ channel: "quietchat", senderId: "uuid:attacker" })).toEqual({
      authorized: true,
      explicit: false,
    });
  });
});
