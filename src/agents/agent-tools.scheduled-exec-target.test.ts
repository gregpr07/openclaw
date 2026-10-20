import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it, vi } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import { pinExecToolTarget } from "./exec-tool-target-pinning.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import type { AnyAgentTool } from "./tools/common.js";

const shellSpies = vi.hoisted(() => ({
  defaults: vi.fn<(defaults?: ExecToolDefaults) => void>(),
  exec: vi.fn(async () => ({ content: [], details: {} })),
  process: vi.fn(async () => ({ content: [], details: {} })),
}));

vi.mock("./bash-tools.js", () => ({
  createExecTool: (defaults?: ExecToolDefaults) => {
    shellSpies.defaults(defaults);
    return {
      name: "exec",
      description: "exec test double",
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          ["command", "host", "security", "ask", "node"].map((name) => [name, { type: "string" }]),
        ),
        required: ["command", "host"],
      },
      execute: shellSpies.exec,
    };
  },
  createProcessTool: () => ({
    name: "process",
    description: "process test double",
    parameters: { type: "object", properties: {} },
    execute: shellSpies.process,
  }),
}));

const scheduledToolPolicy = {
  version: 1,
  mode: "trusted",
  execTarget: { host: "gateway", ask: "always" },
} as const;
const command = { command: "echo hi" };
const pinnedTarget = scheduledToolPolicy.execTarget;
const pinnedArgs = { ...command, ...pinnedTarget };
function expectExecution(id: string, args: object) {
  expect(shellSpies.exec).toHaveBeenCalledWith(id, args, undefined, undefined);
}
function scheduledExec(options: Parameters<typeof createOpenClawCodingTools>[0] = {}) {
  return expectDefined(
    createOpenClawCodingTools({ scheduledToolPolicy, ...options }).find(
      (tool) => tool.name === "exec",
    ),
    "scheduled exec",
  );
}

beforeEach(() => vi.clearAllMocks());

it("uses the scheduled Gateway pin when no target is requested", async () => {
  const execTool = scheduledExec();
  const properties = Object.keys(
    (execTool.parameters as { properties?: Record<string, unknown> }).properties ?? {},
  );
  expect(properties).toEqual(["command"]);

  await execTool.execute("call-1", { ...command, security: "full", ask: "off" });
  expect(shellSpies.defaults).toHaveBeenCalledWith(expect.objectContaining(pinnedTarget));
  expectExecution("call-1", pinnedArgs);
});

it.each([
  { host: "node", node: "remote" },
  { node: "remote" },
  { host: "gateway", node: "remote" },
  { host: "sandbox" },
])("refuses a conflicting scheduled exec target before execution: %j", async (target) => {
  const execTool = scheduledExec();
  await expect(async () =>
    execTool.execute("call-conflict", { ...command, ...target }),
  ).rejects.toThrow(/pinned to host=gateway;.*host or node is not allowed for this job/);
  expect(shellSpies.exec).not.toHaveBeenCalled();
});

it.each(["prepareBeforeToolCallParams", "finalizeBeforeToolCallParams"] as const)(
  "pins lifecycle arguments before %s",
  async (phase) => {
    const preparing = phase === "prepareBeforeToolCallParams";
    const hook = preparing ? vi.fn(async (args: unknown) => args) : vi.fn((args: unknown) => args);
    const source: AnyAgentTool = {
      ...createStubTool("exec"),
      [phase]: hook,
      execute: shellSpies.exec,
    };

    const pinned = pinExecToolTarget(source, pinnedTarget);
    const context = preparing ? { hookContext: undefined } : {};
    const conflict = { ...command, host: "node", ...(preparing ? { node: "remote" } : {}) };
    const override = {
      ...command,
      ask: "off",
      ...(preparing ? { security: "full" } : { host: "gateway" }),
    };
    const invoke = pinned[phase]!;
    expect(() => invoke(conflict, context)).toThrow("pinned to host=gateway");
    expect(hook).not.toHaveBeenCalled();
    await invoke(override, context);
    expect(hook).toHaveBeenCalledWith(pinnedArgs, context);
  },
);

it("keeps the scheduled approval floor in a reused full-permission session", async () => {
  const exec = scheduledExec({ sessionPermissionPolicy: { root: process.cwd(), mode: "full" } });
  await exec.execute("call-full-session", command);
  const overrides = { ...pinnedTarget, mode: undefined, security: "full" };
  expect(shellSpies.defaults.mock.lastCall?.[0]).toMatchObject({
    ...overrides,
    bypassHostApprovalFloors: false,
  });
  expect(vi.mocked(createOpenClawTools).mock.lastCall?.[0]?.execOverrides).toMatchObject(overrides);
});

it.each([
  ["global", "sandbox", { config: { tools: { exec: { host: "sandbox" } } } }],
  [
    "agent",
    "node",
    {
      agentId: "main",
      config: { agents: { entries: { main: { tools: { exec: { host: "node" } } } } } },
    },
  ],
  ["run", "sandbox", { exec: { host: "sandbox" } }],
] as const)(
  "preserves the current %s host=%s restriction beside a saved pin",
  async (_source, host, options) => {
    const exec = scheduledExec({
      ...options,
      scheduledToolPolicy: {
        ...scheduledToolPolicy,
        execTarget: { host: "gateway" },
      },
    });
    await exec.execute("call-restricted-host", command);
    expect(shellSpies.defaults.mock.lastCall?.[0]?.host).toBe(host);
    expectExecution("call-restricted-host", { ...command, host: "gateway" });
  },
);
