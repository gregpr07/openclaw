import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { applyEmbeddedAttemptToolsAllow } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { buildEmbeddedAttemptToolRunContext } from "./embedded-agent-runner/run/attempt-tool-run-context.js";
import { configureMockSubagentRegistryPersistence } from "./subagent-test-fixtures.test-helpers.js";
import {
  addSubagentRunForTests,
  getSubagentRunByRunId,
  resetSubagentRegistryForTests,
} from "./subagents/registry/subagent-registry.test-helpers.js";
import { consumeSwarmStructuredOutput } from "./tools/structured-output-tool.js";

const runId = "collector-tool-contract";
const sessionKey = "agent:main:subagent:collector-contract";
const config = { agents: { entries: { main: {} } }, tools: { swarm: true } };
const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};
let workspaceDir: string;

beforeEach(async () => {
  setRuntimeConfigSnapshot(config);
  workspaceDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "collector-tools-")));
  await resetSubagentRegistryForTests({ persist: false });
  await configureMockSubagentRegistryPersistence({ persistRegistryRows: () => {} });
});

afterEach(async () => {
  consumeSwarmStructuredOutput(runId);
  await resetSubagentRegistryForTests({ persist: false });
  await fs.rm(workspaceDir, { recursive: true, force: true });
  clearRuntimeConfigSnapshot();
});

it.each([{ toolsAllow: undefined }, { toolsAllow: [] }])(
  "constructs the real attempt collector surface %j",
  async ({ toolsAllow }) => {
    await addSubagentRunForTests({
      runId,
      childSessionKey: sessionKey,
      collect: true,
      outputSchema: schema,
    });
    const context = buildEmbeddedAttemptToolRunContext({
      toolsAllow,
      swarmCollector: true,
      swarmOutputSchema: schema,
    });
    const constructedTools = createOpenClawCodingTools({
      ...context,
      config,
      agentId: "main",
      modelProvider: "openai",
      modelId: "gpt-5.6-luna",
      disableMessageTool: true,
      runId,
      sessionKey,
      workspaceDir,
      cwd: workspaceDir,
    });
    const tools = applyEmbeddedAttemptToolsAllow(constructedTools, context.runtimeToolAllowlist);
    const names = tools.map((tool) => tool.name);
    const find = (name: string) =>
      expectDefined(
        tools.find((tool) => tool.name === name),
        name,
      );
    if (toolsAllow) {
      expect(names.toSorted()).toEqual([...toolsAllow, "structured_output"].toSorted());
    }
    for (const forbidden of ["ask_user", "sessions_send", "sessions_yield", "message"]) {
      expect(names).not.toContain(forbidden);
    }
    if (!toolsAllow) {
      expect(names).toEqual(
        expect.arrayContaining(["read", "write", "edit", "apply_patch", "exec", "process"]),
      );
      await find("write").execute("collector-write", {
        path: "result.txt",
        content: "collector file proof",
      });
      const result = await find("read").execute("collector-read", { path: "result.txt" });
      expect(result.content).toContainEqual(
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("collector file proof"),
        }),
      );
    }
    const output = find("structured_output");
    expect(output.catalogMode).toBe("direct-only");
    const result = await output.execute("collector-result", { result: { answer: "ok" } });
    expect(result.details).toEqual({ status: "recorded" });
    expect(getSubagentRunByRunId(runId)?.structuredOutput).toEqual({
      structured: { answer: "ok" },
      invalidAttempts: 0,
    });
  },
);
