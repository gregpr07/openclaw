await vi.hoisted(() => import("./launchd-ancestry.test-support.js"));

import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import {
  nativeServiceMembership,
  getSelfAndAncestorPidsSync,
  launchdCallerPids,
  launchdRestartHandoffState,
  installLaunchAgent,
  setLegacyGatewayLaunchAgentPlist,
  registerLaunchdAncestryTests,
} from "./launchd-ancestry.test-support.js";
import {
  createDefaultLaunchdEnv,
  createTestLaunchAgentPlist,
  defaultProgramArguments,
  launchAgentControlFixture,
} from "./launchd-install.test-support.js";
import { launchdTestState as state } from "./launchd-state.test-support.js";
import {
  parkCurrentLaunchAgentForMaintenance,
  resolveLaunchAgentPlistPath,
  restartLaunchAgent,
  uninstallLaunchAgent,
} from "./launchd.js";

registerLaunchdAncestryTests();

const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
const serviceId = `${domain}/ai.openclaw.gateway`;
const inLaunchAgent = <T>(run: () => Promise<T>) =>
  withEnvAsync({ LAUNCH_JOB_LABEL: "ai.openclaw.gateway" }, run);
let env: ReturnType<typeof createDefaultLaunchdEnv>;
beforeEach(() => {
  env = createDefaultLaunchdEnv();
});

describe("LaunchAgent service membership", () => {
  it("restarts from a verified external terminal with unreadable ancestors", async () => {
    getSelfAndAncestorPidsSync.mockReturnValue(new Set(launchdCallerPids));
    nativeServiceMembership.mockReturnValue("outside");

    await expect(
      inLaunchAgent(() => restartLaunchAgent(launchAgentControlFixture(env))),
    ).resolves.toEqual({ outcome: "completed" });

    expect(state.launchctlCalls).toEqual([
      ["print", serviceId],
      ["enable", serviceId],
      ["kickstart", "-k", serviceId],
    ]);
    expect(launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff).not.toHaveBeenCalled();
  });

  it.each(["synchronous", "asynchronous"] as const)(
    "surfaces %s detached handoff failures",
    async (failure) => {
      const stdout = new PassThrough();
      const onMutation = vi.fn();
      nativeServiceMembership.mockReturnValue("inside");
      launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff.mockReturnValue(
        failure === "synchronous"
          ? { ok: false, error: "spawn failed" }
          : { ok: true, value: Promise.resolve(false) },
      );

      await expect(
        inLaunchAgent(() => restartLaunchAgent({ env, stdout, onMutation })),
      ).rejects.toThrow(
        `launchd restart handoff failed: ${failure === "synchronous" ? "spawn failed" : "helper failed to spawn"}`,
      );
      expect(onMutation).not.toHaveBeenCalled();
      expect(stdout.read()?.toString() ?? "").not.toContain("Scheduled LaunchAgent restart");
    },
  );

  it.each([
    { action: "install", membership: "inside" },
    { action: "install", membership: "unknown" },
    { action: "uninstall", membership: "ancestor" },
  ] as const)(
    "refuses $action before mutation with $membership service membership",
    async ({ action, membership }) => {
      state.serviceStates.set(serviceId, "running");
      getSelfAndAncestorPidsSync.mockReturnValue(
        new Set([...launchdCallerPids, membership === "ancestor" ? 4242 : 1]),
      );
      if (membership !== "ancestor") {
        nativeServiceMembership.mockReturnValue(membership);
      }
      const plistPath = resolveLaunchAgentPlistPath(env);
      const previous = createTestLaunchAgentPlist({
        label: "ai.openclaw.gateway",
        programArguments: defaultProgramArguments,
      });
      state.files.set(plistPath, previous);
      await inLaunchAgent(async () => {
        await expect(
          action === "install"
            ? installLaunchAgent({
                env,
                stdout: new PassThrough(),
                programArguments: defaultProgramArguments,
              })
            : uninstallLaunchAgent({ env, stdout: new PassThrough() }),
        ).rejects.toThrow(
          membership === "unknown"
            ? "Native Gateway service membership could not be verified"
            : `Refusing to ${action} LaunchAgent ai.openclaw.gateway from inside ai.openclaw.gateway`,
        );
      });
      expect(state.fileWrites).toEqual([]);
      expect(state.files.get(plistPath)).toBe(previous);
      expect(state.launchctlCalls).toEqual([["print", serviceId]]);
    },
  );

  it("re-enables the LaunchAgent when the maintenance handoff cannot spawn", async () => {
    getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));
    state.disableCode = 0;
    launchdRestartHandoffState.scheduleDetachedLaunchdMaintenancePark.mockReturnValueOnce({
      ok: true,
      value: Promise.resolve(false),
    });

    await inLaunchAgent(async () => {
      await expect(parkCurrentLaunchAgentForMaintenance({ env })).rejects.toThrow(
        "helper failed to spawn; restored launchd enable state",
      );
    });

    expect(state.launchctlCalls).toEqual([
      ["print", serviceId],
      ["disable", serviceId],
      ["enable", serviceId],
    ]);
  });

  it("hands plist reload off when current LaunchAgent needs rewritten paths", async () => {
    getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));
    const plistPath = resolveLaunchAgentPlistPath(env);
    setLegacyGatewayLaunchAgentPlist(plistPath, [
      "    <key>StandardOutPath</key>",
      "    <string>/Users/test/.openclaw-default/logs/gateway.log</string>",
    ]);

    const result = await inLaunchAgent(() => restartLaunchAgent(launchAgentControlFixture(env)));

    expect(result).toEqual({ outcome: "scheduled" });
    expect(launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff).toHaveBeenCalledWith({
      env,
      mode: "reload",
      waitForPid: process.pid,
    });
    expect(state.files.get(plistPath)).toContain("/Users/test/Library/Logs/openclaw/gateway.log");
    expect(state.launchctlCalls).toStrictEqual([["print", serviceId]]);
  });
});
