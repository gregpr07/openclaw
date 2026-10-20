import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { encodeOpenClawStateWorkerError } from "../state/openclaw-state-worker-error.js";
import { receiveSqliteWorkerReply } from "./sqlite-worker-broker-reply.js";
import type { Actor, Job } from "./sqlite-worker-broker.types.js";
import type { SqliteWorkerCloseReceipt, SqliteWorkerReply } from "./sqlite-worker-contract.js";
import { SqliteWorkerSlotCustody } from "./sqlite-worker-request-custody.js";
import { createSqliteWorkerTransferOwner } from "./sqlite-worker-transfer.js";

function unexpected(): never {
  throw new Error("Unexpected reply dispatch or settlement");
}

function createJob(type: "execute" | "execute-frame" | "close"): Job {
  return {
    request:
      type === "close"
        ? { type, id: 1, actor: 1 }
        : { type, id: 1, actor: 1, input: new Uint8Array() },
    custody: new SqliteWorkerSlotCustody().createRequest(),
    observation: { started() {}, completed() {} },
    bytes: 0,
    result: createDeferredCore().promise,
    resolve: unexpected,
    reject: unexpected,
    detach: unexpected,
  };
}

it.each(["valid", "framed", "close", "malformed"])(
  "publishes worker receipts before settling its %s reply",
  async (kind) => {
    const key = "openclaw.sqliteNativeRuntimeAdmission";
    const previous = getEnvironmentData(key);
    try {
      setEnvironmentData(key, undefined);
      vi.resetModules();
      const sqlite = await import("./node-sqlite.js");
      sqlite.requireNodeSqlite();
      const receipt: unknown = getEnvironmentData(key);
      assert(isRecord(receipt));
      const forwarded =
        kind === "malformed" ? { ...receipt, extensionLoadingSupported: "yes" } : receipt;
      setEnvironmentData(key, undefined);
      const nativeQueries = vi.spyOn(DatabaseSync.prototype, "prepare");
      const actor: Pick<Actor, "id" | "closeReceipt"> = { id: 1 };
      const closeReceipt: SqliteWorkerCloseReceipt = {
        identity: { key: "fixture", canonicalPath: "/fixture/state.sqlite" },
        incarnation: "closed-incarnation",
        checkpoint: {
          observedAtNs: 42n,
          health: {
            state: "complete",
            observedAtMs: 1,
            walBytes: 0,
            databaseBytes: 4096,
            logFrames: 0,
            checkpointedFrames: 0,
            lastCompletedAtMs: 1,
            consecutiveBlocked: 0,
            warning: false,
          },
        },
      };
      const job = createJob(kind === "close" ? "close" : "execute");
      const finish = vi.fn(() => {
        expect(getEnvironmentData(key)).toEqual(kind === "malformed" ? undefined : receipt);
        if (kind === "close") {
          expect(actor.closeReceipt).toMatchObject({
            incarnation: "closed-incarnation",
            checkpoint: { observedAtNs: 42n },
          });
        }
      });
      const postMessage = vi.fn();
      const slot = { actors: new Set([actor]), current: job, worker: { postMessage } };
      const owner = { fail: unexpected, finish, dispatch() {} };
      const reply = (
        value: unknown,
        extra: Pick<Extract<SqliteWorkerReply, { ok: true }>, "transfer" | "closeReceipt"> = {},
      ) =>
        receiveSqliteWorkerReply(
          slot,
          { id: 1, ok: true, value: serialize(value), nativeRuntimeAdmission: forwarded, ...extra },
          owner,
        );
      if (kind === "framed") {
        const producer = createSqliteWorkerTransferOwner();
        const handle = producer.start([{ kind: "result", value: "committed" }].values(), {
          kinds: ["result"],
        });
        reply(handle, { transfer: "start" });
        expect(getEnvironmentData(key)).toBeUndefined();
        let frame;
        do {
          frame = producer.next(handle.id);
          reply(frame, { transfer: "frame" });
          if (!frame.done) {
            expect(getEnvironmentData(key)).toBeUndefined();
            expect(finish).not.toHaveBeenCalled();
          }
        } while (!frame.done);
        producer.end(handle.id);
        expect(postMessage).toHaveBeenCalledTimes(2);
      } else {
        reply("committed", kind === "close" ? { closeReceipt } : {});
        expect(postMessage).not.toHaveBeenCalled();
      }
      expect(finish).toHaveBeenCalledWith(job, undefined, "committed");
      expect(nativeQueries).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      setEnvironmentData(key, previous);
    }
  },
);

it("hydrates cached-context execute-frame errors without an explicit request context", () => {
  const original = Object.assign(
    new Error("Synthetic preparation failure", { cause: new Error("Synthetic read failure") }),
    { code: "EIO", errno: -5 },
  );
  const sharedState = encodeOpenClawStateWorkerError(original, { includeOrdinary: true });
  assert(sharedState);
  const job = createJob("execute-frame");
  let failure: unknown;

  receiveSqliteWorkerReply(
    { actors: new Set(), current: job, worker: { postMessage: unexpected } },
    {
      id: 1,
      ok: false,
      error: {
        name: "Error",
        message: "Synthetic preparation failure",
        code: "EIO",
        sharedState: structuredClone(sharedState),
      },
    },
    {
      fail(error) {
        failure = error;
      },
      finish: unexpected,
      dispatch: unexpected,
    },
  );

  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({
    message: "Synthetic preparation failure",
    code: "EIO",
    errno: -5,
    cause: { message: "Synthetic read failure" },
  });
});
