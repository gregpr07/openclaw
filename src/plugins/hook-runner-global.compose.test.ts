import { afterEach, describe, expect, it, vi } from "vitest";
import { getGlobalHookRunnerRegistry } from "./hook-runner-global-state.js";
import {
  getGlobalHookRunner,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "./hook-runner-global.js";
import { addTestHook, createMockPluginRegistry } from "./hooks.test-fixtures.js";
import type { PluginRegistry } from "./registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";

function runner() {
  const value = getGlobalHookRunner();
  if (!value) {
    throw new Error("Expected global hook runner");
  }
  return value;
}

const toolCallContext = {
  agentId: "test-agent",
  sessionKey: "test-session",
  toolCallId: "test-call",
  toolName: "read",
};
const runTool = () => runner().runBeforeToolCall({ toolName: "read", params: {} }, toolCallContext);
const policyIds = () =>
  getGlobalHookRunnerRegistry()?.trustedToolPolicies?.map(({ policy }) => policy.id);

function addPolicy(registry: PluginRegistry, pluginId: string, pluginName: string) {
  registry.trustedToolPolicies = [
    {
      pluginId,
      pluginName,
      source: "test",
      policy: { id: `${pluginId}-policy`, description: pluginId, evaluate: () => undefined },
    },
  ];
}

function toolRegistry(pluginId: string) {
  const hook = vi.fn();
  const registry = createMockPluginRegistry([
    { hookName: "before_tool_call", handler: hook, pluginId },
  ]);
  return { hook, registry };
}

function initializeRoot(root: PluginRegistry, initial = root) {
  setActivePluginRegistry(root);
  initializeGlobalHookRunner(initial);
}

afterEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

describe("global hook runner registry selection", () => {
  it("overlays a partial request registry and then returns to the process root", async () => {
    const { hook: rootHook, registry: root } = toolRegistry("root");
    const { hook: scopedHook, registry: scoped } = toolRegistry("scoped");
    addPolicy(root, "root", "Root");
    addPolicy(scoped, "scoped", "Scoped");
    initializeRoot(root);
    await withPluginRuntimeRegistryScope(scoped, async () => {
      await runTool();
      expect(policyIds()).toEqual(["root-policy", "scoped-policy"]);
    });

    expect(scopedHook).toHaveBeenCalledOnce();
    expect(rootHook).toHaveBeenCalledOnce();
    await runTool();
    expect(rootHook).toHaveBeenCalledTimes(2);
    expect(policyIds()).toEqual(["root-policy"]);
  });

  it("lets the request registry replace the same plugin without double dispatch", async () => {
    const { hook: rootHook, registry: root } = toolRegistry("shared");
    const { hook: scopedHook, registry: scoped } = toolRegistry("shared");
    initializeRoot(root);
    await withPluginRuntimeRegistryScope(scoped, runTool);

    expect(scopedHook).toHaveBeenCalledOnce();
    expect(rootHook).not.toHaveBeenCalled();
  });

  it("keeps root contributions when a same-plugin request handle has none", async () => {
    const { hook: rootHook, registry: root } = toolRegistry("shared");
    addPolicy(root, "shared", "Shared");
    const scoped = createMockPluginRegistry([]);
    scoped.plugins = [
      createPluginRecord({ id: "shared", name: "Shared", status: "error", error: "load failed" }),
    ];
    initializeRoot(root);

    await withPluginRuntimeRegistryScope(scoped, async () => {
      await runTool();
      expect(policyIds()).toEqual(["shared-policy"]);
    });

    expect(rootHook).toHaveBeenCalledOnce();
  });

  it("overlays an explicitly initialized SDK registry on the process root", async () => {
    const rootToolHook = vi.fn();
    const rootWriteHook = vi.fn();
    const sdkWriteHook = vi.fn(() => ({
      message: { role: "user", content: "sdk redaction", timestamp: 2 },
    }));
    const root = createMockPluginRegistry([
      { hookName: "before_tool_call", handler: rootToolHook, pluginId: "shared" },
      { hookName: "before_message_write", handler: rootWriteHook, pluginId: "shared" },
    ]);
    addPolicy(root, "shared", "Shared");
    const sdk = createMockPluginRegistry([
      { hookName: "before_message_write", handler: sdkWriteHook, pluginId: "shared" },
    ]);

    initializeRoot(root, sdk);

    expect(
      runner().runBeforeMessageWrite(
        { message: { role: "user", content: "private", timestamp: 1 } },
        { agentId: "test-agent", sessionKey: "test-session" },
      ),
    ).toEqual({ message: { role: "user", content: "sdk redaction", timestamp: 2 } });
    expect(sdkWriteHook).toHaveBeenCalledOnce();
    expect(rootWriteHook).not.toHaveBeenCalled();

    await runTool();
    expect(rootToolHook).toHaveBeenCalledOnce();
    expect(policyIds()).toEqual(["shared-policy"]);
  });

  it("sees hooks added after initialization", () => {
    const registry: PluginRegistry = createMockPluginRegistry([
      { hookName: "message_received", handler: vi.fn(), pluginId: "plugin" },
    ]);
    initializeRoot(registry);

    expect(runner().hasHooks("message_sent")).toBe(false);
    addTestHook({
      registry,
      pluginId: "plugin",
      hookName: "message_sent",
      handler: vi.fn(),
    });
    expect(runner().hasHooks("message_sent")).toBe(true);
  });
});
