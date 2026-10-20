import path from "node:path";
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenClawReadTool,
  wrapToolWorkspaceRootGuardWithOptions,
} from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import type { ReadToolDetails } from "./sessions/tools/tool-contracts.js";
import { createSandboxFsBridgeFromResolver } from "./test-helpers/host-sandbox-fs-bridge.js";

type AssertSandboxPath = typeof import("./sandbox-paths.js").assertSandboxPath;
const mocks = vi.hoisted(() => ({ assertSandboxPath: vi.fn<AssertSandboxPath>() }));
vi.mock("./sandbox-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-paths.js")>()),
  assertSandboxPath: mocks.assertSandboxPath,
}));
const root = path.resolve("/tmp/root");
function createToolHarness() {
  const execute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "ok" }],
    details: { kind: "text" as const, content: "ok" },
  }));
  const tool: AnyAgentTool<ReadToolDetails> = {
    name: "read",
    label: "read",
    description: "read",
    parameters: Type.Object({}),
    execute,
  };
  return {
    tool,
    execute,
    guard: (options?: Parameters<typeof wrapToolWorkspaceRootGuardWithOptions>[2]) =>
      wrapToolWorkspaceRootGuardWithOptions(tool, root, options),
  };
}
function expectGuard(filePath: string, guardRoot = root) {
  expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
    filePath,
    cwd: guardRoot,
    root: guardRoot,
  });
}
beforeEach(() => {
  mocks.assertSandboxPath.mockReset().mockImplementation(async ({ filePath }) => ({
    resolved:
      filePath.startsWith("file://") || path.isAbsolute(filePath)
        ? filePath
        : path.resolve(root, filePath),
    relative: "",
  }));
});

describe("workspace root guard", () => {
  it.each([
    ["@/workspace/docs/readme.md</arg_value>>", path.resolve(root, "docs/readme.md")],
    ["file://attacker/share/readme.md", "file://attacker/share/readme.md"],
    ["file:///workspace/%E0%A4%A", "file:///workspace/%E0%A4%A"],
    ["file:///workspace/%2FREADME.md", "file:///workspace/%2FREADME.md"],
    ["/workspace-two/secret.txt", "/workspace-two/secret.txt"],
  ])("guards normalized path %s", async (input, expected) => {
    const { guard, execute } = createToolHarness();
    const wrapped = guard({
      containerWorkdir: "/workspace",
      normalizeGuardedPathParams: true,
    });
    await wrapped.execute("path", { path: input });
    expectGuard(expected);
    expect(execute).toHaveBeenCalledWith("path", { path: expected }, undefined, undefined);
  });

  it("adds a workspace-safe hint without executing a rejected path", async () => {
    const { guard, execute } = createToolHarness();
    mocks.assertSandboxPath.mockRejectedValueOnce(
      new Error("Path escapes sandbox root (/tmp/root): /tmp/meta.jsonl"),
    );
    await expect(guard().execute("escape", { path: "/tmp/meta.jsonl" })).rejects.toThrow(
      /Path escapes sandbox root .* Use a relative path under `.openclaw\/tmp\/` inside the workspace/,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("normalizes traversal before selecting an overlapping mount", async () => {
    const { guard } = createToolHarness();
    await guard({
      containerMounts: [
        { containerRoot: "/workspace/skills", hostRoot: path.resolve("/tmp/skill-root") },
        { containerRoot: "/workspace", hostRoot: root },
      ],
      containerWorkdir: "/workspace",
    }).execute("traverse", { path: "/workspace/skills/../README.md" });
    expectGuard(path.resolve(root, "README.md"));
  });

  it("guards a file URL against its additional mount root", async () => {
    const { guard } = createToolHarness();
    const agentRoot = path.resolve("/tmp/agent-root");
    await guard({
      containerMounts: [{ containerRoot: "/agent", hostRoot: agentRoot }],
      containerWorkdir: "/workspace",
    }).execute("mount", { path: "file:///agent/docs/readme.md" });
    expectGuard(path.resolve(agentRoot, "docs/readme.md"), agentRoot);
  });

  it.each(["legacy", "miss", "mapped"] as const)(
    "honors %s bridge admission without inferring a namespace",
    async (mode) => {
      const { execute, guard } = createToolHarness();
      const mapping = { hostRoot: root, containerRoot: "C:\\NativeWorkspace" };
      const pathMappings = mode === "legacy" ? undefined : [mapping];
      const containerPath =
        mode === "miss" ? "C:\\Other\\note.txt" : "C:\\NativeWorkspace\\note.txt";
      const bridge = createSandboxFsBridgeFromResolver(
        () => ({
          hostPath: path.join(root, "note.txt"),
          relativePath: "note.txt",
          containerPath,
        }),
        pathMappings,
      );
      const wrapped = guard({
        bridge,
        containerWorkdir: "C:\\NativeWorkspace",
        normalizeGuardedPathParams: true,
      });
      if (mode === "miss") {
        await expect(wrapped.execute("admission", { path: "note.txt" })).rejects.toThrow(
          "Path escapes sandbox root",
        );
        expect(execute).not.toHaveBeenCalled();
        expect(mocks.assertSandboxPath).not.toHaveBeenCalled();
        return;
      }
      await wrapped.execute("admission", { path: "note.txt" });
      expectGuard(mode === "legacy" ? "note.txt" : path.join(root, "note.txt"));
      expect(execute).toHaveBeenCalledWith(
        "admission",
        {
          path: mode === "legacy" ? path.join(root, "note.txt") : containerPath,
        },
        undefined,
        undefined,
      );
    },
  );

  it("rejects custom paths emptied by suffix stripping", async () => {
    const { guard, execute } = createToolHarness();
    await expect(
      guard({ pathParamKeys: ["outPath"] }).execute("empty", { outPath: "</arg_value>>" }),
    ).rejects.toThrow(/Malformed path parameter: outPath/);
    expect(mocks.assertSandboxPath).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("read path normalization", () => {
  it("repairs Office paths and strips XML suffixes before reading", async () => {
    const { tool, execute } = createToolHarness();
    await createOpenClawReadTool(tool).execute("read", {
      path: "reports/final.docodex</arg_value>>",
    });
    expect(execute).toHaveBeenCalledWith(
      "read",
      { path: "reports/final.docx", offset: 1 },
      undefined,
    );
  });
  it("rejects paths emptied by suffix stripping without reading", async () => {
    const { tool, execute } = createToolHarness();
    await expect(
      createOpenClawReadTool(tool).execute("empty", { path: "</arg_value>>" }),
    ).rejects.toThrow(/Missing required parameter: path/);
    expect(execute).not.toHaveBeenCalled();
  });
});
