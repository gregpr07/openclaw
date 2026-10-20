import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createExitThrowingRuntime } from "../../test/helpers/auth-wizard.js";
import type { ChannelSetupWizardAdapter } from "../channels/plugins/setup-wizard-types.js";
import { readConfigFileSnapshot } from "../config/config.js";
import {
  createChannelOnboardingPostWriteHook,
  createChannelSetupHooks,
} from "../flows/channel-setup.js";
import { commitConfigWithPendingPluginInstalls } from "../plugins/install-record-commit.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { writeWizardConfigFile } from "../wizard/setup.shared.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let runtime: ReturnType<typeof createExitThrowingRuntime>;
let hooks: ReturnType<typeof createChannelSetupHooks>;
beforeEach(async () => {
  state = await createOpenClawTestState({
    label: "post-write",
    layout: "split",
    scenario: "minimal",
    env: { SETUP_REPLY_PREFIX: "resolved prefix" },
  });
  runtime = createExitThrowingRuntime();
  hooks = createChannelSetupHooks({ runtime });
});
afterEach(() => state?.cleanup());

it.each(["plugin", "wizard"] as const)(
  "resolves the exact %s commit after config selection changes",
  async (writer) => {
    await state.writeConfig({ messages: { responsePrefix: "${SETUP_REPLY_PREFIX}" } });
    const before = await readConfigFileSnapshot();
    const next = { ...before.sourceConfig, gateway: { port: 19001 } };
    const afterConfigWritten = vi.fn<NonNullable<ChannelSetupWizardAdapter["afterConfigWritten"]>>(
      async () => {},
    );
    hooks.onPostWriteHook(
      createChannelOnboardingPostWriteHook({
        channel: "matrix",
        accountId: "ops",
        previousCfg: before.sourceConfig,
        adapter: { afterConfigWritten },
      })!,
    );
    const committed =
      writer === "plugin"
        ? await commitConfigWithPendingPluginInstalls({
            sourceConfig: next,
            baseHash: before.hash,
          })
        : await writeWizardConfigFile(next, { baseHash: before.hash });
    expect(afterConfigWritten).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(committed.path, "utf8"))).toMatchObject({
      messages: { responsePrefix: "${SETUP_REPLY_PREFIX}" },
      gateway: { port: 19001 },
    });
    const persisted = await readConfigFileSnapshot();
    expect({ config: committed.nextConfig, hash: committed.persistedHash }).toEqual({
      config: persisted.sourceConfig,
      hash: persisted.hash,
    });
    expect(committed.nextConfig.messages?.responsePrefix).toBe("resolved prefix");
    const decoy = state.path("decoy.json");
    await fs.writeFile(decoy, JSON.stringify({ messages: { responsePrefix: "wrong file" } }));
    process.env.OPENCLAW_CONFIG_PATH = decoy;

    await hooks.runPostWriteHooks(committed.path);

    const written = afterConfigWritten.mock.lastCall?.[0];
    expect(written).toMatchObject({
      cfg: { messages: { responsePrefix: "resolved prefix" }, gateway: { port: 19001 } },
      accountId: "ops",
    });
    expect(written?.previousCfg).toEqual(before.sourceConfig);
    expect(runtime.error).not.toHaveBeenCalled();
  },
);

it("deduplicates accounts, continues after a hook warning, and clears completed hooks", async () => {
  const replaced = vi.fn();
  const failing = vi.fn(async () => {
    throw new Error("hook failed");
  });
  const succeeding = vi.fn();
  hooks.onPostWriteHook({ channel: "matrix", accountId: "ops", run: replaced });
  hooks.onPostWriteHook({ channel: "matrix", accountId: "ops", run: failing });
  hooks.onPostWriteHook({ channel: "telegram", accountId: "ops", run: succeeding });

  await hooks.runPostWriteHooks(state.configPath);
  await hooks.runPostWriteHooks(state.path("missing-after-completion.json"));

  expect(replaced).not.toHaveBeenCalled();
  expect(failing).toHaveBeenCalledOnce();
  expect(succeeding).toHaveBeenCalledOnce();
  expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
    'Channel matrix post-setup warning for "ops": hook failed',
  );
});

it("rechecks authority after the awaited read and retains rejected hooks", async () => {
  let active = true;
  const hook = vi.fn();
  hooks = createChannelSetupHooks({
    runtime,
    beforePersistentEffect: async () => {
      if (!active) {
        throw new Error("owner revoked");
      }
    },
  });
  hooks.onPostWriteHook({ channel: "matrix", accountId: "ops", run: hook });
  const pending = hooks.runPostWriteHooks(state.configPath);
  active = false;

  await expect(pending).rejects.toThrow("owner revoked");
  expect(hook).not.toHaveBeenCalled();
  expect(runtime.error).not.toHaveBeenCalled();
  active = true;
  await hooks.runPostWriteHooks(state.configPath);
  expect(hook).toHaveBeenCalledOnce();
});
