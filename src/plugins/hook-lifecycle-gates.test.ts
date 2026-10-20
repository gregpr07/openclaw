import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginHookRegistration, PluginHookAgentContext } from "./hook-types.js";
import { createHookRunner } from "./hooks.js";

function runGate(
  hooks: Pick<
    PluginHookRegistration<"before_agent_run">,
    "pluginId" | "handler" | "priority"
  >[] = [],
) {
  return createHookRunner({
    hooks: [],
    plugins: [],
    typedHooks: hooks.map<PluginHookRegistration<"before_agent_run">>((hook) => ({
      ...hook,
      hookName: "before_agent_run",
      source: "test",
    })),
  }).runBeforeAgentRun({ prompt: "test", messages: [] }, ctx);
}

const ctx: PluginHookAgentContext = {
  runId: "run-1",
  agentId: "agent-1",
  sessionKey: "session-1",
  sessionId: "sid-1",
};

describe("before_agent_run hook", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns undefined when no handlers registered", async () => {
    expect(await runGate()).toBeUndefined();
  });

  it("blocks when one of multiple handlers passes and a later handler blocks", async () => {
    const calls: string[] = [];
    const passHandler = vi.fn(async () => {
      calls.push("pass-plugin");
      return { outcome: "pass" as const };
    });
    const blockHandler = vi.fn(async () => {
      calls.push("block-plugin");
      return { outcome: "block" as const, reason: "blocked" };
    });
    const result = await runGate([
      { pluginId: "pass-plugin", handler: passHandler, priority: 10 },
      { pluginId: "block-plugin", handler: blockHandler, priority: 5 },
    ]);
    expect(result).toMatchObject({ decision: { outcome: "block" }, pluginId: "block-plugin" });
    expect(passHandler).toHaveBeenCalledTimes(1);
    expect(blockHandler).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["pass-plugin", "block-plugin"]);
  });

  it("short-circuits when the first of multiple handlers blocks", async () => {
    const blockHandler = vi.fn(async () => ({
      outcome: "block" as const,
      reason: "blocked",
    }));
    const passHandler = vi.fn(async () => ({ outcome: "pass" as const }));
    const result = await runGate([
      { pluginId: "block-plugin", handler: blockHandler, priority: 10 },
      { pluginId: "pass-plugin", handler: passHandler, priority: 5 },
    ]);
    expect(result).toMatchObject({ decision: { outcome: "block" }, pluginId: "block-plugin" });
    expect(blockHandler).toHaveBeenCalledTimes(1);
    expect(passHandler).not.toHaveBeenCalled();
  });

  it("treats void handler returns as pass (no effect)", async () => {
    expect(
      await runGate([{ pluginId: "void-plugin", handler: async () => undefined }]),
    ).toBeUndefined();
  });

  it("fails closed on null handler results", async () => {
    const result = await runGate([{ pluginId: "null-plugin", handler: async () => null as never }]);
    expect(result).toEqual({
      decision: {
        outcome: "block",
        reason: "before_agent_run returned an invalid decision",
      },
      pluginId: "null-plugin",
    });
  });

  it("fails closed when handlers throw", async () => {
    const result = runGate([
      {
        pluginId: "throwing-plugin",
        handler: async () => {
          throw new Error("policy unavailable");
        },
      },
    ]);
    await expect(result).rejects.toThrow(
      "before_agent_run handler from throwing-plugin failed: policy unavailable",
    );
  });

  it("fails closed when handlers exceed the default timeout", async () => {
    vi.useFakeTimers();
    const resultPromise = runGate([
      {
        pluginId: "hanging-plugin",
        handler: async () => await new Promise<never>(() => {}),
      },
    ]);
    const rejection = expect(resultPromise).rejects.toThrow(
      "before_agent_run handler from hanging-plugin failed: timed out after 15000ms",
    );

    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
  });
  it("short-circuits unsupported ask decisions", async () => {
    let secondHandlerCalled = false;
    const result = await runGate([
      {
        pluginId: "plugin-a",
        handler: async () =>
          ({
            outcome: "ask" as const,
            reason: "check",
            title: "Check",
            description: "Check this.",
          }) as never,
        priority: 10,
      },
      {
        pluginId: "plugin-b",
        handler: async () => {
          secondHandlerCalled = true;
          return { outcome: "pass" as const };
        },
        priority: 5,
      },
    ]);
    expect(result).toMatchObject({ decision: { outcome: "block" }, pluginId: "plugin-a" });
    expect(secondHandlerCalled).toBe(false);
  });
});
