import { afterEach, expect, it } from "vitest";
import { resolvePromptBuildHookResult } from "../../agents/embedded-agent-runner/run/attempt-prompt-helpers.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";

let state: OpenClawTestState | undefined;
afterEach(async () => {
  await state?.cleanup();
});

it("consumes only work global next-turn context during prompt preparation", async () => {
  const agentId = "work";
  state = await createOpenClawTestState({ label: "explicit-reply" });
  const cfg = {
    agents: {
      ownership: "explicit",
      entries: {
        main: { workspace: state.path("main-workspace") },
        work: { workspace: state.path("work-workspace") },
      },
    },
    plugins: { enabled: false },
    session: { scope: "global" },
  } satisfies Parameters<typeof resolvePromptBuildHookResult>[0]["config"];
  const scope = (owner: string) => ({ cfg, agentId: owner, sessionKey: "global" });
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: "injector", status: "loaded" }));
  for (const owner of ["main", "work"]) {
    await replaceSessionEntry(scope(owner), {
      sessionId: `${owner}-global`,
      updatedAt: 1,
      pluginNextTurnInjections: {
        injector: [
          {
            id: owner,
            pluginId: "injector",
            text: `${owner} context`,
            placement: "prepend_context",
            createdAt: 1,
          },
        ],
      },
    });
  }
  const prepare = () =>
    withPluginRuntimeRegistryScope(registry, () =>
      resolvePromptBuildHookResult({
        config: cfg,
        prompt: "hello",
        messages: [],
        hookCtx: { agentId, sessionKey: "global" },
      }),
    );
  expect((await prepare()).prependContext).toBe(`${agentId} context`);
  expect(loadSessionEntryReadOnly(scope(agentId))?.pluginNextTurnInjections).toBeUndefined();
  expect(loadSessionEntryReadOnly(scope("main"))?.pluginNextTurnInjections?.injector).toEqual([
    expect.objectContaining({ text: "main context" }),
  ]);
  expect((await prepare()).prependContext).toBeUndefined();
});
