import type { SpawnSyncOptions } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getWindowsCmdExePath,
  getWindowsPowerShellExePath,
} from "../infra/windows-install-roots.js";
import "./test-helpers/schtasks-base-mocks.js";
import { resolveTaskScriptPath } from "./schtasks-layout.js";
import { launchFallbackTaskScript } from "./schtasks-runtime.js";
import {
  createSpawnChild,
  makeSpawnSyncResult,
  resetSchtasksBaseMocks,
  withWindowsEnv,
  type SpawnSyncResult,
} from "./test-helpers/schtasks-fixtures.js";

const childUnref = vi.hoisted(() => vi.fn());
const spawn = vi.hoisted(() => vi.fn());
const spawnSync = vi.hoisted(() =>
  vi.fn<
    (command: string, args?: readonly string[], options?: SpawnSyncOptions) => SpawnSyncResult
  >(),
);
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn,
  spawnSync,
}));
beforeEach(() => {
  resetSchtasksBaseMocks();
  vi.stubEnv("BOUNDARY_PARENT_ONLY", "synthetic");
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  childUnref.mockReset();
  spawn.mockReset().mockImplementation(() => createSpawnChild(childUnref));
  spawnSync.mockReset().mockImplementation(() => makeSpawnSyncResult());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function writeCmdScript(env: Record<string, string | undefined>) {
  const scriptPath = resolveTaskScriptPath(env);
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(scriptPath, "@echo off\r\nrem no parsed command\r\n", "utf8");
  return scriptPath;
}
describe("Windows Startup launcher", () => {
  it.each(["cmd", "bat"])("launches an installed .%s wrapper through cmd.exe", async (ext) => {
    await withWindowsEnv("openclaw-win-wrapper-", async ({ env, tmpDir }) => {
      const wrapper = path.join(tmpDir, `openclaw wrapper.${ext}`);
      spawn.mockImplementation((command: string) => {
        if (/\.(?:cmd|bat)$/iu.test(command)) {
          throw Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" });
        }
        return createSpawnChild(childUnref);
      });
      await expect(
        launchFallbackTaskScript(env, {
          programArguments: [wrapper, "node", "run", "--display-name", "Headless node"],
          environment: { OPENCLAW_SERVICE_KIND: "node" },
        }),
      ).resolves.toBeUndefined();
      expect(spawn).toHaveBeenCalledWith(
        getWindowsCmdExePath(),
        ["/d", "/s", "/c", `""${wrapper}" "node" "run" "--display-name" "Headless node""`],
        expect.objectContaining({
          windowsVerbatimArguments: true,
          shell: false,
          env: expect.objectContaining({ BOUNDARY_PARENT_ONLY: "synthetic" }),
        }),
      );
      expect(childUnref).toHaveBeenCalledOnce();
    });
  });

  it.each(["spawn", "access"])("rejects %s failure without detaching", async (failure) => {
    await withWindowsEnv("openclaw-win-startup-", async ({ env, tmpDir }) => {
      env.OPENCLAW_STATE_DIR = path.join(tmpDir, "state & %USERPROFILE%");
      const scriptPath = await writeCmdScript(env);
      const error = Object.assign(new Error("spawn cmd ENOENT"), { code: "ENOENT" });
      if (failure === "access") {
        spawnSync.mockReturnValueOnce(makeSpawnSyncResult({ status: 1 }));
      } else {
        spawn.mockImplementationOnce(() => createSpawnChild(childUnref, error));
      }
      await expect(
        launchFallbackTaskScript(env, failure === "access" ? null : undefined),
      ).rejects.toMatchObject(
        failure === "access" ? { code: "EACCES" } : { code: "ENOENT", message: "spawn cmd ENOENT" },
      );
      expect(childUnref).not.toHaveBeenCalled();
      if (failure === "access") {
        expect(spawnSync.mock.calls[0]?.[2]?.env).not.toHaveProperty("BOUNDARY_PARENT_ONLY");
        expect(spawn).not.toHaveBeenCalled();
        expect(spawnSync).toHaveBeenCalledWith(
          getWindowsPowerShellExePath(),
          expect.arrayContaining(["-EncodedCommand"]),
          expect.objectContaining({
            env: expect.objectContaining({ OPENCLAW_TASK_SCRIPT: scriptPath }),
            stdio: "ignore",
            windowsHide: true,
          }),
        );
      }
    });
  });
});
