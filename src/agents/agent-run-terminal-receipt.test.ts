import { describe, expect, it } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  formatAgentRunRouteChange,
  type AgentRunTerminalReceipt,
} from "./agent-run-terminal-receipt.js";
import { isProviderModelRerouted } from "./provider-model-route.js";

const visibleRerouteReceipt: AgentRunTerminalReceipt = {
  runId: "run-1",
  sessionId: "session-1",
  turnId: "turn-1",
  requested: { provider: "provider", model: "requested" },
  effective: { provider: "provider", model: "configured", responseModel: "actual" },
  successfulToolNames: [],
  rerouted: true,
  terminalDisposition: "visible",
};
const modelDefaults = {
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
  responseModelEquivalent: true,
} satisfies Partial<ModelDefinitionConfig>;
function declaredConfig(
  provider = "broker",
  modelId = "team/chat",
  overrides: Partial<ModelDefinitionConfig> = {},
): OpenClawConfig {
  const row = { ...modelDefaults, id: modelId, name: modelId, ...overrides };
  const providerConfig = { baseUrl: "https://endpoint.example/v1", models: [row] };
  return { models: { providers: { [provider]: providerConfig } } };
}

describe("isProviderModelRerouted", () => {
  it("keeps an equivalent vendor wire id from producing a model-switch fact", () => {
    const requested = { provider: "arcee", model: "trinity-large-thinking" };
    const effective = {
      provider: "arcee",
      model: "arcee-ai/trinity-large-thinking",
      responseModel: "arcee-ai/trinity-large-thinking",
    };
    const rerouted = isProviderModelRerouted(requested, effective);
    expect(rerouted).toBe(false);
    expect(
      formatAgentRunRouteChange(
        { ...visibleRerouteReceipt, requested, effective, rerouted },
        "run-1",
      ),
    ).toBeUndefined();
  });

  describe("with a configured model row declaring response model equivalence", () => {
    const requested = { provider: "broker", model: "team/chat" };
    const config = declaredConfig();
    it.each([
      ["declared endpoint", {}, config, false],
      ["undeclared endpoint", {}, undefined, true],
      ["model fallback", { model: "team/utility" }, config, true],
      ["provider fallback", { provider: "other-broker" }, config, true],
      [
        "catalog-authored row",
        {},
        declaredConfig("broker", "team/chat", { metadataSource: "models-add" }),
        true,
      ],
    ] satisfies Array<[string, Partial<typeof requested>, OpenClawConfig | undefined, boolean]>)(
      "classifies %s",
      (_name, changes, cfg, expected) => {
        expect(
          isProviderModelRerouted(
            requested,
            { ...requested, responseModel: "upstream-model-2026-10-01", ...changes },
            cfg,
          ),
        ).toBe(expected);
      },
    );

    it("keeps bundled provider policy authoritative", () => {
      const openaiRequested = { provider: "openai", model: "gpt-5.6" };
      const effective = { ...openaiRequested, responseModel: "gpt-5.6-luna" };
      expect(isProviderModelRerouted(openaiRequested, effective)).toBe(true);
      expect(
        isProviderModelRerouted(openaiRequested, effective, declaredConfig("openai", "gpt-5.6")),
      ).toBe(true);
    });

    it("respects global catalog alias ownership for partner-chat", () => {
      const provider = "partner-chat";
      const snapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "catalog-owner",
            providers: ["catalog-provider"],
            modelCatalog: { aliases: { [provider]: { provider: "catalog-provider" } } },
            origin: "global",
          },
        ],
      });
      withPluginMetadataSnapshotScope(snapshot, () => {
        const alias = { provider, model: "team/chat" };
        expect(
          isProviderModelRerouted(
            alias,
            { ...alias, responseModel: "upstream-model" },
            declaredConfig(provider, alias.model),
          ),
        ).toBe(false);
      });
    });
  });

  it("keeps an OpenAI dated response equivalent to its requested model", () => {
    const requested = { provider: "openai", model: "gpt-5.6-luna" };
    expect(
      isProviderModelRerouted(requested, {
        ...requested,
        responseModel: "gpt-5.6-luna-2026-08-02",
      }),
    ).toBe(false);
  });
});

describe("formatAgentRunRouteChange", () => {
  it("uses the producer response model", () => {
    expect(formatAgentRunRouteChange(visibleRerouteReceipt, "run-1")).toBe(
      "Model route changed: provider/requested → provider/actual.",
    );
  });

  it("redacts and bounds route text", () => {
    const secret = `sk-${"s".repeat(96)}`;
    const routeChange = formatAgentRunRouteChange(
      {
        ...visibleRerouteReceipt,
        requested: { provider: "provider", model: secret },
        effective: {
          provider: "provider",
          model: "configured",
          responseModel: "m".repeat(500),
        },
      },
      "run-1",
    );

    expect(routeChange).not.toContain(secret);
    expect(routeChange?.length).toBeLessThanOrEqual(320);
  });
});
