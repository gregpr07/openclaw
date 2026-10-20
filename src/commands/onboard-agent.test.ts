import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAgent: vi.fn(),
  migrateLegacyMainSessionKeys: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
}));

vi.mock("../agents/agent-create.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-create.js")>()),
  createAgent: mocks.createAgent,
}));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));
vi.mock("../config/sessions/legacy-main-session-migration.js", () => ({
  migrateLegacyMainSessionKeys: mocks.migrateLegacyMainSessionKeys,
}));

const { ensureOnboardingAgent } = await import("./onboard-agent.js");
type AgentOptions = Parameters<typeof ensureOnboardingAgent>[0];
const ensureAgent = (options: Partial<AgentOptions> = {}) =>
  ensureOnboardingAgent({ config: {}, workspace: "/tmp/work", ...options });
const snapshot = (config: AgentOptions["config"], exists: boolean, hash?: string) => ({
  exists,
  valid: true,
  hash,
  sourceConfig: config,
  config,
});

describe("onboarding main-agent creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAgent.mockResolvedValue({
      status: "created",
      agentId: "main",
      name: "main",
      workspace: "/tmp/work",
      agentDir: "/tmp/agent",
      bootstrapPending: true,
      configHash: "hash-after-create",
    });
    mocks.migrateLegacyMainSessionKeys.mockResolvedValue({ warnings: [] });
    mocks.readConfigFileSnapshot
      .mockResolvedValueOnce(snapshot({ agents: { entries: { main: {} } }, gateway: {} }, false))
      .mockResolvedValueOnce(
        snapshot(
          { agents: { entries: { main: {} } }, gateway: { controlUi: { enabled: true } } },
          true,
          "hash-after-create",
        ),
      );
  });

  it("provisions explicit main through createAgent on a fresh install", async () => {
    const result = await ensureAgent({
      config: {
        agents: { defaults: { model: "openai/gpt-5.5" } },
        gateway: { mode: "local" },
      },
    });

    expect(mocks.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ id: "main" }),
        bootstrapMain: true,
      }),
    );
    expect(mocks.createAgent.mock.calls[0]?.[0]?.entry).not.toHaveProperty("default");
    expect(result).toMatchObject({
      agentId: "main",
      // Creation rebases the caller onto its own persisted config revision (#112678).
      configHash: "hash-after-create",
      config: {
        agents: {
          defaults: { model: "openai/gpt-5.5" },
          entries: { main: {} },
        },
        gateway: { mode: "local", controlUi: { enabled: true } },
      },
    });
  });

  it("preserves an explicit imported candidate roster", async () => {
    const config = { agents: { entries: { main: {} } } };

    await expect(ensureAgent({ config, preserveCandidateRoster: true })).resolves.toEqual({
      config,
      configBase: config,
      agentId: "main",
      bootstrapPending: false,
      createdAgent: false,
    });
    expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });
  it("rejects a whitespace-only explicit first-agent name instead of defaulting to main", async () => {
    await expect(ensureAgent({ firstAgent: { name: "   " } })).rejects.toThrow(
      "Agent name is required",
    );

    expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });

  it("surfaces pending detection outcomes even when inspection is complete", async () => {
    mocks.migrateLegacyMainSessionKeys.mockResolvedValueOnce({
      armed: true,
      complete: true,
      warnings: ["retained legacy main sessions require repair; run openclaw doctor --fix"],
    });

    const result = await ensureAgent({ firstAgent: { name: "robby" } });

    expect(result.sessionMigrationWarnings).toEqual([
      expect.stringContaining(
        "retained legacy main sessions require repair; run openclaw doctor --fix",
      ),
    ]);
  });

  it("rejects a roster written after the approved config revision", async () => {
    mocks.readConfigFileSnapshot.mockReset().mockResolvedValueOnce({
      exists: true,
      valid: true,
      hash: "concurrent",
      sourceConfigBeforeMigrations: { agents: { entries: { ops: {} } } },
      config: { agents: { entries: { ops: {} } } },
    });

    await expect(
      ensureAgent({
        firstAgent: { name: "robby" },
        expectedConfigHash: "approved",
      }),
    ).rejects.toThrow("config changed before first-agent creation");

    expect(mocks.createAgent).not.toHaveBeenCalled();
  });
});
