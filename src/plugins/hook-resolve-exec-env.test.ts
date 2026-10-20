import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addStaticTestHooks, addTestHook } from "./hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginHookResolveExecEnvContext } from "./types.js";

const ctx: PluginHookResolveExecEnvContext = {
  agentId: "agent-1",
  sessionKey: "agent:agent-1:main",
  messageProvider: "telegram",
  channelId: "chat-1",
};

describe("resolve_exec_env hook", () => {
  let registry: ReturnType<typeof createEmptyPluginRegistry>;
  let logger: {
    error: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    registry = createEmptyPluginRegistry();
    logger = { error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  });
  const run = () =>
    createHookRunner(registry, { logger }).runResolveExecEnv(
      { sessionKey: ctx.sessionKey, toolName: "exec", host: "gateway" },
      ctx,
    );
  const addFailingHook = (pluginId: string, handler: () => Promise<never>) => {
    addTestHook({ registry, pluginId, hookName: "resolve_exec_env", handler, priority: 100 });
    addTestHook({
      registry,
      pluginId: "healthy",
      hookName: "resolve_exec_env",
      handler: async () => ({ HEALTHY_ENV: "ok" }),
      priority: 50,
    });
  };
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns an empty env when no handlers are registered", async () => {
    await expect(run()).resolves.toEqual({});
  });

  it("merges env vars from multiple plugins in priority order", async () => {
    addStaticTestHooks<Record<string, string>>(registry, {
      hookName: "resolve_exec_env",
      hooks: [
        {
          pluginId: "first",
          priority: 100,
          result: { SHARED: "first", FIRST_ONLY: "1" },
        },
        {
          pluginId: "second",
          priority: 50,
          result: { SHARED: "second", SECOND_ONLY: "2" },
        },
      ],
    });
    await expect(run()).resolves.toEqual({
      FIRST_ONLY: "1",
      SECOND_ONLY: "2",
      SHARED: "second",
    });
  });

  it("isolates handler errors so other plugins can still contribute env", async () => {
    addFailingHook("crasher", async () => {
      throw new Error("plugin failed");
    });
    await expect(run()).resolves.toEqual({ HEALTHY_ENV: "ok" });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("resolve_exec_env handler from crasher failed"),
    );
  });

  it("skips handlers that exceed the default timeout", async () => {
    vi.useFakeTimers();
    addFailingHook("hanging", () => new Promise<never>(() => {}));
    const resultPromise = run();

    await vi.advanceTimersByTimeAsync(15_000);
    await expect(resultPromise).resolves.toEqual({ HEALTHY_ENV: "ok" });
    expect(logger.error).toHaveBeenCalledWith(
      "[hooks] resolve_exec_env handler from hanging failed: timed out after 15000ms",
    );
  });
});
