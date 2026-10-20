import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import * as openClawPluginTools from "./openclaw-plugin-tools.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

type CodingTools = ReturnType<typeof createOpenClawCodingTools>;
const pluginOnlyConstructionPlan = {
  includeBaseCodingTools: false,
  includeShellTools: false,
  includeChannelTools: false,
  includeOpenClawTools: false,
  includePluginTools: true,
};

export function registerPluginOnlyCallerIdentityCase({
  testConfig,
  requireTool,
}: {
  testConfig: OpenClawConfig;
  requireTool: (tools: CodingTools, name: string) => CodingTools[number];
}) {
  describe("plugin-only caller identity", () => {
    let identity: ReturnType<typeof getGatewayToolCallerIdentity>;
    let restore: () => void;
    beforeEach(() => {
      identity = undefined;
      const spy = vi
        .spyOn(openClawPluginTools, "resolveOpenClawPluginToolsForOptions")
        .mockReturnValue([
          {
            name: "file_fetch",
            label: "File fetch",
            description: "Fetch a file",
            parameters: { type: "object", properties: {} },
            execute: async () => {
              identity = getGatewayToolCallerIdentity();
              return { content: [{ type: "text" as const, text: "ok" }], details: {} };
            },
          },
        ]);
      restore = () => {
        spy.mockRestore();
      };
    });
    afterEach(() => restore());
    async function execute(options: NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>) {
      const tools = createOpenClawCodingTools({
        agentId: "main",
        includeCoreTools: false,
        toolConstructionPlan: pluginOnlyConstructionPlan,
        ...options,
      });
      await requireTool(tools, "file_fetch").execute?.("tool-call", {});
      return identity;
    }
    it("wraps plugin-only tools with scheduled creator authority and live routing context", async () => {
      const observedIdentity = await execute({
        config: {
          ...testConfig,
          channels: { discord: { accounts: { creator: {} } } },
        },
        sessionKey: "agent:main:telegram:direct:alice",
        messageProvider: "discord-voice",
        messageChannel: "discord",
        messageTo: "channel:123",
        agentAccountId: "work",
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:discord:group:ops",
          ownerAccountId: "creator",
          ownerOrigin: { kind: "external", channel: "discord" },
        },
        messageThreadId: "42",
        runtimeToolAllowlist: ["file_fetch"],
        inheritRuntimeToolAllowlist: true,
      });
      expect(observedIdentity).toEqual({
        agentId: "main",
        assertToolAllowed: expect.any(Function),
        personalToolIdentityScoped: undefined,
        personalToolParticipants: undefined,
        personalToolSelection: undefined,
        personalToolUser: undefined,
        requesterOrigin: expect.objectContaining({
          sessionKey: "agent:main:telegram:direct:alice",
          messageProvider: "discord-voice",
          accountId: "work",
          messageThreadId: "42",
        }),
        sessionEventDelivery: undefined,
        sessionEventSettings: { permissionMode: undefined },
        sessionEventToolsAllow: ["file_fetch"],
        sessionKey: "agent:main:telegram:direct:alice",
        turnSourceChannel: "discord",
        turnSourceTo: "channel:123",
        turnSourceAccountId: "creator",
        turnSourceThreadId: "42",
      });
      expect(() => observedIdentity?.assertToolAllowed?.("file_fetch")).not.toThrow();
      expect(() => observedIdentity?.assertToolAllowed?.("exec")).toThrow(
        "exec is not allowed by this conversation's tool policy",
      );
    });

    it("carries this turn's provider-hosted web_search decision into session events", async () => {
      const options = { config: testConfig, sessionKey: "agent:main:main" };
      expect((await execute(options))?.sessionEventToolsAllow).toEqual([
        "file_fetch",
        "web_search",
      ]);
      // A producer whose policy denies web_search passes no hosted search to its events.
      const denied = await execute({
        ...options,
        config: { ...testConfig, tools: { ...testConfig.tools, deny: ["web_search"] } },
      });
      expect(denied?.sessionEventToolsAllow).toEqual(["file_fetch"]);
    });
  });
}
