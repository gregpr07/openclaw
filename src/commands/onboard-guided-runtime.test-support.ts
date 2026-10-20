import { vi } from "vitest";
import { runGuidedOnboarding, type GuidedOnboardingDeps } from "./onboard-guided.js";

export type GuidedOrchestrationFixture = GuidedOnboardingDeps & {
  createPrompter?: typeof import("../wizard/clack-prompter.js").createClackPrompter;
  listManualOptions?: typeof import("../system-agent/setup-inference.js").listManualSetupInferenceOptions;
  applySetup?: typeof import("../system-agent/setup-apply.js").applySystemAgentSetup;
  runMemorySetupFlow?: typeof import("../flows/memory-setup.js").runMemorySetupFlow;
  runAppRecommendations?: typeof import("../wizard/setup.app-recommendations.js").setupAppRecommendations;
  runBrowserHandoff?: typeof import("./onboard-browser-handoff.js").runBrowserHatchHandoff;
  launchHatchTui?: typeof import("../tui/tui-launch.js").launchTuiCli;
  runForegroundGateway?: typeof import("./onboard-quickstart-host.js").runQuickstartForegroundGateway;
  observeHandoff?: (
    handoff: Parameters<
      typeof import("./onboard-interactive-runner.js").runGuidedOnboardingHandoff
    >[0],
  ) => void;
};

export async function runGuidedOnboardingWithFixtures(
  opts: Parameters<typeof runGuidedOnboarding>[0],
  runtime: Parameters<typeof runGuidedOnboarding>[1],
  fixtures: GuidedOrchestrationFixture = {},
) {
  const {
    createPrompter,
    listManualOptions,
    applySetup,
    runMemorySetupFlow,
    runAppRecommendations,
    runBrowserHandoff,
    launchHatchTui,
    runForegroundGateway,
    observeHandoff,
    ...servingDeps
  } = fixtures;
  const restore: Array<{ mockRestore(): void }> = [];
  try {
    if (observeHandoff) {
      const owner = await import("./onboard-interactive-runner.js");
      const runHandoff = owner.runGuidedOnboardingHandoff;
      restore.push(
        vi.spyOn(owner, "runGuidedOnboardingHandoff").mockImplementation((...args) => {
          observeHandoff(args[0]);
          return runHandoff(...args);
        }),
      );
    }
    if (createPrompter) {
      const owner = await import("../wizard/clack-prompter.js");
      restore.push(vi.spyOn(owner, "createClackPrompter").mockImplementation(createPrompter));
    }
    if (listManualOptions) {
      const owner = await import("../system-agent/setup-inference.js");
      restore.push(
        vi.spyOn(owner, "listManualSetupInferenceOptions").mockImplementation(listManualOptions),
      );
    }
    if (applySetup) {
      const owner = await import("../system-agent/setup-apply.js");
      restore.push(vi.spyOn(owner, "applySystemAgentSetup").mockImplementation(applySetup));
    }
    if (runMemorySetupFlow) {
      const owner = await import("../flows/memory-setup.js");
      restore.push(vi.spyOn(owner, "runMemorySetupFlow").mockImplementation(runMemorySetupFlow));
    }
    if (runAppRecommendations) {
      const owner = await import("../wizard/setup.app-recommendations.js");
      restore.push(
        vi.spyOn(owner, "setupAppRecommendations").mockImplementation(runAppRecommendations),
      );
    }
    if (runBrowserHandoff) {
      const owner = await import("./onboard-browser-handoff.js");
      restore.push(vi.spyOn(owner, "runBrowserHatchHandoff").mockImplementation(runBrowserHandoff));
    }
    if (launchHatchTui) {
      const owner = await import("../tui/tui-launch.js");
      restore.push(vi.spyOn(owner, "launchTuiCli").mockImplementation(launchHatchTui));
    }
    if (runForegroundGateway) {
      const owner = await import("./onboard-quickstart-host.js");
      restore.push(
        vi.spyOn(owner, "runQuickstartForegroundGateway").mockImplementation(runForegroundGateway),
      );
    }
    return await runGuidedOnboarding(opts, runtime, servingDeps);
  } finally {
    for (const reset of restore.toReversed()) {
      reset.mockRestore();
    }
  }
}
