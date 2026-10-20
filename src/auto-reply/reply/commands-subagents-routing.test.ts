// Tests subagent inspection command routing and authorization.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { MsgContext } from "../templating.js";
import { handleAcpCommand } from "./commands-acp.js";
import { handleSubagentsCommand } from "./commands-subagents.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const readContextMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/subagents/registry/subagent-control-scope.js", () => ({
  buildControlledSubagentRunsReadContext: readContextMock,
}));

const formatAllowFrom = ({ allowFrom }: { allowFrom: Array<string | number> }) =>
  allowFrom.map((entry) => String(entry).trim()).filter(Boolean);

let previousPluginRegistry: ReturnType<typeof getActivePluginRegistry>;

function registerOwnerEnforcingTelegramPlugin() {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        plugin: {
          ...createOutboundTestPlugin({
            id: "telegram",
            outbound: { deliveryMode: "direct" },
          }),
          commands: { enforceOwnerForCommands: true },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
            resolveAllowFrom: () => ["*"],
            formatAllowFrom,
          },
        },
        source: "test",
      },
    ]),
  );
}

function buildParams(
  commandBody: string,
  ctxOverrides?: Record<string, unknown>,
): HandleCommandsParams {
  const params = buildCommandTestParams(
    commandBody,
    {},
    {
      SessionKey: "agent:main:main",
      ...ctxOverrides,
    },
  );
  const ctx = params.ctx;
  const sessionKey = ctx.SessionKey ?? "agent:main:main";
  const provider = ctx.Provider ?? "whatsapp";

  Object.assign(params.command, {
    isAuthorizedSender: true,
    senderIsOwner: true,
    senderId: "owner",
    ownerList: [],
    from: "test-user",
    to: "test-bot",
  });
  return Object.assign(params, {
    directives: {},
    sessionKey,
    workspaceDir: "/tmp/openclaw-commands-subagents",
    provider,
    model: "test-model",
  });
}

describe("subagents command dispatch", () => {
  beforeEach(() => {
    previousPluginRegistry = getActivePluginRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (previousPluginRegistry) {
      setActivePluginRegistry(previousPluginRegistry);
    } else {
      resetPluginRuntimeStateForTest();
    }
  });

  it("does not dispatch unrelated commands", async () => {
    expect(await handleSubagentsCommand(buildParams("/unknown"), true)).toBeNull();
    expect(readContextMock).not.toHaveBeenCalled();
  });

  it("shows steer help without reading session state", async () => {
    const params = buildParams("/subagents steer 1 continue", { SessionKey: "" });
    const result = await handleSubagentsCommand(params, true);
    expect(result?.reply?.text).toContain("/subagents list");
    expect(result?.reply?.text).toContain("/session unbind");
    expect(readContextMock).not.toHaveBeenCalled();
  });

  it("does not dispatch ACP lookalikes", async () => {
    expect(await handleAcpCommand(buildParams("/acpXYZ"), true)).toBeNull();
  });

  it("rejects native subagents commands from non-owner senders when the plugin enforces owner-only commands", async () => {
    registerOwnerEnforcingTelegramPlugin();
    const cfg = {
      commands: { allowFrom: { "*": ["*"] } },
      channels: { telegram: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const ctx = {
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      From: "telegram:999",
      SenderId: "999",
      CommandSource: "native",
      SessionKey: "agent:main:telegram:slash-session",
      CommandTargetSessionKey: "agent:main:telegram:target",
    } as MsgContext;
    const auth = resolveCommandAuthorization({ ctx, cfg, commandAuthorized: true });
    const params = buildParams("/subagents list", ctx as unknown as Record<string, unknown>);
    params.cfg = cfg;
    Object.assign(params.command, auth);

    const result = await handleSubagentsCommand(params, true);

    expect(auth.senderIsOwner).toBe(false);
    expect(auth.isAuthorizedSender).toBe(false);
    expect(result).toEqual({ shouldContinue: false });
    expect(readContextMock).not.toHaveBeenCalled();
  });
});
