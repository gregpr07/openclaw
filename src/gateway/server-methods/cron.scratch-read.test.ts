import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { writeCronJobScratchInDatabase } from "../../cron/scratch-write.kernel.js";
import { createCronStoreHarness } from "../../cron/service.test-harness.js";
import { loadCronStore } from "../../cron/store.js";
import { cronStoreKey } from "../../cron/store/key.js";
import { upsertCronJobRow } from "../../cron/store/row-codec.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createHistoryJob, createReadService } from "./cron-read.test-support.js";
import { cronHandlers } from "./cron.js";
import {
  createCronCallerClient as callerClient,
  createCronTestContext,
  createCronTestInvoker,
} from "./cron.validation.test-support.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "cron-scratch-read-" });
const getRuntimeConfig = () => ({});
const invokeCron = createCronTestInvoker(cronHandlers, getRuntimeConfig);

it.each(["caller closes after read", "owner transfers before read"] as const)(
  "withholds private scratch when %s",
  async (change) => {
    const { storePath } = await makeStorePath();
    const cron = createReadService({
      storePath,
      cronEnabled: true,
      defaultAgentId: "main",
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: async () => ({ status: "skipped" }),
    });
    const entered = createDeferred();
    const release = createDeferred();
    let invocation: Promise<unknown> | undefined;
    try {
      const owner = { agentId: "ops", sessionKey: "agent:ops:main", accountId: "work" };
      const scheduledToolPolicy = {
        version: 1 as const,
        mode: "account" as const,
        ownerSessionKey: owner.sessionKey,
        ownerAccountId: owner.accountId,
      };
      const job = await cron.add(
        {
          ...createHistoryJob("ops", owner.sessionKey),
          id: "scratch-read-owner",
          name: "scratch read owner",
          owner,
          delivery: undefined,
          payload: { kind: "agentTurn", message: "synthetic event", toolsAllow: ["read"] },
        },
        { scheduledToolPolicy },
      );
      await cron.writeScratch(job.id, {
        content: "original private scratch",
        expectedRevision: 0,
      });
      const context = createCronTestContext(job, getRuntimeConfig);
      context.cron.readJob.mockImplementation((id) => cron.readJob(id));
      context.cron.getJob.mockImplementation((id) => cron.getJob(id));
      const client = callerClient("ops", owner.accountId, owner.sessionKey);
      const request = { context, client };
      context.cron.readScratch.mockImplementation((...args) => cron.readScratch(...args));
      const permitted = await invokeCron("cron.scratch.get", { id: job.id }, request);
      expect(permitted.respond.mock.calls).toMatchObject([
        [
          true,
          {
            currentRevision: 1,
            scratch: { content: "original private scratch" },
          },
          undefined,
        ],
      ]);
      context.cron.readScratch.mockClear();
      let current = true;
      context.cron.readScratch.mockImplementation(async (...args) => {
        if (change === "owner transfers before read") {
          entered.resolve();
          await release.promise;
        }
        const result = await cron.readScratch(...args);
        if (change === "caller closes after read") {
          current = false;
        }
        return result;
      });
      const respond = vi.fn();
      invocation = invokeCron(
        "cron.scratch.get",
        { id: job.id },
        {
          ...request,
          respond,
          hasCurrentClientAuthority: () => current,
        },
      ).then(
        () => ({ rejected: false }),
        (error: unknown) => ({ rejected: true, error }),
      );
      if (change === "owner transfers before read") {
        expect(
          await Promise.race([
            entered.promise.then(() => "scope-checked"),
            invocation.then(() => "completed-before-read"),
          ]),
        ).toBe("scope-checked");
        {
          using peer = new DatabaseSync(resolveOpenClawStateSqlitePath());
          const storeKey = cronStoreKey(storePath);
          runSqliteImmediateTransactionSync(peer, () => {
            upsertCronJobRow(
              peer,
              storeKey,
              {
                ...job,
                agentId: "worker",
                owner: { agentId: "worker", sessionKey: "agent:worker:main", accountId: "work" },
                scheduledToolPolicy: {
                  ...scheduledToolPolicy,
                  ownerSessionKey: "agent:worker:main",
                },
              },
              0,
            );
            expect(
              writeCronJobScratchInDatabase(peer, {
                storeKey,
                jobId: job.id,
                content: "peer private scratch",
                expectedRevision: 1,
                nowMs: Date.now(),
              }).result.ok,
            ).toBe(true);
          });
        }
        expect(
          (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id)?.agentId,
        ).toBe("worker");
        expect(cron.getJob(job.id)?.agentId).toBe("ops");
        release.resolve();
      }
      const result = await invocation;
      expect(context.cron.readScratch).toHaveBeenCalledOnce();
      if (change === "caller closes after read") {
        expect.soft(result).toMatchObject({
          rejected: true,
          error: { message: expect.stringContaining("authority closed") },
        });
        expect(respond).not.toHaveBeenCalled();
      } else {
        expect.soft(respond.mock.calls.some(([ok]) => ok === true)).toBe(false);
        expect(JSON.stringify(respond.mock.calls)).not.toContain("peer private scratch");
      }
    } finally {
      release.resolve();
      await invocation;
      cron.stop();
    }
  },
);
