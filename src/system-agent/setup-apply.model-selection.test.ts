import { describe, expect, it } from "vitest";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { buildAllowedModelSet } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretInput } from "../config/types.secrets.js";
import {
  applySystemAgentModelSelection,
  projectSetupInferenceConfig,
} from "./setup-model-selection.js";

describe("projectSetupInferenceConfig", () => {
  const profileId = "omlx:setup-proof";
  const keyRef = { source: "env", provider: "default", id: "OMLX_API_KEY" } as const;
  const referencedCredential = { type: "api_key", provider: "omlx", keyRef } as const;
  const apiKeyCredential = (key: string, provider = "omlx") =>
    ({ type: "api_key", provider, key }) as const;
  const providerConfig = (port: number, apiKey?: SecretInput) => ({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey,
    models: [],
  });

  it.each<
    [
      string,
      Extract<AuthProfileCredential, { type: "api_key" | "token" }>,
      SecretInput,
      SecretInput?,
    ]
  >([
    ["core no-auth marker", apiKeyCredential("custom-local", "custom-studio"), "custom-local"],
    ["bundled oMLX no-auth marker", apiKeyCredential("omlx-local"), "omlx-local"],
    ["literal API key", apiKeyCredential("synthetic-api-key"), profileId],
    ["real token", { type: "token", provider: "omlx", token: "synthetic-token" }, profileId],
    ["environment marker", apiKeyCredential("OMLX_API_KEY"), profileId],
    [
      "environment SecretRef",
      referencedCredential,
      { source: "env", provider: "default", id: "OMLX_API_KEY" },
    ],
    ["environment template reference", referencedCredential, "${OMLX_API_KEY}", "${OMLX_API_KEY}"],
    ["profile binding backed by a SecretRef", referencedCredential, profileId, profileId],
  ])(
    "preserves credential semantics for %s",
    (_name, credential, expectedApiKey, providerApiKey) => {
      const provider = credential.provider;
      const prepared: OpenClawConfig = {
        models: {
          providers: {
            [provider.toUpperCase()]: providerConfig(8003, "stale-prepared-alias"),
            [provider]: providerConfig(
              8000,
              providerApiKey ??
                (credential.type === "token"
                  ? credential.token
                  : (credential.key ?? credential.keyRef)),
            ),
          },
        },
      };

      const projected = projectSetupInferenceConfig({
        base: {
          models: {
            providers: {
              [provider.toUpperCase()]: providerConfig(8001, "old-alias-key"),
              [provider]: providerConfig(8002, "old-canonical-key"),
              sibling: { baseUrl: "http://127.0.0.1:9000/v1", models: [] },
            },
          },
        },
        prepared,
        modelRef: `${provider}/local-model`,
        agentId: "main",
        profileId,
        credential,
      });

      expect(projected.models?.providers).toEqual({
        sibling: { baseUrl: "http://127.0.0.1:9000/v1", models: [] },
        [provider]: { ...prepared.models?.providers?.[provider], apiKey: expectedApiKey },
      });
    },
  );
});

