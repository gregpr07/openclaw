import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  resolveIdentityPathViaExistingAncestorSync,
  resolveRealpathOrAbsolute,
  resolveRootPath,
  resolveRootPathSync,
} from "./boundary-path.js";
import { isPathInside } from "./path-guards.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const withBoundaryDir = (run: (base: string) => Promise<void>) =>
  withTestDir({ prefix: "openclaw-boundary-path-" }, run);

async function makeBoundary(base: string) {
  const root = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  await Promise.all([root, outside].map((dir) => fs.mkdir(dir, { recursive: true })));
  return { root, outside };
}

describe("resolveRealpathOrAbsolute", () => {
  it("keeps missing paths lexical and falls back on non-missing errors", async () => {
    await withBoundaryDir(async (base) => {
      const alias = path.join(base, "alias");
      await fs.symlink(path.join(base, "target"), alias);
      const missing = path.join(alias, "missing");
      expect(resolveRealpathOrAbsolute(missing)).toBe(path.resolve(missing));
      vi.spyOn(fsSync, "realpathSync").mockImplementation(() => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      });
      expect(resolveRealpathOrAbsolute("denied")).toBe(path.resolve("denied"));
    });
  });
});

describe("resolveIdentityPathViaExistingAncestorSync", () => {
  it("continues through native realpath failures to preserve ancestor identity", () => {
    const aliasRoot = path.resolve("identity-alias");
    const targetPath = path.join(aliasRoot, "locked", "leaf");
    const canonicalRoot = path.resolve("identity-real");
    const calls: string[] = [];

    vi.spyOn(fsSync.realpathSync, "native").mockImplementation((candidate) => {
      const resolved = path.resolve(String(candidate));
      calls.push(resolved);
      if (resolved === aliasRoot) {
        return canonicalRoot;
      }
      throw new Error("simulated realpath failure");
    });

    expect(resolveIdentityPathViaExistingAncestorSync(targetPath)).toBe(
      path.join(canonicalRoot, "locked", "leaf"),
    );
    expect(calls).toEqual([targetPath, path.dirname(targetPath), aliasRoot]);
  });

  it("falls back lexically only after native realpath fails through the root", () => {
    const targetPath = path.resolve("identity-alias", "locked", "leaf");
    const calls: string[] = [];
    const expectedCalls: string[] = [];
    let cursor = targetPath;
    while (true) {
      expectedCalls.push(cursor);
      if (path.dirname(cursor) === cursor) {
        break;
      }
      cursor = path.dirname(cursor);
    }

    vi.spyOn(fsSync.realpathSync, "native").mockImplementation((candidate) => {
      calls.push(path.resolve(String(candidate)));
      throw new Error("simulated realpath failure");
    });

    expect(resolveIdentityPathViaExistingAncestorSync(targetPath)).toBe(targetPath);
    expect(calls).toEqual(expectedCalls);
  });
});

describe("resolveRootPath", () => {
  it("blocks dangling symlink leaf escapes outside root", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withBoundaryDir(async (base) => {
      const { root, outside } = await makeBoundary(base);
      const linkPath = path.join(root, "alias-out");
      await fs.symlink(outside, linkPath);
      const options = {
        absolutePath: path.join(linkPath, "missing.txt"),
        rootPath: root,
        boundaryLabel: "sandbox root",
      };

      await expect(resolveRootPath(options)).rejects.toThrow(/Symlink escapes sandbox root/i);
      expect(() => resolveRootPathSync(options)).toThrow(/Symlink escapes sandbox root/i);
    });
  });

  it("allows final symlink only when unlink policy opts in", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withBoundaryDir(async (base) => {
      const { root, outside } = await makeBoundary(base);
      const outsideFile = path.join(outside, "target.txt");
      const linkPath = path.join(root, "link.txt");
      await fs.writeFile(outsideFile, "x", "utf8");
      await fs.symlink(outsideFile, linkPath);

      const options = { absolutePath: linkPath, rootPath: root, boundaryLabel: "sandbox root" };
      await expect(resolveRootPath(options)).rejects.toThrow(/Symlink escapes sandbox root/i);

      const allowed = await resolveRootPath({
        ...options,
        policy: { allowFinalSymlinkForUnlink: true },
      });
      const rootReal = await fs.realpath(root);
      expect(allowed).toMatchObject({
        exists: true,
        kind: "symlink",
        canonicalPath: path.join(rootReal, "link.txt"),
      });
    });
  });

  it("allows canonical aliases that still resolve inside root", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withBoundaryDir(async (base) => {
      const root = path.join(base, "workspace");
      const aliasRoot = path.join(base, "workspace-alias");
      const fileName = "plugin.js";
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, fileName), "export default {}", "utf8");
      await fs.symlink(root, aliasRoot);

      const options = {
        absolutePath: path.join(aliasRoot, fileName),
        rootPath: await fs.realpath(root),
        boundaryLabel: "plugin root",
      };
      const resolved = await resolveRootPath(options);
      expect(resolved.exists).toBe(true);
      expect(isPathInside(resolved.rootCanonicalPath, resolved.canonicalPath)).toBe(true);

      const resolvedSync = resolveRootPathSync(options);
      expect(resolvedSync.exists).toBe(true);
      expect(isPathInside(resolvedSync.rootCanonicalPath, resolvedSync.canonicalPath)).toBe(true);
    });
  });
});
