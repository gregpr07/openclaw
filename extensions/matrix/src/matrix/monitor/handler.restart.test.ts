import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { ChannelIngressMonitorLifecycle } from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import { SqliteBackedMatrixSyncStore } from "../client/file-sync-store.js";
import { matrixSyncResponse, useSyncStoreFixture } from "../client/sync-store.test-support.js";
import { MatrixClient, type MatrixRawEvent } from "../sdk.js";
import { createMatrixIngressMonitor } from "./ingress.js";

describe("Matrix inbound restart recovery", () => {
  const storage = useSyncStoreFixture("openclaw-matrix-inbound-restart-");
  const roomId = "!room:example.org";
  const event = {
    event_id: "$unadopted",
    sender: "@alice:example.org",
    origin_server_ts: 1_000,
    type: "m.room.message",
    content: { msgtype: "m.text", body: "Keep this pending message" },
  };
  const response = matrixSyncResponse("cursor-after-message", roomId, event, "previous");
  const createQueue = () =>
    createChannelIngressQueueForTests<{
      version: 1;
      roomId: string;
      event: MatrixRawEvent;
    }>({ channelId: "matrix", accountId: "default", stateDir: storage.root });
  const createClient = (syncStore: SqliteBackedMatrixSyncStore) =>
    new MatrixClient("https://example.org", "synthetic-token", {
      userId: "@bot:example.org",
      syncStore,
    });
  async function openMonitor(
    startupMs: number,
    dispatch: Parameters<typeof createMatrixIngressMonitor>[0]["dispatch"],
  ) {
    const store = await SqliteBackedMatrixSyncStore.create(storage.root);
    const client = createClient(store);
    const monitor = createMatrixIngressMonitor({
      accountId: "default",
      client,
      startupMs,
      queue: createQueue(),
      dispatch,
    });
    const unbind = await client.bindSyncIngress(monitor.admitSync);
    return { store, monitor, unbind };
  }
  async function closeDatabase() {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
  }
  const adoptingDispatch = (adopted?: ReturnType<typeof createDeferred<void>>) =>
    vi.fn(
      async (_room: string, _event: MatrixRawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
        await lifecycle.onAdopted();
        adopted?.resolve();
      },
    );
  async function expectDrained() {
    expect(await createQueue().listPending()).toEqual([]);
    expect(await createQueue().listClaims()).toEqual([]);
  }

  it("keeps first-login history excluded across sync batches and cached replay", async () => {
    const dispatch = adoptingDispatch();
    const { store, monitor: first, unbind } = await openMonitor(2_000, dispatch);
    await store.setSyncData(response);
    const lateRoomId = "!joined-later:example.org";
    const laterSync = matrixSyncResponse(
      "cursor-after-join",
      lateRoomId,
      { ...event, event_id: "$late-history" },
      "previous-join",
    );
    const freshEvent = { ...event, event_id: "$fresh", origin_server_ts: 2_500 };
    laterSync.rooms.join[lateRoomId]!.timeline!.events.push(freshEvent);
    await store.setSyncData(laterSync);
    await store.flush();
    unbind();
    await first.stop();
    await closeDatabase();
    const {
      store: restored,
      monitor: restarted,
      unbind: unbindRestart,
    } = await openMonitor(3_000, dispatch);
    try {
      restarted.start();
      await restarted.waitForIdle();
      await restored.setSyncData(response);
      await restored.setSyncData(laterSync);
      await restarted.waitForIdle();
      expect(dispatch).toHaveBeenCalledExactlyOnceWith(
        lateRoomId,
        expect.objectContaining(freshEvent),
        expect.any(Object),
      );
      await expectDrained();
    } finally {
      unbindRestart();
      await restarted.stop();
    }
  });

  it.each(["SIGTERM", "SIGKILL"] as const)(
    "replays an unadopted message exactly once after %s-style restart",
    async (shutdown) => {
      const deferred = createDeferred<void>();
      const {
        store,
        monitor: first,
        unbind,
      } = await openMonitor(0, async (_room, _event, lifecycle) => {
        lifecycle.onDeferred();
        deferred.resolve();
      });
      await store.setSyncData(response);
      await store.flush();
      if (shutdown === "SIGTERM") {
        first.start();
        await deferred.promise;
        expect(await createQueue().listClaims()).toHaveLength(1);
        await first.stop();
      } else {
        // Leave a committed claim with a dead process owner, as a hard kill does.
        await createQueue().claim(event.event_id, { ownerId: "2147483647:0:dead-worker" });
      }
      unbind();
      await closeDatabase();
      const adopted = createDeferred<void>();
      const dispatch = adoptingDispatch(adopted);
      const {
        store: restored,
        monitor: restarted,
        unbind: unbindRestart,
      } = await openMonitor(2_000, dispatch);
      try {
        restarted.start();
        await adopted.promise;
        // A server replay must not create another delivery after adoption.
        await restored.setSyncData(response);
        expect(dispatch).toHaveBeenCalledExactlyOnceWith(
          roomId,
          expect.objectContaining(event),
          expect.any(Object),
        );
        await expectDrained();
      } finally {
        unbindRestart();
        await restarted.stop();
      }
    },
  );
});
