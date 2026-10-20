import fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { resetDiagnosticRunActivityForTest } from "../logging/diagnostic-run-activity.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";
import {
  runBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import type { ExtensionContext } from "./sessions/index.js";
import type { AnyAgentTool } from "./tools/common.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
import { callGatewayTool } from "./tools/gateway.js";

const hookRunner = vi.hoisted(() => ({
  hasHooks: vi.fn(),
  runBeforeToolCall: vi.fn(),
}));
vi.mock("../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => hookRunner }));
vi.mock("./tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));
const mockCallGateway = vi.mocked(callGatewayTool);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function requireApproval(pluginId?: string) {
  hookRunner.runBeforeToolCall.mockResolvedValue({
    requireApproval: { title: "Review diff", description: "Review selected tool call", pluginId },
  });
}

function approvalChannel(
  id: string,
  label: string,
  approvalCapability: NonNullable<ChannelPlugin["approvalCapability"]>,
) {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: id,
        source: "test",
        plugin: { ...createChannelTestPluginBase({ id, label }), approvalCapability },
      },
    ]),
  );
}

beforeEach(() => {
  setRuntimeConfigSnapshot({});
  resetDiagnosticSessionStateForTest();
  resetDiagnosticEventsForTest();
  hookRunner.hasHooks.mockImplementation((hookName) => hookName === "before_tool_call");
  hookRunner.runBeforeToolCall.mockReset();
  mockCallGateway.mockReset();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetDiagnosticRunActivityForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("plugin approval policy subject and setup guidance", () => {
  it("uses one request for an in-process tool approval without reviewer scope", async () => {
    requireApproval("diffs");
    mockCallGateway.mockResolvedValueOnce({ id: "plugin:approved", decision: "allow-once" });
    const gatewayContext = {} as GatewayRequestContext;

    const result = await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "main",
        gatewayContextResolver: () => gatewayContext,
      },
      () => runBeforeToolCallHook({ toolName: "diffs", params: {}, ctx: { agentId: "main" } }),
    );

    expect(result.blocked).toBe(false);
    expect(mockCallGateway).toHaveBeenCalledTimes(1);
    expect(mockCallGateway.mock.calls[0]?.[0]).toBe("plugin.approval.request");
    expect(mockCallGateway.mock.calls[0]?.[2]).toMatchObject({ twoPhase: false });
    expect(mockCallGateway.mock.calls[0]?.[3]).toEqual({ expectFinal: true });
  });

  it.each(["wrapped", "adapted"] as const)(
    "binds a %s tool approval to its registered owner rather than the approval hook owner",
    async (path) => {
      requireApproval("review-hook");
      mockCallGateway.mockResolvedValueOnce({ id: "server-id-diffs", status: "accepted" });
      mockCallGateway.mockResolvedValueOnce({ id: "server-id-diffs", decision: "allow-once" });
      const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
      const selectedTool = { name: "diffs", execute } as unknown as AnyAgentTool;
      setPluginToolMeta(selectedTool, { pluginId: "diffs", optional: false });
      const context = { agentId: "main", sessionKey: "main", loopDetection: { enabled: false } };
      if (path === "wrapped") {
        await wrapToolWithBeforeToolCallHook(selectedTool, context).execute("call-diffs", {});
      } else {
        const [definition] = toToolDefinitions([selectedTool], context);
        await definition?.execute("call-diffs", {}, undefined, undefined, {} as ExtensionContext);
      }
      expect(mockCallGateway.mock.calls[0]?.[2]).toMatchObject({
        policySubject: { pluginKey: "diffs", tool: "diffs" },
      });
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["slack", "telegram"] as const)(
    "includes %s setup guidance on approval failure",
    async (channel) => {
      const native = channel === "telegram";
      const channelLabel = native ? "Telegram" : "Slack";
      const guidance = native
        ? "Configure Telegram native approval setup."
        : "Check `approvals.plugin.slack` and the connected bot workspace.";
      const describePluginApprovalSetup = vi.fn(() => guidance);
      approvalChannel(channel, channelLabel, {
        ...(native ? { native: {} } : {}),
        getActionAvailabilityState: () => ({ kind: "enabled" }),
        getExecInitiatingSurfaceState: () => ({ kind: native ? "disabled" : "enabled" }),
        describePluginApprovalSetup,
      });
      requireApproval();
      if (native) {
        mockCallGateway.mockResolvedValueOnce({
          id: "server-id",
          status: "accepted",
          deliveryRoute: "turn-source",
        });
      }
      mockCallGateway.mockResolvedValueOnce({ id: "server-id", decision: null });
      const result = await runBeforeToolCallHook({
        toolName: native ? "bash" : "diffs",
        params: {},
        ctx: {
          agentId: "main",
          sessionKey: "main",
          turnSourceChannel: channel,
          ...(native ? { turnSourceTo: "-100123456789" } : {}),
          turnSourceAccountId: "default",
        },
      });
      expect(result).toMatchObject(
        native
          ? {
              blocked: true,
              disposition: "timed_out",
              reason: `Approval timed out\n\n${guidance}`,
            }
          : { reason: `Plugin approval unavailable (no approval route)\n\n${guidance}` },
      );
      if (!native) {
        expect(describePluginApprovalSetup).toHaveBeenCalledWith({
          channel,
          channelLabel,
          accountId: "default",
        });
        expect(mockCallGateway).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("uses the transport channel when tool policy provider differs", async () => {
    requireApproval("my-plugin");

    const tempDir = tempDirs.make("openclaw-hook-route-");
    await fs.writeFile(join(tempDir, "note.txt"), "hello");
    mockCallGateway.mockResolvedValueOnce({ id: "transport-route-id", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({
      id: "transport-route-id",
      decision: "allow-once",
    });

    const tools = createOpenClawCodingTools({
      workspaceDir: tempDir,
      messageProvider: "discord-voice",
      messageChannel: "discord",
      currentChannelId: "native-channel-1",
      currentMessagingTarget: "channel:deliverable-1",
      agentAccountId: "acct-1",
      currentThreadTs: "thread-1",
      approvalReviewerDeviceId: "device-tui-reviewer",
    });
    const readTool = tools.find((tool) => tool.name === "read");
    assert.ok(readTool, "missing read tool");
    await readTool.execute("tool-hook-route", { path: "note.txt" });

    const requestCall = mockCallGateway.mock.calls[0];
    expect(requestCall?.[0]).toBe("plugin.approval.request");
    expect(requestCall?.[2]).toMatchObject({
      turnSourceChannel: "discord",
      turnSourceTo: "channel:deliverable-1",
      turnSourceAccountId: "acct-1",
      turnSourceThreadId: "thread-1",
      approvalReviewerDeviceIds: ["device-tui-reviewer"],
    });
  });
});
