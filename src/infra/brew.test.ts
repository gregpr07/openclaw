import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveBrewExecutable, resolveBrewPathDirs } from "./brew.js";

const withBrewDir = (run: (tmp: string) => Promise<void>) =>
  withTestDir({ prefix: "openclaw-brew-" }, run);

describe("brew helpers", () => {
  async function writeExecutable(filePath: string) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "#!/bin/sh\necho ok\n", "utf-8");
    await fs.chmod(filePath, 0o755);
  }

  it("resolves brew from absolute PATH entries for non-standard installs", async () => {
    await withBrewDir(async (tmp) => {
      const customBin = path.join(tmp, "custom-homebrew", "bin");
      const customBrew = path.join(customBin, "brew");
      await writeExecutable(customBrew);

      await withEnvAsync({ PATH: customBin }, async () => {
        expect(resolveBrewExecutable({ homeDir: path.join(tmp, "home") })).toBe(customBrew);
      });
    });
  });

  it("ignores Homebrew executable, selector, and prefix env overrides by default", async () => {
    await withBrewDir(async (tmp) => {
      const explicit = path.join(tmp, "custom", "brew");
      const prefix = path.join(tmp, "prefix");
      const prefixBin = path.join(prefix, "bin");
      const homebrewBrew = path.join(tmp, ".linuxbrew", "bin", "brew");
      await Promise.all(
        [explicit, path.join(prefixBin, "brew"), homebrewBrew].map(writeExecutable),
      );
      const env = {
        HOMEBREW_BREW_FILE: explicit,
        HOMEBREW_CURL_PATH: explicit,
        HOMEBREW_GIT_PATH: explicit,
        HOMEBREW_PREFIX: prefix,
      };

      await withEnvAsync({ ...env, PATH: "" }, async () => {
        expect(resolveBrewExecutable({ homeDir: tmp, env })).toBe(homebrewBrew);
        expect(resolveBrewPathDirs({ homeDir: tmp, env })).not.toContain(prefixBin);
      });
    });
  });

  it("does not resolve brew from PATH entries", async () => {
    await withBrewDir(async (tmp) => {
      const pathBin = path.join(tmp, "path-bin");
      const pathBrew = path.join(pathBin, "brew");
      await writeExecutable(pathBrew);

      expect(
        resolveBrewExecutable({ homeDir: path.join(tmp, "home"), env: { PATH: pathBin } }),
      ).not.toBe(pathBrew);
    });
  });

  it("always includes the standard macOS brew dirs after linuxbrew candidates", () => {
    const dirs = resolveBrewPathDirs({ homeDir: "/home/test" });

    expect(dirs.slice(-2)).toEqual(["/opt/homebrew/bin", "/usr/local/bin"]);
  });

  it("includes Linuxbrew bin/sbin in path candidates without env prefixes", async () => {
    await withEnvAsync(
      {
        HOMEBREW_PREFIX: "/custom/prefix",
        HOMEBREW_BREW_FILE: undefined,
        HOMEBREW_CURL_PATH: undefined,
        HOMEBREW_GIT_PATH: undefined,
      },
      async () => {
        const dirs = resolveBrewPathDirs({ homeDir: "/home/test" });
        expect(dirs).not.toContain(path.join("/custom/prefix", "bin"));
        expect(dirs).not.toContain(path.join("/custom/prefix", "sbin"));
        expect(dirs).toContain("/home/linuxbrew/.linuxbrew/bin");
        expect(dirs).toContain("/home/linuxbrew/.linuxbrew/sbin");
        expect(dirs).toContain(path.join("/home/test", ".linuxbrew", "bin"));
        expect(dirs).toContain(path.join("/home/test", ".linuxbrew", "sbin"));
      },
    );
  });
});
