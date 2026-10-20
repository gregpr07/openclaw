import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import type { SqliteRuntimeCapabilities as Capabilities } from "./bun-sqlite-library.js";
import {
  captureSqliteWorkerClosePolicy as capturePolicy,
  getSqliteRuntimeCapabilities as getCapabilities,
  initializeSqliteRuntimeCapabilities as initialize,
  mockBunSqliteNativeBoundary,
  sqliteCapabilitiesKey,
  sqliteSelectionKey,
} from "./bun-sqlite-library.test-support.js";

const decision = (capable: boolean, reason: string): Capabilities => ({
  explicitSqliteCloseReleasesNativeResources: capable,
  decided: true,
  reason,
});
const positive = decision(true, "probe passed");
function fixture(
  overrides: {
    isBun?: boolean;
    platform?: string;
    isMainThread?: boolean;
    inherited?: Capabilities;
    forceConservative?: boolean;
    select?: () => unknown;
    probe?: () => Promise<Capabilities>;
  } = {},
) {
  const native = mockBunSqliteNativeBoundary({
    isBun: overrides.isBun,
    isMainThread: overrides.isMainThread,
    platform: overrides.platform ?? "linux",
    env: overrides.forceConservative ? { OPENCLAW_DIAGNOSTICS: "sqlite.close.conservative" } : {},
  });
  native.environment.set(sqliteCapabilitiesKey, overrides.inherited);
  const select = vi.fn(overrides.select ?? (() => ({ source: "runtime" })));
  Object.defineProperty(globalThis, sqliteSelectionKey, { configurable: true, value: select });
  native.closeProbe.mockImplementation(overrides.probe ?? (async () => positive));
  return {
    select,
    probe: native.closeProbe,
    publish: native.publish,
    environment: native.environment,
    warn: vi.spyOn(process, "emitWarning").mockImplementation(() => {}),
  };
}

it.each([false, true])("publishes one late decision (early topology: %s)", async (topology) => {
  const pending = createDeferredCore<Capabilities>();
  const probeStarted = createDeferredCore();
  const order: string[] = [];
  const options = fixture({
    select: () => order.push("select"),
    probe: () => {
      order.push("probe");
      probeStarted.resolve();
      return pending.promise;
    },
  });
  const chosen = getCapabilities();
  expect(getCapabilities()).toBe(chosen);
  expect(chosen).toMatchObject({
    explicitSqliteCloseReleasesNativeResources: false,
    decided: false,
  });
  expect(options.select).not.toHaveBeenCalled();
  expect(options.probe).not.toHaveBeenCalled();
  expect(options.publish).not.toHaveBeenCalled();
  const early = topology ? capturePolicy() : undefined;
  if (topology) {
    expect(capturePolicy()).toBe(false);
  }
  const first = initialize();
  expect(initialize()).toBe(first);
  await probeStarted.promise;
  expect(order).toEqual(["select", "probe"]);
  expect(getCapabilities()).toBe(chosen);
  expect(options.publish).not.toHaveBeenCalled();
  pending.resolve({ ...positive });
  const result = await first;
  expect(result).toEqual(positive);
  expect(Object.isFrozen(result)).toBe(true);
  expect(options.publish).toHaveBeenCalledExactlyOnceWith(sqliteCapabilitiesKey, result);
  expect(getCapabilities()).toBe(result);
  expect(initialize()).toBe(first);
  expect(chosen.explicitSqliteCloseReleasesNativeResources).toBe(false);
  expect(capturePolicy()).toBe(true);
  if (topology) {
    expect(early).toBe(false);
    expect(options.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("2 topology owners"),
      { code: "SQLITE_EARLY_TOPOLOGY" },
    );
  } else {
    expect(options.warn).not.toHaveBeenCalled();
  }
});

it("keeps a worker with missing parent admission conservative for its lifetime", async () => {
  const options = fixture({ isMainThread: false });
  const initial = getCapabilities();
  expect(initial).toMatchObject({
    explicitSqliteCloseReleasesNativeResources: false,
    reason: expect.stringContaining("Parent"),
  });
  options.environment.set(sqliteCapabilitiesKey, positive);
  expect(await initialize()).toBe(initial);
  expect(getCapabilities()).toBe(initial);
  expect(options.probe).not.toHaveBeenCalled();
});

it.each([
  ["diagnostic override", { forceConservative: true }, false, "diagnostic flag", 0],
  ["Node", { isBun: false, platform: "win32" }, true, "Node runtime", 0],
  [
    "Bun Windows",
    { platform: "win32", isMainThread: false, inherited: positive },
    false,
    "Windows",
    0,
  ],
  ["negative probe", {}, false, "WAL preconditions unavailable", 1],
  ["probe error", {}, false, "fixture native failure", 1],
  ["selection error", {}, false, "invalid library", 0],
] as const)("handles %s at runtime admission", async (name, overrides, capable, reason, probes) => {
  const options = fixture({
    ...overrides,
    select: () => {
      if (name === "selection error") {
        throw new Error(reason);
      }
    },
    probe: async () => {
      if (name === "probe error") {
        throw new Error(reason);
      }
      return name === "negative probe" ? decision(false, reason) : positive;
    },
  });
  if (name === "selection error") {
    await expect(initialize()).rejects.toThrow(reason);
    expect(options.publish).not.toHaveBeenCalled();
  } else {
    const result = await initialize();
    const expectedReason =
      name === "Node" || name === "negative probe" ? reason : expect.stringContaining(reason);
    expect(result).toEqual(decision(capable, expectedReason));
    expect(getCapabilities()).toBe(result);
  }
  expect(options.probe).toHaveBeenCalledTimes(probes);
});
