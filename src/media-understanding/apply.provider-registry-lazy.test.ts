import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";

type TestCatalogEntry = { id: string; name: string; provider: string; input: readonly string[] };

const model = { id: "gpt-5.4", name: "GPT-5.4", provider: "usage-proxy" };
const baseCatalog: TestCatalogEntry[] = [{ ...model, input: ["text", "image"] }];
let catalog: TestCatalogEntry[] = [...baseCatalog];

const loadModelCatalog = vi.hoisted(() => vi.fn(async (_params: unknown) => catalog));
const resolvePluginCapabilityProvidersSpy = vi.hoisted(() => vi.fn());

vi.mock("../agents/image-compression-policy.js", () => ({
  resolveImageCompressionModelPolicy: vi.fn(async () => ({})),
}));

vi.mock("../agents/model-auth.js", async () => {
  const { createAvailableModelAuthMockModule } = await import("./runner.test-mocks.js");
  return createAvailableModelAuthMockModule();
});

vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: (params: { key: string }) => {
    if (params.key === "mediaUnderstandingProviders") {
      resolvePluginCapabilityProvidersSpy(params);
    }
    return [];
  },
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: loadModelCatalog,
}));

let applyMediaUnderstanding: typeof import("./apply.js").applyMediaUnderstanding;
const activeModel = { provider: "usage-proxy", model: "gpt-5.4" };
const visionConfig: OpenClawConfig = {
  models: {
    providers: {
      "usage-proxy": {
        baseUrl: "https://example.test/v1",
        models: [
          {
            id: model.id,
            name: model.name,
            input: ["text", "image"],
            reasoning: false,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 128,
          },
        ],
      },
    },
  },
};

function configWithModels(capabilities?: ("image" | "audio" | "video")[]): OpenClawConfig {
  return capabilities
    ? {
        ...visionConfig,
        tools: { media: { models: [{ provider: model.provider, capabilities }] } },
      }
    : { ...visionConfig };
}

function breakRegistry() {
  resolvePluginCapabilityProvidersSpy.mockImplementation(() => {
    throw new Error("registry build failed");
  });
}

function imageContext(withAudio = false): MsgContext {
  return {
    media: [
      { path: "/tmp/image.png", contentType: "image/png" },
      ...(withAudio ? [{ path: "/tmp/note.ogg", contentType: "audio/ogg" }] : []),
    ],
  };
}

const apply = (ctx: MsgContext, cfg: OpenClawConfig) =>
  applyMediaUnderstanding({ ctx, cfg, activeModel });

describe("applyMediaUnderstanding - lazy provider registry", () => {
  beforeAll(async () => {
    ({ applyMediaUnderstanding } = await import("./apply.js"));
  });

  beforeEach(() => {
    catalog = [...baseCatalog];
    resolvePluginCapabilityProvidersSpy.mockReset();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it.each(["explicit image model", "text-only model", "mixed image and audio"])(
    "builds the registry once for a turn with %s",
    async (scenario) => {
      const cfg: OpenClawConfig = scenario === "text-only model" ? {} : { ...visionConfig };
      if (scenario === "text-only model") {
        catalog = [{ ...model, input: ["text"] }];
      } else if (scenario === "explicit image model") {
        cfg.tools = configWithModels(["image"]).tools;
      }
      await apply(imageContext(scenario === "mixed image and audio"), cfg);
      expect(resolvePluginCapabilityProvidersSpy).toHaveBeenCalledTimes(1);
    },
  );

  it("a registry build failure still rejects the whole apply (caller's raw-content fallback), built once", async () => {
    breakRegistry();
    catalog = [{ ...model, input: ["text"] }];
    const ctx = imageContext(true);

    await expect(apply(ctx, {})).rejects.toThrow("registry build failed");
    expect(resolvePluginCapabilityProvidersSpy).toHaveBeenCalledTimes(1);
    expect(ctx.MediaUnderstandingDecisions).toBeUndefined();
  });

  it.each([
    { name: "no shared models", capabilities: undefined },
    { name: "audio and video shared models", capabilities: ["audio", "video"] },
  ] as const)(
    "keeps the native-vision handoff with $name and a broken registry",
    async ({ capabilities }) => {
      breakRegistry();
      const cfg = configWithModels(capabilities ? [...capabilities] : undefined);
      const ctx = imageContext();
      await expect(apply(ctx, cfg)).resolves.toEqual({
        extractedFileImages: [],
      });
      expect(ctx.MediaUnderstandingDecisions).toContainEqual(
        expect.objectContaining({
          capability: "image",
          outcome: "skipped",
          nativeVisionActive: true,
          attachmentDispositions: { 0: { kind: "handed-to-native-vision" } },
        }),
      );
      expect(resolvePluginCapabilityProvidersSpy).not.toHaveBeenCalled();
    },
  );
});
