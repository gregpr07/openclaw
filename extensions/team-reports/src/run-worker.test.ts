import { MessageChannel } from "node:worker_threads";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { parseTeamReportsConfig } from "./config.js";
import { describePeriod } from "./periods.js";
import { completion } from "./reports.fixtures.js";
import { TeamReportsRunner } from "./run-worker.js";
import { teamReportsSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { createTeamReportsStore, TeamReportsStore } from "./store.js";

const workerExit = vi.hoisted(() => ({ notify: () => {} }));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(...args);
        this.once("exit", () => workerExit.notify());
      }
    },
  };
});
afterEach(() => {
  workerExit.notify = () => {};
  vi.restoreAllMocks();
});

async function nextMessageTurn() {
  await new Promise<void>((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.once("message", () => {
      port1.close();
      port2.close();
      resolve();
    });
    port2.postMessage(null);
  });
}

function settlementFixture(worker: string) {
  const entered = createDeferred<void>();
  const cancelled = createDeferred<void>();
  const released = createDeferred<void>();
  const exited = createDeferred<void>();
  workerExit.notify = () => exited.resolve();
  const runner = new TeamReportsRunner(new URL(worker, import.meta.url));
  const controller = new AbortController();
  const start = (
    params: Omit<Parameters<TeamReportsRunner["run"]>[0], "resolved" | "runtime" | "onRoster">,
  ) =>
    runner.run({
      ...params,
      resolved: {
        github: { ...params.config.github, token: "fixture", ignoreCommentPatterns: [] },
        people: params.config.people ?? [],
      },
      runtime: { signal: controller.signal, logger: { info() {}, warn() {}, error() {} } },
      onRoster() {},
    });
  const observeAbort = (signal?: AbortSignal) =>
    signal?.addEventListener("abort", () => cancelled.resolve(), { once: true });
  return {
    entered,
    released,
    start,
    observeAbort,
    async cancelAndJoin(pending: Promise<unknown>, beforeRelease = () => {}) {
      let runSettled = false;
      let closeSettled = false;
      const rejected = expect(
        pending.finally(() => {
          runSettled = true;
        }),
      ).rejects.toThrow("Report cancelled");
      await entered.promise;
      controller.abort(new Error("Report cancelled"));
      const closing = runner.close().then(() => {
        closeSettled = true;
      });
      await Promise.all([cancelled.promise, exited.promise]);
      // Drain native-exit cleanup without a timer or polling.
      await nextMessageTurn();
      expect([runSettled, closeSettled]).toEqual([false, false]);
      beforeRelease();
      released.resolve();
      await Promise.all([rejected, closing]);
      expect([runSettled, closeSettled]).toEqual([true, true]);
    },
    async close() {
      released.resolve();
      await runner.close();
    },
  };
}

it("joins an accepted host completion after the report worker has exited", async () => {
  const fixture = settlementFixture("./run-worker.test-support.ts");
  const store = new TeamReportsStore({
    async execute() {
      throw new Error("This completion-only fixture must not access storage");
    },
    async close() {},
  });
  const pending = fixture.start({
    config: parseTeamReportsConfig({ github: { token: "fixture", orgs: ["sample"] } }),
    store,
    periods: [],
    llm: {
      complete: async ({ signal }) => {
        fixture.observeAbort(signal);
        fixture.entered.resolve();
        await fixture.released.promise;
        return completion("Late result");
      },
    },
  });
  try {
    await fixture.cancelAndJoin(pending);
  } finally {
    await fixture.close();
  }
});

it("joins accepted SQLite result settlement after cancelling the real collection worker", async () => {
  await withTempDir("team-reports-worker-settlement-", async (directory) => {
    const fixture = settlementFixture("./run-worker.collection.test-support.ts");
    const store = await createTeamReportsStore({
      stateDir: directory,
      workerModuleUrl: resolveRuntimeWorkerUrl(teamReportsSqliteBackendEntrypoint),
    });
    const execute = store.execute.bind(store);
    vi.spyOn(store, "execute").mockImplementation(async (...args) => {
      if (args[0] !== "upsertPeriod") {
        return execute(...args);
      }
      fixture.observeAbort(args[2]?.signal);
      const result = await execute(...args);
      // SQLite has committed; the host still owns delivery/settlement of this accepted result.
      fixture.entered.resolve();
      await fixture.released.promise;
      return result;
    });
    const config = parseTeamReportsConfig({
      github: { token: "fixture", orgs: ["sample"] },
      people: [{ github: ["alex"] }],
      summaries: { enabled: true },
    });
    const complete = vi.fn(async () => completion("Unexpected late summary"));
    const pending = fixture.start({
      config,
      store,
      periods: [describePeriod("day", "2026-08-19")],
      llm: { complete },
    });
    try {
      await fixture.cancelAndJoin(pending, () => expect(complete).not.toHaveBeenCalled());
      expect((await store.getPeriod("day", "2026-08-19"))?.report.totals.github.commits).toBe(1);
      expect(complete).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
      await store.close();
    }
  });
});
