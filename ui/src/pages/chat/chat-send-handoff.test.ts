import { afterEach, expect, it, onTestFinished, vi } from "vitest";
// @vitest-environment node
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { outboxStorageScope } from "../../lib/chat/outbox-payload-store.runtime.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  expectRpc,
  findChatSendPayload,
  makeChatHost,
  requestCalls,
} from "./chat-host.test-support.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { readQueuedMessageById } from "./chat-queue.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { admitInitialTurnHandoff } from "./initial-turn-handoff-admission.ts";
import { prepareInitialTurnHandoff } from "./initial-turn-handoff.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();
afterEach(() => vi.useRealTimers());

it.each([false, true])(
  "never lets another account consume an initial-turn handoff (owned: %s)",
  async (owned) => {
    vi.useFakeTimers();
    const host = makeChatHost({ requestHandlers: {}, sessionKey: "agent:main:initial-owner" });
    const client = host.client!;
    const original = client.recoveryScope;
    const scope = outboxStorageScope(host);
    prepareInitialTurnHandoff(host.sessionKey, {
      id: "private-initial",
      text: "Only account A",
      createdAt: 1,
      ...(owned ? { storageScope: scope } : {}),
    });
    const recovery = vi.spyOn(client, "recoveryScope", "get").mockReturnValue("account-b");
    expect(admitInitialTurnHandoff(host, host.sessionKey)).toBe(false);
    expect(host.chatQueue).toEqual([]);
    recovery.mockReturnValue(original);
    expect(admitInitialTurnHandoff(host, host.sessionKey)).toBe(owned);
    expect(host.chatQueue).toEqual(
      owned ? [expect.objectContaining({ text: "Only account A", storageScope: scope })] : [],
    );
    expect(host.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
  },
);

it.each([
  { queueMode: "followup", status: "in_flight" },
  { queueMode: undefined, status: "started" },
] as const)(
  "keeps the active reply on a $queueMode $status custody ACK",
  async ({ queueMode, status }) => {
    const acknowledgement = createDeferred<{ runId: string; status: string }>();
    const activeReply = () => ({
      chatRunId: "active-reply",
      chatStream: "Already visible response text",
      chatStreamStartedAt: 100,
      chatStreamSegments: [{ text: "Earlier live commentary", ts: 90, itemId: "commentary" }],
      chatRunStartup: { state: "activity" as const, runId: "active-reply" },
    });
    const host = makeChatHost({
      ...activeReply(),
      chatMessage: "A follow-up while another participant's reply is streaming",
      requestHandlers: { "chat.send": () => acknowledgement.promise },
    });
    const sending = handleSendChat(host, undefined, { followUpMode: queueMode });
    await vi.waitFor(() => expectRpc(host.request, "chat.send"));
    expect(host.chatStream).toBe("Already visible response text");
    acknowledgement.resolve({ runId: "accepted-input", status });
    await sending;
    expect(host).toMatchObject(activeReply());
    expect(host.chatStreamSegments).toEqual(activeReply().chatStreamSegments);
    expect(host.chatRunStartup).toEqual(activeReply().chatRunStartup);
  },
);

it.each([false, true])(
  "retries only the confirmed first-message version after history settles (edited: %s)",
  async (edited) => {
    const sessionKey = "agent:main:confirmed-first-message";
    const history = createDeferred<ChatHistoryResult>();
    const consent = createDeferred<boolean>();
    const ownerChecked = createDeferred();
    const host = makeChatHost({
      sessionKey,
      assistantAgentId: "main",
      currentSessionId: "first-message-session",
      requestHandlers: {
        "chat.history": () => history.promise,
        "chat.send": { status: "started", runId: "confirmed-first-message" },
      },
    });
    onTestFinished(() => host.sessions.dispose());
    host.captureComposerRecoveryOwner = () => ({
      resolveOwner: () => {
        ownerChecked.resolve();
        return host;
      },
      retainedAttachmentIds: () => new Set(),
    });
    const item: ChatQueueItem = {
      id: "confirmed-first-message",
      text: "The message I confirmed",
      createdAt: 1,
      sessionKey,
      agentId: "main",
      sendState: "failed",
      storageScope: outboxStorageScope(host),
    };
    const loading = loadChatHistory(host, { deferBranches: true });
    const historyState = getChatHistoryLoadState(host);
    if (historyState.phase !== "in-flight") {
      throw new Error("Expected the pending history owner");
    }
    prepareInitialTurnHandoff(sessionKey, item, consent.promise);
    admitInitialTurnHandoff(host, sessionKey);
    consent.resolve(true);
    await ownerChecked.promise;
    // A sibling history consumer can edit the outbox after history's version
    // check, before the handoff's awaiting continuation resumes.
    const edit = historyState.promise.then(() => {
      if (edited) {
        chatOutboxOwner(host).change(
          host,
          item.id,
          (current) => ({ ...current, text: "A newer unconfirmed edit" }),
          true,
        );
      }
    });
    history.resolve({
      messages: [],
      sessionInfo: {
        key: sessionKey,
        sessionId: "first-message-session",
        kind: "direct",
        activeLeafEntryId: "current-leaf",
        updatedAt: 1,
      },
    });
    await Promise.all([loading, edit]);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    if (edited) {
      expect(requestCalls(host.request, "chat.send")).toEqual([]);
      expect(readQueuedMessageById(host, item.id)?.text).toBe("A newer unconfirmed edit");
    } else {
      await vi.waitFor(() =>
        expect(findChatSendPayload(host)).toMatchObject({ message: item.text }),
      );
      expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
    }
  },
);
