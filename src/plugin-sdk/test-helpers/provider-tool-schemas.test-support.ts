import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";

export function useProviderToolSchemaRuntimeForTest(pluginIds: readonly string[]): void {
  let install: () => void = () => {
    throw new Error("Provider tool-schema fixture was not prepared");
  };
  let close = async () => {};
  let restore = () => {};
  beforeAll(async () => {
    const [loader, metadata, caches, scopes, handles, runtime, registry, snapshots] =
      await Promise.all([
        import("../../plugins/loader.js"),
        import("../../plugins/plugin-metadata-snapshot.js"),
        import("../../plugins/plugin-cache.js"),
        import("../../plugins/runtime/generation-scope.js"),
        import("../../plugins/provider-hook-runtime.js"),
        import("../../plugins/provider-runtime.js"),
        import("../../plugins/runtime.js"),
        import("../../config/runtime-snapshot.js"),
      ]);
    const config = {
      plugins: {
        allow: [...pluginIds],
        entries: Object.fromEntries(pluginIds.map((id) => [id, { enabled: true }])),
      },
    };
    const cache = caches.createPluginCache();
    const closeCache = async () => {
      expect((await caches.retirePluginCache(cache)).failures).toEqual([]);
    };
    close = closeCache;
    const prepared = caches.withPluginCache(cache, () => {
      const previousConfig = snapshots.getRuntimeConfigSnapshot();
      const previousSource = snapshots.getRuntimeConfigSourceSnapshot();
      snapshots.setRuntimeConfigSnapshot(config);
      try {
        return {
          metadataSnapshot: metadata.loadPluginMetadataSnapshot({ config }),
          pluginRegistry: loader.loadOpenClawPlugins({
            config,
            onlyPluginIds: [...pluginIds],
            activate: false,
            throwOnLoadError: true,
          }),
        };
      } finally {
        if (previousConfig) {
          snapshots.setRuntimeConfigSnapshot(previousConfig, previousSource ?? undefined);
        } else {
          snapshots.clearRuntimeConfigSnapshot();
        }
      }
    });
    const normalize = runtime.normalizeProviderToolSchemasWithPlugin;
    const inspect = runtime.inspectProviderToolSchemasWithPlugin;
    const prepare = (params: Parameters<typeof normalize>[0]) => {
      const { provider, context, workspaceDir, env } = params;
      if (params.runtimeHandle || !pluginIds.includes(params.provider)) {
        return params;
      }
      return {
        ...params,
        runtimeHandle: scopes.withPluginRuntimeGenerationScope(prepared, () =>
          handles.resolveProviderRuntimePluginHandle({
            provider,
            modelId: context.modelId,
            config: params.config,
            workspaceDir,
            env,
          }),
        ),
      };
    };
    install = () => {
      const normalizeSpy = vi
        .spyOn(runtime, "normalizeProviderToolSchemasWithPlugin")
        .mockImplementation((params) => normalize(prepare(params)));
      const inspectSpy = vi
        .spyOn(runtime, "inspectProviderToolSchemasWithPlugin")
        .mockImplementation((params) => inspect(prepare(params)));
      restore = () => {
        normalizeSpy.mockRestore();
        inspectSpy.mockRestore();
      };
    };
    close = async () => {
      try {
        expect(
          (await registry.disposePluginRegistryInstances(prepared.pluginRegistry)).failures,
        ).toEqual([]);
      } finally {
        await closeCache();
      }
    };
  });
  beforeEach(() => install());
  afterEach(() => restore());
  afterAll(async () => {
    restore();
    await close();
  });
}
