import { performance } from "node:perf_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { startCronListDiagnostics } from "./cron-list-diagnostics.js";

let previousDiagnostics: boolean;
let clock = 0;
beforeEach(() => {
  previousDiagnostics = areDiagnosticsEnabledForProcess();
  clock = 0;
  setDiagnosticsEnabledForProcess(true);
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});

function start(warn = vi.fn()) {
  return expectDefined(
    startCronListDiagnostics({ warn }, vi.fn()),
    "enabled cron list diagnostics",
  );
}
afterEach(() => {
  setDiagnosticsEnabledForProcess(previousDiagnostics);
  vi.restoreAllMocks();
});

test("disabled cron list diagnostics do not start clocks", () => {
  setDiagnosticsEnabledForProcess(false);
  const warn = vi.fn();
  expect(startCronListDiagnostics({ warn }, vi.fn())).toBeUndefined();
  expect(performance.now).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
});

test.each([999.9, 1_000])("cron list warning threshold uses raw elapsed time: %s", (elapsed) => {
  const warn = vi.fn();
  const diagnostics = start(warn);
  clock = elapsed;
  diagnostics.finish("returned");
  expect(warn).toHaveBeenCalledTimes(elapsed >= 1_000 ? 1 : 0);
});

test("cron list diagnostics close unfinished work once and retire later marks", () => {
  const warn = vi.fn();
  const diagnostics = start(warn);
  clock = 100;
  diagnostics.mark("listing");
  clock = 1_100;
  diagnostics.finish("threw");
  clock = 9_000;
  diagnostics.mark("previews");
  diagnostics.finish("returned");
  expect(warn).toHaveBeenCalledExactlyOnceWith("cron: slow list request", {
    operation: "cron.list",
    elapsedMs: 1_100,
    phaseDurationsMs: { setup: 100, listing: 1_000 },
    sourcePageMs: 0,
    sourcePageCount: 0,
    scopeAttemptCount: 0,
    handlerOutcome: "threw",
    responseOutcome: "none",
  });
});

test("disabling diagnostics during a cron request cannot publish its summary later", () => {
  const warn = vi.fn();
  const diagnostics = start(warn);
  clock = 2_000;
  setDiagnosticsEnabledForProcess(false);
  diagnostics.finish("returned");
  setDiagnosticsEnabledForProcess(true);
  diagnostics.finish("returned");
  expect(warn).not.toHaveBeenCalled();
});

test.each([true, false])("cron diagnostics preserve captured trace presence: %s", (bound) => {
  const original = bound ? createDiagnosticTraceContext() : undefined;
  let loggedTrace: DiagnosticTraceContext | undefined;
  const warn = vi.fn(() => {
    loggedTrace = getActiveDiagnosticTraceContext();
  });
  const diagnostics = runWithDiagnosticTraceContext(original, () => start(warn));
  clock = 1_500;
  runWithDiagnosticTraceContext(createDiagnosticTraceContext(), () =>
    diagnostics.finish("returned"),
  );
  expect(warn).toHaveBeenCalledOnce();
  expect(loggedTrace).toEqual(original);
});
