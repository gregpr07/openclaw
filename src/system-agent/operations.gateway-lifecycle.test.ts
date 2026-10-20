import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayHostLifecycle } from "../gateway/server-public.js";
import { defaultRuntime } from "../runtime.js";
import { executeSystemAgentOperation } from "./operations-execute.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

const { resolveService, appendAudit } = vi.hoisted(() => ({
  resolveService: vi.fn(() => {
    throw new Error("Hosted lifecycle reached the native service");
  }),
  appendAudit: vi.fn<typeof import("./audit.js").appendSystemAgentAuditEntry>(),
}));

// Hosted lifecycle must never enter native service management, even on failure.
vi.mock("../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service.js")>()),
  resolveGatewayService: resolveService,
}));

vi.mock("../config/config.js", async () => {
  const { resolveGatewayPort } = await import("../config/paths.js");
  const { createSnapshot } = await import("../config/mutate.test-support.js");
  const snapshot = {
    ...createSnapshot({
      path: "/test/openclaw.json",
      hash: "lifecycle-test-config",
      sourceConfig: {},
    }),
    raw: "{}",
  };
  return {
    getRuntimeConfig: () => ({}),
    readBestEffortConfig: async () => ({}),
    readConfigFileSnapshot: async () => snapshot,
    resolveGatewayPort,
  };
});

vi.mock("./audit.js", () => ({
  SYSTEM_AGENT_AUDIT_STORE_LABEL: "test audit",
  appendSystemAgentAuditEntry: appendAudit,
}));

function hosted(
  kind: "gateway-start" | "gateway-stop" | "gateway-restart" = "gateway-stop",
  request?: GatewayHostLifecycle["request"],
) {
  const output = createSystemAgentTestRuntime();
  return {
    ...output,
    execute: (approved = true, beforePersistentApply?: () => void) =>
      executeSystemAgentOperation({ kind }, output.runtime, {
        approved,
        beforePersistentApply,
        deps: { setupSurface: "gateway", gatewayHostLifecycle: request ? { request } : undefined },
      }),
  };
}

describe("SystemAgent hosted gateway lifecycle", () => {
  const exitSentinel = new Error("native CLI attempted to exit the host");
  const expectNoNativeCalls = () => {
    for (const mock of [defaultRuntime.exit, resolveService]) {
      expect(mock).not.toHaveBeenCalled();
    }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
      throw exitSentinel;
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([
    { kind: "gateway-start", outcome: "already-running", summary: "Gateway already running" },
    { kind: "gateway-stop", outcome: "scheduled", summary: "Scheduled Gateway stop" },
    { kind: "gateway-restart", outcome: "scheduled", summary: "Scheduled Gateway restart" },
  ] as const)(
    "audits the hosted $kind outcome without claiming native completion",
    async ({ kind, outcome, summary }) => {
      const request = vi.fn<GatewayHostLifecycle["request"]>(async (_action, assertCaller) => {
        assertCaller();
        return { ok: true, value: { outcome } };
      });
      const { execute, lines } = hosted(kind, request);
      const guard = vi.fn();
      await expect(execute(false)).resolves.toMatchObject({ applied: false });
      expect(request).not.toHaveBeenCalled();
      await expect(execute(true, guard)).resolves.toMatchObject({ applied: true });
      expect(guard).toHaveBeenCalledOnce();
      expect(appendAudit).toHaveBeenCalledWith(expect.objectContaining({ summary }));
      expect(lines).toContain(summary);
      expectNoNativeCalls();
    },
  );

  it("does not audit a rejected hosted stop as an applied operation", async () => {
    const { execute, lines } = hosted("gateway-stop", async () => ({
      ok: false,
      error: "native service ownership changed",
    }));
    await expect(execute()).rejects.toThrow("native service ownership changed");
    expect(appendAudit).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("[openclaw] done:");
    expectNoNativeCalls();
  });

  it("rejects gateway-stop without a host lifecycle before reaching the exiting native CLI", async () => {
    const { runtime, execute, lines } = hosted();
    const captureExit = vi.spyOn(runtime, "exit");
    await expect(execute()).rejects.toThrow("Gateway host lifecycle is unavailable");
    expectNoNativeCalls();
    expect(captureExit).not.toHaveBeenCalled();
    expect(appendAudit).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("[openclaw] done:");
  });
});
