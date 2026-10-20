import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { registerAgentHarness } from "../agents/harness/registry.js";
import type { SessionEntry } from "../config/sessions.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createOperatorWsClient } from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import type { GatewaySessionRow } from "./session-utils.types.js";
import { agentDiscoveryMock, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
type SessionPage = { sessions: GatewaySessionRow[]; totalCount: number; nextOffset?: number };
let originalRegistry: ReturnType<typeof getActivePluginRegistry>;
beforeEach(() => {
  originalRegistry = getActivePluginRegistry();
  setActivePluginRegistry(createEmptyPluginRegistry());
  registerAgentHarness({
    id: "repository-device",
    label: "Repository device",
    autoSelection: { providerIds: ["repository-provider"] },
    supports: () => ({ supported: true }),
    cloudPlacement: {
      mode: "remote-exec",
      devicePlacement: {
        requiredNodeCommands: ["runtime.repository.v1"],
        consumesWorkerSlot: false,
      },
    },
    runAttempt: async () => {
      throw new Error("selection must not execute the runtime");
    },
  });
});
afterEach(() => {
  if (originalRegistry) {
    setActivePluginRegistry(originalRegistry);
  }
});

test("sessions.dispatch admits the runtime offered after a repository child's parent changes model", async () => {
  await createSessionStoreDir();
  const configModule = await getGatewayConfigModule();
  const base = configModule.getRuntimeConfig();
  configModule.setRuntimeConfigSnapshot({
    ...base,
    agents: {
      ...base.agents,
      defaults: { ...base.agents?.defaults, model: { primary: "fixture-cli/local" } },
    },
    cloudWorkers: { profiles: { test: { provider: "fake" } } },
  });
  const registry = expectDefined(getActivePluginRegistry(), "test registry");
  registry.cliBackends.push({
    pluginId: "fixture-cli",
    pluginName: "Fixture CLI",
    backend: { id: "fixture-cli", config: { command: "not-executed" } },
    source: "test",
  });
  agentDiscoveryMock.models = [
    { provider: "parent-api", id: "worker-model" },
    { provider: "fixture-cli", id: "local" },
  ];
  const client = createOperatorWsClient();
  const request = <T = unknown>(...args: Parameters<typeof directSessionReq>) =>
    directSessionReq<T>(args[0], args[1], { ...args[2], client });
  const parentKey = "agent:main:main";
  const childKey = "agent:main:repository-child";
  expect((await request("sessions.create", { key: parentKey })).ok).toBe(true);
  const created = await request<{ entry: SessionEntry }>("sessions.create", {
    key: childKey,
    parentSessionKey: parentKey,
    repository: { url: "https://github.com/openclaw/openclaw" },
  });
  expect(created.ok).toBe(true);
  expect(created.payload?.entry.modelOverride).toBeUndefined();
  const patched = await request("sessions.patch", {
    key: parentKey,
    model: "parent-api/worker-model",
  });
  expect({ ok: patched.ok, error: patched.error }).toEqual({ ok: true, error: undefined });
  const listed = await request<SessionPage>("sessions.list", {});
  const child = listed.payload?.sessions.find((row) => row.key === childKey);
  expect(child).toMatchObject({
    modelProvider: "parent-api",
    model: "worker-model",
    modelOverrideSource: "inherited",
    agentRuntime: { id: "openclaw", cloudPlacementSupported: true },
  });
  const dispatch = vi
    .fn<NonNullable<GatewayRequestContext["workerPlacementDispatchService"]>["dispatch"]>()
    .mockRejectedValue(new Error("admitted to placement service"));
  const result = await request(
    "sessions.dispatch",
    { key: childKey, profileId: "test" },
    {
      context: {
        workerPlacementDispatchService: { dispatch },
        workerSessionPlacementService: { getMany: () => new Map() },
        workerEnvironmentService: { supportsExecutionMode: () => true },
      },
    },
  );
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionKey: childKey,
      executionMode: "worker-turn",
      profileId: "test",
    }),
    expect.any(Function),
    undefined,
    undefined,
  );
  expect(result.error?.message).toBe("admitted to placement service");
});

test("sessions.list searches the displayed automatic runtime before applying pagination", async () => {
  await createSessionStoreDir();
  const entry = (
    sessionId: string,
    updatedAt: number,
    providerOverride = "repository-provider",
    modelOverride = "repository-model",
  ): SessionEntry => ({ sessionId, updatedAt, providerOverride, modelOverride });
  const entries: Record<string, SessionEntry> = {};
  for (let index = 0; index < 3; index++) {
    entries[`agent:main:selection-${index}`] = entry(`selection-${index}`, index + 1);
  }
  entries["agent:main:unrelated"] = entry("unrelated", 10, "anthropic", "other");
  await writeSessionStore({ entries });
  const page = (offset?: number) =>
    directSessionReq<SessionPage>("sessions.list", {
      search: "repository-device",
      limit: 1,
      offset,
    });
  const first = await page();
  expect(first).toMatchObject({
    ok: true,
    payload: { totalCount: 3, sessions: [{ key: "agent:main:selection-2" }] },
  });
  const second = await page(first.payload?.nextOffset);
  expect(second.payload).toMatchObject({
    totalCount: 3,
    sessions: [{ key: "agent:main:selection-1", agentRuntime: { id: "repository-device" } }],
  });
});
