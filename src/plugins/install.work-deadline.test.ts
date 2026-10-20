import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandOptions } from "../process/exec.js";
import { npmCommandArgs } from "../test-utils/npm-command.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { installPluginFromNpmSpec } from "./install-npm.js";
import { installPluginFromArchive } from "./install-package.js";

const runCommand = vi.hoisted(() => vi.fn());
const fixtureId = "deadline-fixture";
const source = "export default {};";
const packageFiles = (name: string, dependencies?: Record<string, string>) => ({
  "package.json": JSON.stringify({
    name,
    version: "1.0.0",
    openclaw: { extensions: ["./index.js"] },
    dependencies,
  }),
  "openclaw.plugin.json": JSON.stringify({ id: name, configSchema: { type: "object" } }),
  "index.js": source,
});
const writeJson = (dir: string, file: string, value: unknown) =>
  fs.writeFile(path.join(dir, file), JSON.stringify(value));
const commandTimeouts = (matches: (argv: string[]) => boolean) =>
  (runCommand.mock.calls as [string[], CommandOptions][])
    .filter(([argv]) => matches(argv))
    .map(([, opts]) => opts.timeoutMs);

async function expectInstalled(result: Awaited<ReturnType<typeof installPluginFromNpmSpec>>) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error);
  }
  expect(await fs.readFile(path.join(result.targetDir, "index.js"), "utf8")).toBe(source);
}
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: (...args: unknown[]) => runCommand(...args),
}));

describe("plugin update work deadlines", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "plugin-work-deadline" });
    vi.stubEnv("NPM_CONFIG_GLOBALCONFIG", await state.writeText("global-npmrc", ""));
    runCommand.mockReset();
    runCommand.mockImplementation(async (argv: string[], options: CommandOptions) => {
      let stdout = "";
      if (npmCommandArgs(argv)?.[0] === "view") {
        stdout = JSON.stringify({ name: fixtureId, version: "1.0.0" });
      } else if (npmCommandArgs(argv)?.[0] === "install") {
        const cwd = options.cwd!;
        const packageDir = path.join(cwd, "node_modules", fixtureId);
        await fs.mkdir(packageDir, { recursive: true });
        await writeJson(cwd, "package-lock.json", {
          lockfileVersion: 3,
          packages: {
            "": { dependencies: { [fixtureId]: "1.0.0" } },
            [`node_modules/${fixtureId}`]: { version: "1.0.0" },
          },
        });
        for (const [file, content] of Object.entries(packageFiles(fixtureId))) {
          await fs.writeFile(path.join(packageDir, file), content);
        }
      } else {
        throw new Error(`Unexpected fixture command: ${argv.join(" ")}`);
      }
      return { code: 0, stdout, stderr: "", signal: null, killed: false, termination: "exit" };
    });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await state.cleanup();
  });

  it.each([
    ["install", undefined, 300_000, 120_000, 120_000],
    ["update", undefined, undefined, undefined, 120_000],
    ["update", 37, 37, 37, 60_000],
  ] as const)(
    "preserves %s work deadlines (timeout=%s, work=%s, planning=%s, metadata=%s)",
    async (mode, timeoutMs, work, planning, metadata) => {
      const result = await installPluginFromNpmSpec({
        spec: "deadline-fixture@1.0.0",
        expectedPluginId: "deadline-fixture",
        mode,
        timeoutMs,
        npmDir: path.join(state.root, "npm"),
        extensionsDir: path.join(state.root, "extensions"),
        config: {},
      });
      await expectInstalled(result);
      expect(commandTimeouts((argv) => npmCommandArgs(argv)?.[0] === "view")).toEqual([metadata]);
      expect(
        commandTimeouts(
          (argv) =>
            npmCommandArgs(argv)?.[0] === "install" && !argv.includes("--package-lock-only"),
        ),
      ).toEqual([work]);
      const plans = commandTimeouts((argv) => argv.includes("--package-lock-only"));
      expect(plans.length).toBeGreaterThan(0);
      expect(plans.every((timeout) => timeout === planning)).toBe(true);
    },
  );
  it.each([
    { mode: "install", timeoutMs: undefined, work: 300_000 },
    { mode: "update", timeoutMs: undefined, work: undefined },
    { mode: "update", timeoutMs: 500, work: 500 },
  ] as const)(
    "keeps $mode archive work policy through extraction and dependency installation",
    async ({ mode, timeoutMs, work }) => {
      const zip = new JSZip();
      for (const [file, content] of Object.entries(
        packageFiles("archive-fixture", { [fixtureId]: "1.0.0" }),
      )) {
        zip.file(file, content);
      }
      const archivePath = path.join(state.root, "fixture.zip");
      await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
      const result = await installPluginFromArchive({
        archivePath,
        mode,
        timeoutMs,
        extensionsDir: path.join(state.root, "extensions"),
      });
      await expectInstalled(result);
      expect(runCommand.mock.calls.map(([, opts]) => opts.timeoutMs)).toEqual([work]);
    },
  );
});
