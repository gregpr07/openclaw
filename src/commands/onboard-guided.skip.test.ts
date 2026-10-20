import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GuidedOrchestrationFixture as GuidedOnboardingDeps } from "./onboard-guided-runtime.test-support.js";

vi.mock("./onboard-interactive-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./onboard-interactive-runner.js")>()),
  hasInteractiveOnboardingTty: () => true,
  runInteractiveOnboarding: async (run: () => Promise<void>) => await run(),
}));
vi.mock("./auth-choice-prompt.js", () => ({ promptAuthChoiceGrouped: async () => "skip" }));
vi.mock("../agents/auth-profiles.runtime.js", () => ({
  ensureAuthProfileStore: () => ({ version: 1, profiles: {} }),
}));
vi.mock("../plugins/provider-setup-availability.js", () => ({
  detectAvailableSetupProviderIds: async () => new Set(),
}));

it.each(["interrupted", "replaced"] as const)(
  "keeps skipped baseline setup owner-fenced and resumable: %s",
  (scenario) =>
    withOpenClawTestState(
      { label: "onboard-skip", layout: "split" },
      async ({ workspaceDir: workspace, configPath }) => {
        const { runGuidedOnboardingWithFixtures: runGuidedOnboarding } =
          await import("./onboard-guided-runtime.test-support.js");
        const { readConfigFileSnapshot } = await import("../config/config.js");
        const { applySystemAgentSetup } = await import("../system-agent/setup-apply.js");
        const { beginLocalOnboarding, readLocalOnboardingState } =
          await import("../state/local-onboarding-state.js");
        const prompter = createWizardPrompter({}, { selectValues: ["full", "full"] });
        const followup = vi.fn();
        let interrupted = false;
        const deps: GuidedOnboardingDeps = {
          createPrompter: () => prompter,
          activate: followup,
          launchHatchTui: followup,
          detect: async () => ({
            candidates: [],
            unavailableCandidates: [],
            manualProviders: [],
            authOptions: [],
            recommendedInstalls: [],
            workspace,
            setupComplete: false,
          }),
          applySetup: async (params, hooks) =>
            await applySystemAgentSetup(
              {
                ...params,
                assertCommitPreconditions: (config) => {
                  const firstAgentOnly =
                    config.agents?.entries?.starter && config.gateway?.mode === undefined;
                  if (!interrupted && firstAgentOnly) {
                    interrupted = true;
                    if (scenario === "interrupted") {
                      throw new Error("Synthetic interruption after first-agent creation");
                    }
                    const owner = readLocalOnboardingState(configPath)!;
                    beginLocalOnboarding({
                      ...owner,
                      replace: true,
                      expectedRunId: owner.runId,
                      runId: "replacement",
                    });
                  }
                  params.assertCommitPreconditions?.(config);
                },
              },
              hooks,
            ),
        };
        const run = () =>
          runGuidedOnboarding(
            { acceptRisk: true, workspace, agentName: "starter", tui: true, skipHooks: true },
            { log: vi.fn(), error: vi.fn(), exit: vi.fn() as never },
            deps,
          );
        await expect(run()).rejects.toThrow(
          scenario === "interrupted" ? "Synthetic interruption" : "Another onboarding run",
        );
        const interruptedConfig = await readConfigFileSnapshot();
        expect(interruptedConfig.config.agents?.entries?.starter).toBeDefined();
        expect(interruptedConfig.config.gateway?.mode).toBeUndefined();
        expect(readLocalOnboardingState(configPath)?.status).toBe("pending");
        if (scenario === "replaced") {
          expect(readLocalOnboardingState(configPath)?.runId).toBe("replacement");
          return;
        }
        await run();
        const snapshot = await readConfigFileSnapshot();
        expect(snapshot.valid).toBe(true);
        expect(snapshot.config.gateway?.mode).toBe("local");
        expect(snapshot.config.agents?.entries?.starter?.workspace).toBe(workspace);
        expect(Object.keys(snapshot.config.agents?.entries ?? {})).toEqual(["starter"]);
        expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).not.toBe("");
        expect(readLocalOnboardingState(configPath)?.status).toBe("completed");
        expect(followup).not.toHaveBeenCalled();
        expect(prompter.note).toHaveBeenCalledWith(
          expect.stringContaining("openclaw onboard"),
          "Next steps",
        );
      },
    ),
);
