import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { quoteCmdScriptArg } from "../daemon/cmd-argv.js";
import {
  buildWindowsCmdExeCommandLine,
  resolveTrustedWindowsCmdExe,
} from "../process/windows-command.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  resolveCurrentOpenClawCliInvocation,
  type OpenClawCliInvocation,
} from "./openclaw-cli-invocation.js";
import {
  createSourceCliFixture,
  runSourceCliProbe,
} from "./openclaw-cli-invocation.test-support.js";
import { clearGatewayAgentCliShim, prepareGatewayAgentCliShim } from "./openclaw-cli-shim.js";

const requireFromHere = createRequire(import.meta.url);

function expectSourceCliSuccess(
  phase: string,
  result: ReturnType<typeof runSourceCliProbe>,
  fixtureRoot: string,
  cwd: string,
  args: string[] = ["probe"],
  extra: { tsconfigPath?: string } = {},
) {
  // Child stacks in assertion messages make Vitest parse TSX's source-map template.
  // Keep bounded child evidence separate so the launcher failure stays visible.
  console.info(
    "[source-cli-probe]",
    JSON.stringify({
      phase,
      status: result.status,
      signal: result.signal,
      error: result.error?.message.replaceAll(fixtureRoot, "<fixture>").slice(0, 2048),
      stdout: (result.stdout ?? "").replaceAll(fixtureRoot, "<fixture>").slice(0, 2048),
      stderr: (result.stderr ?? "").replaceAll(fixtureRoot, "<fixture>").slice(-4096),
    }),
  );
  expect(result.status, phase).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ source: "gateway", args, cwd, ...extra });
}

async function prepareShim(root: string, invocation: OpenClawCliInvocation, env = {}) {
  const stateDir = path.join(root, "state");
  await prepareGatewayAgentCliShim({ env, invocation, stateDir });
  return path.join(stateDir, "tmp", "agent-cli", "openclaw.cmd");
}

afterEach(() => {
  clearGatewayAgentCliShim();
});

describe.skipIf(process.platform !== "win32")("native Windows source CLI shim", () => {
  it.each(["off", "on"])(
    "preserves source paths and caller cwd with delayed expansion %s",
    async (delayedExpansion) => {
      await withTempDir("openclaw-source-cli-win-", async (root) => {
        const fixture = await createSourceCliFixture(root);
        const control = runSourceCliProbe(
          fixture.invocation.command,
          [...fixture.invocation.args, "--profile", "work", "probe"],
          fixture.checkout,
        );
        expectSourceCliSuccess(
          `direct source control (delayed expansion ${delayedExpansion})`,
          control,
          root,
          fixture.checkout,
          ["--profile", "work", "probe"],
        );
        const shimPath = await prepareShim(root, fixture.invocation, { OPENCLAW_PROFILE: "work" });
        const command = buildWindowsCmdExeCommandLine(shimPath, ["probe"]);
        const result = runSourceCliProbe(
          resolveTrustedWindowsCmdExe(),
          ["/d", `/v:${delayedExpansion}`, "/s", "/c", command],
          fixture.callerCwd,
          { windowsVerbatimArguments: true },
        );
        expectSourceCliSuccess(
          `generated cmd launcher (delayed expansion ${delayedExpansion})`,
          result,
          root,
          fixture.callerCwd,
          ["--profile", "work", "probe"],
          process.versions.bun
            ? {}
            : { tsconfigPath: path.join(fixture.checkout, "tsconfig.json") },
        );
      });
    },
  );

  it("preserves literal forwarded bangs and percent signs", async () => {
    await withTempDir("openclaw-source-cli-args-win-", async (root) => {
      const fixture = await createSourceCliFixture(root);
      const shimPath = await prepareShim(root, fixture.invocation);
      const callerPath = path.join(root, "caller.cmd");
      // The caller supplies literal arguments; the shim must not enable expansion
      // and reinterpret them while forwarding %* to the source CLI.
      await fs.writeFile(
        callerPath,
        [
          "@echo off",
          "setlocal DisableDelayedExpansion",
          `${quoteCmdScriptArg(shimPath, { delayedExpansion: false })} probe "literal!%%USERPROFILE%%!"`,
          "",
        ].join("\r\n"),
      );
      const result = runSourceCliProbe(
        resolveTrustedWindowsCmdExe(),
        ["/d", "/v:on", "/s", "/c", buildWindowsCmdExeCommandLine(callerPath, [])],
        fixture.callerCwd,
        { windowsVerbatimArguments: true },
      );
      expectSourceCliSuccess(
        "literal caller arguments through generated cmd",
        result,
        root,
        fixture.callerCwd,
        ["probe", "literal!%USERPROFILE%!"],
      );
    });
  });

  it.each(["generic Node host", "bare TSX source parent"])(
    "launches source mode outside the checkout from a %s",
    async (parent) => {
      await withTempDir("openclaw-source-cli-host-win-", async (root) => {
        const fixture = await createSourceCliFixture(root);
        const modulesDir = path.join(fixture.checkout, "node_modules");
        await fs.mkdir(modulesDir);
        await fs.symlink(
          path.dirname(requireFromHere.resolve("tsx/package.json")),
          path.join(modulesDir, "tsx"),
          "junction",
        );
        const hostEntry = path.join(fixture.checkout, "scripts", "host.mjs");
        await fs.mkdir(path.dirname(hostEntry));
        await fs.writeFile(hostEntry, "// A generic Node host is not the OpenClaw CLI entry.\n");
        const sourceParent = parent === "bare TSX source parent";
        const sourceExecArgv = sourceParent ? ["--import", "tsx"] : fixture.execArgv;
        const control = runSourceCliProbe(
          fixture.invocation.command,
          [...sourceExecArgv, fixture.entryPath, "probe"],
          fixture.checkout,
        );
        expectSourceCliSuccess(`${parent} direct source control`, control, root, fixture.checkout);
        const invocation = resolveCurrentOpenClawCliInvocation(["probe"], {
          argv1: sourceParent ? fixture.entryPath : hostEntry,
          cwd: fixture.callerCwd,
          execArgv: sourceParent ? sourceExecArgv : [],
          execPath: process.execPath,
        });
        const result = runSourceCliProbe(invocation.command, invocation.args, fixture.callerCwd, {
          env: invocation.env,
        });
        expectSourceCliSuccess(
          `${parent} external source invocation`,
          result,
          root,
          fixture.callerCwd,
        );
      });
    },
  );
});
