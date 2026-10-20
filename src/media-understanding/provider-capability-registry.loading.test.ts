import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { waitForPluginCacheRetirement } from "../plugins/plugin-cache.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { buildMediaUnderstandingCapabilityRegistry } from "./provider-capability-registry.js";

let root: string;
type LoadingCase = [
  name: string,
  active: boolean,
  providerId: string,
  configuredId?: string,
  imageFallback?: boolean,
  taggedPeers?: boolean,
];

async function resetFixtureState() {
  resetPluginRuntimeStateForTest();
  await waitForPluginCacheRetirement();
}

function createMediaOwner(pluginId: string, providerId: string) {
  const rootDir = path.join(root, pluginId);
  fs.mkdirSync(rootDir);
  const fixture = createColdPluginFixture({
    rootDir,
    pluginId,
    providerId,
    manifest: {
      channels: [],
      providers: [],
      activation: { onStartup: false },
      contracts: { mediaUnderstandingProviders: [providerId] },
    },
  });
  fs.writeFileSync(
    fixture.runtimeSource,
    `require("node:fs").appendFileSync(${JSON.stringify(fixture.runtimeMarker)}, ${JSON.stringify("import\n")});
module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    api.registerMediaUnderstandingProvider({
      id: ${JSON.stringify(providerId)}, capabilities: ["audio"]
    });
  }
};
`,
  );
  return fixture;
}

describe("media capability inference owner loading", () => {
  beforeEach(async () => {
    await resetFixtureState();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-media-inference-"));
  });

  afterEach(async () => {
    await resetFixtureState();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each<LoadingCase>([
    ["direct active provider", true, "qa-audio"],
    ["cold runtime-only provider", false, "qa-audio"],
    ["normalized media alias", true, "google", " GEMINI "],
    ["plugin capability ahead of config image fallback", true, "qa-audio", undefined, true],
    ["provider alongside tagged peers", true, "qa-audio", undefined, false, true],
  ])(
    "infers a %s without importing unrelated owners",
    (
      _name,
      active,
      providerId,
      configuredId = providerId,
      imageFallback = false,
      taggedPeers = false,
    ) => {
      const selected = createMediaOwner("qa-selected-owner", providerId);
      const unrelated = createMediaOwner("qa-unrelated-owner", "qa-unrelated");
      const config: OpenClawConfig = {
        plugins: {
          allow: [selected.pluginId, unrelated.pluginId],
          load: { paths: [selected.rootDir, unrelated.rootDir] },
          entries: Object.fromEntries(
            [selected, unrelated].map(({ pluginId }) => [pluginId, { enabled: true }]),
          ),
        },
        tools: {
          media: {
            models: [
              ...(taggedPeers
                ? [
                    { provider: configuredId, capabilities: ["image" as const] },
                    { provider: unrelated.providerId, capabilities: ["audio" as const] },
                  ]
                : []),
              { provider: configuredId },
            ],
          },
        },
      };
      if (imageFallback) {
        config.models = {
          providers: {
            [providerId]: {
              baseUrl: "https://example.invalid",
              models: [
                {
                  id: "fixture-image",
                  name: "Fixture image",
                  reasoning: false,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  maxTokens: 1024,
                },
              ],
            },
          },
        };
      }
      const registry = createEmptyPluginRegistry();
      if (active) {
        registry.mediaUnderstandingProviders.push({
          pluginId: selected.pluginId,
          pluginName: "Selected fixture",
          source: selected.runtimeSource,
          provider: { id: providerId, capabilities: ["audio"] },
        });
      }

      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [selected, unrelated].map((fixture) => ({
          id: fixture.pluginId,
          origin: "global",
          rootDir: fixture.rootDir,
          source: fixture.runtimeSource,
          configSchema: { type: "object" },
          contracts: { mediaUnderstandingProviders: [fixture.providerId] },
        })),
      });
      const capabilities = withPluginRuntimeGenerationScope(
        { metadataSnapshot, pluginRegistry: registry },
        () => buildMediaUnderstandingCapabilityRegistry(config),
      );
      expect(capabilities.get(providerId)?.capabilities).toEqual(["audio"]);
      expect(fs.existsSync(unrelated.runtimeMarker)).toBe(false);
      expect(fs.existsSync(selected.runtimeMarker)).toBe(!active);
    },
  );
});
