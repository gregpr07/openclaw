import { vi, type MockInstance } from "vitest";
import { runGuidedOnboarding, type GuidedOnboardingDeps } from "./onboard-guided.js";
import type { GuidedOnboardingHandoff } from "./onboard-interactive-runner.js";

export type GuidedOrchestrationFixture = GuidedOnboardingDeps & {
  createPrompter?: typeof import("../wizard/clack-prompter.js").createClackPrompter;
  listManualOptions?: typeof import("../system-agent/setup-inference.js").listManualSetupInferenceOptions;
  applySetup?: typeof import("../system-agent/setup-apply.js").applySystemAgentSetup;
  runMemorySetupFlow?: typeof import("../flows/memory-setup.js").runMemorySetupFlow;
  runAppRecommendations?: typeof import("../wizard/setup.app-recommendations.js").setupAppRecommendations;
  runBrowserHandoff?: typeof import("./onboard-browser-handoff.js").runBrowserHatchHandoff;
  launchHatchTui?: typeof import("../tui/tui-launch.js").launchTuiCli;
  runForegroundGateway?: typeof import("./onboard-quickstart-host.js").runQuickstartForegroundGateway;
  observeHandoff?: (handoff: GuidedOnboardingHandoff) => void;
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
  async function replace<T extends (...args: never[]) => unknown>(
    value: Parameters<MockInstance<T>["mockImplementation"]>[0] | undefined,
    target: () => Promise<MockInstance<T>>,
  ) {
    if (value) {
      restore.push((await target()).mockImplementation(value));
    }
  }
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
    await replace(createPrompter, async () =>
      vi.spyOn(await import("../wizard/clack-prompter.js"), "createClackPrompter"),
    );
    await replace(listManualOptions, async () =>
      vi.spyOn(
        await import("../system-agent/setup-inference.js"),
        "listManualSetupInferenceOptions",
      ),
    );
    await replace(applySetup, async () =>
      vi.spyOn(await import("../system-agent/setup-apply.js"), "applySystemAgentSetup"),
    );
    await replace(runMemorySetupFlow, async () =>
      vi.spyOn(await import("../flows/memory-setup.js"), "runMemorySetupFlow"),
    );
    await replace(runAppRecommendations, async () =>
      vi.spyOn(await import("../wizard/setup.app-recommendations.js"), "setupAppRecommendations"),
    );
    await replace(runBrowserHandoff, async () =>
      vi.spyOn(await import("./onboard-browser-handoff.js"), "runBrowserHatchHandoff"),
    );
    await replace(launchHatchTui, async () =>
      vi.spyOn(await import("../tui/tui-launch.js"), "launchTuiCli"),
    );
    await replace(runForegroundGateway, async () =>
      vi.spyOn(await import("./onboard-quickstart-host.js"), "runQuickstartForegroundGateway"),
    );
    return await runGuidedOnboarding(opts, runtime, servingDeps);
  } finally {
    for (const reset of restore.toReversed()) {
      reset.mockRestore();
    }
  }
}
