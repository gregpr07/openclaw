import fs from "node:fs";
import JSON5 from "json5";
import { describe, expect, it, vi } from "vitest";
import {
  createSystemAgentTool,
  type SystemAgentToolOptions,
} from "../agents/tools/system-agent-tool.js";
import {
  createTestRuntime,
  useConfigCliIntegrationHarness,
} from "../cli/config-cli.integration.test-harness.js";
import { executeSystemAgentOperation } from "./operations.js";

const audit = vi.hoisted(() => vi.fn());
vi.mock("./audit.js", () => ({ appendSystemAgentAuditEntry: audit }));

const { withConfigFileHarness } = useConfigCliIntegrationHarness();

// Real model-facing proposal, host approval, and config writer; only audit storage is mocked.
describe("setup config unset", () => {
  it.each([false, true])(
    "removes only the approved field unless authority expires during preparation=%s",
    async (expireAuthority) => {
      const retained = {
        thinkingDefault: "high",
        models: { "openai/gpt-5.2": { params: { fastMode: true } } },
        modelPolicy: { allow: ["openai/gpt-5.2"] },
      };
      const gateway = { mode: "local" };
      const raw = JSON.stringify({
        gateway,
        agents: { defaults: { fastModeDefault: false, ...retained } },
      });
      await withConfigFileHarness("openclaw-setup-unset-", raw, async ({ configPath }) => {
        audit.mockClear();
        const proposalRef: NonNullable<SystemAgentToolOptions["proposalRef"]> = {};
        const directiveRef: NonNullable<SystemAgentToolOptions["directiveRef"]> = {};
        const args = { action: "config_unset", path: "agents.defaults.fastModeDefault" };
        const tool = createSystemAgentTool({ surface: "gateway", proposalRef, directiveRef });
        await tool.execute("propose", { ...args, approved: true });
        expect(tool.parameters).toMatchObject({
          properties: { action: { enum: expect.arrayContaining(["config_unset"]) } },
        });
        expect(proposalRef.operation).toEqual({ kind: "config-unset", path: args.path });
        expect(directiveRef.current).toBeUndefined();
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        expect(audit).not.toHaveBeenCalled();

        await createSystemAgentTool({
          surface: "gateway",
          proposalRef,
          directiveRef,
          approvalArmed: true,
        }).execute("approve", { ...args, approved: true });
        const directive = directiveRef.current;
        if (directive?.kind !== "approved-operation") {
          throw new Error("Expected the approved deletion to reach the host");
        }
        const output = createTestRuntime();
        let active = true;
        const configCli = await import("../cli/config-cli.js");
        const runConfigUnset = configCli.runConfigUnset;
        vi.spyOn(configCli, "runConfigUnset").mockImplementation((params) => {
          const result = runConfigUnset(params);
          // Revoke after CLI preparation starts, before its persistence guard runs.
          if (expireAuthority) {
            active = false;
          }
          return result;
        });
        const apply = () =>
          executeSystemAgentOperation(directive.operation, output.runtime, {
            approved: true,
            beforePersistentApply: () => {
              if (!active) {
                throw new Error("request authority expired");
              }
            },
          });
        if (expireAuthority) {
          await expect(apply()).rejects.toThrow();
          expect(output.errors.join("\n")).toContain("request authority expired");
          expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
          expect(audit).not.toHaveBeenCalled();
          return;
        }
        expect(await apply()).toEqual({ applied: true });
        expect(JSON5.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
          gateway,
          agents: { defaults: retained },
        });
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({
            operation: "config.unset",
            details: { path: args.path },
          }),
        );
      });
    },
  );
});