describe("applySystemAgentModelSelection", () => {
  it("adds a utility without changing other bindings", async () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          systemAgent: { agentId: "main" },
          model: {
            primary: "openai/gpt-5.5@openai:primary",
            fallbacks: ["openai/gpt-5.4@openai:backup"],
          },
          models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
        },
        entries: {
          main: { agentDir: "/tmp/main-auth" },
          ops: { model: "openai/gpt-5.4" },
        },
      },
      auth: {
        profiles: {
          "openai:primary": { provider: "openai", mode: "api_key" },
          "openai:utility": { provider: "openai", mode: "api_key" },
        },
        order: { openai: ["openai:primary", "openai:utility"] },
      },
    };
    const original = structuredClone(config);

    const result = await applySystemAgentModelSelection({
      config,
      model: "openai/gpt-5.5",
      modelTarget: "utility",
      authProfileId: "openai:utility",
    });

    expect(result.agents?.defaults).toEqual({
      ...config.agents?.defaults,
      utilityModel: "openai/gpt-5.5@openai:utility",
    });
    expect(result.agents?.entries).toEqual(config.agents?.entries);
    expect(result.auth).toEqual(config.auth);
    expect(config).toEqual(original);
  });

  it("writes a utility selection only to its agent owner", async () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          systemAgent: { agentId: "ops" },
          model: "openai/gpt-5.5",
          utilityModel: "local-utility/shared",
        },
        entries: {
          main: {},
          ops: {
            model: { primary: "openai/gpt-5.4", fallbacks: ["openai/gpt-5.5"] },
            agentDir: "/tmp/ops-auth",
          },
        },
      },
    };

    const result = await applySystemAgentModelSelection({
      config,
      model: "local-utility/tiny",
      modelTarget: "utility",
      targetAgentId: "ops",
    });

    expect(result.agents?.defaults).toEqual(config.agents?.defaults);
    expect(result.agents?.entries?.main).toEqual(config.agents?.entries?.main);
    expect(result.agents?.entries?.ops).toEqual({
      ...config.agents?.entries?.ops,
      utilityModel: "local-utility/tiny",
      models: { "local-utility/tiny": {} },
    });
  });

  it.each(["defaults", "agent"] as const)(
    "keeps %s utility fallbacks when setup replaces the primary",
    async (owner) => {
      const utilityModel = { primary: "local/old", fallbacks: ["local/backup"] };
      const config: OpenClawConfig = {
        agents: {
          defaults: { utilityModel },
          entries: { main: owner === "agent" ? { utilityModel } : {} },
        },
      };
      const result = await applySystemAgentModelSelection({
        config,
        model: "local/new",
        modelTarget: "utility",
      });
      expect(
        owner === "agent"
          ? result.agents?.entries?.main?.utilityModel
          : result.agents?.defaults?.utilityModel,
      ).toEqual({ primary: "local/new", fallbacks: ["local/backup"] });
    },
  );

  it("keeps a newly approved model allowed when migrating a first-run legacy model map", async () => {
    const cfg = await applySystemAgentModelSelection({
      config: { agents: { defaults: { models: { "fixture/old": {} } } } },
      model: "fixture/new",
      agentRuntimeId: "openclaw",
      runtimeInDefaults: true,
    });
    const allowed = buildAllowedModelSet({ cfg, catalog: [], defaultProvider: "fixture" });
    expect(allowed.allows({ provider: "fixture", model: "new" })).toBe(true);
    expect(allowed.allows({ provider: "fixture", model: "old" })).toBe(true);
    expect(allowed.allows({ provider: "fixture", model: "unapproved" })).toBe(false);
  });

  it("rejects an unrepresentable explicit agent instead of updating main", async () => {
    const config = {
      agents: {
        entries: { main: {}, ops: {} },
      },
    } satisfies OpenClawConfig;

    await expect(
      applySystemAgentModelSelection({
        config,
        model: "openai/gpt-5.5",
        targetAgentId: "агент✨",
      }),
    ).rejects.toThrow('Could not resolve configured agent "агент✨".');
    expect(config.agents.entries.main).toEqual({});
  });

  it("updates the primary selection to the native runtime without changing unrelated bindings", async () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: { models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } } },
        entries: {
          work: {
            model: "openai/gpt-5.5",
            models: {
              "openai/gpt-5.5": { alias: "primary", agentRuntime: { id: "codex" } },
            },
          },
        },
      },
    };
    const result = await applySystemAgentModelSelection({
      config,
      model: "openai/gpt-5.5",
    });
    expect(result.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime).toBeUndefined();
    expect(result.agents?.entries?.work?.models?.["openai/gpt-5.5"]).toEqual({
      alias: "primary",
    });
    expect(result.agents?.entries?.work?.model).toBe("openai/gpt-5.5");
  });
});
