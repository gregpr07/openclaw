// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory } from "./chat-history.ts";
import { findChatSendPayload, makeChatHost, requestCalls } from "./chat-host.test-support.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
useChatSendBrowserFixture();
const historyRow = (
  key: string,
  activeLeafEntryId: string,
  active = false,
): NonNullable<ChatHistoryResult["sessionInfo"]> => ({
  key,
  activeLeafEntryId,
  kind: "direct" as const,
  updatedAt: 1,
  sessionId: "current-session",
  hasActiveRun: active,
  status: active ? "running" : "done",
  ...(active ? { activeRunIds: ["active-run"] } : {}),
});
it("holds attachments across history settlement", async () => {
  const history = createDeferred<ChatHistoryResult>();
  const result: ChatHistoryResult = {
    messages: [],
    sessionId: "current-session",
    sessionInfo: historyRow("agent:main:main", "held-enter-terminal"),
  };
  const host = makeChatHost({
    sessionKey: "agent:main:main",
    currentSessionId: "current-session",
    chatDisplayedLeafEntryId: "previous-leaf",
    chatAttachments: [
      {
        id: "file",
        fileName: "held-enter.txt",
        mimeType: "text/plain",
        dataUrl: "data:text/plain;base64,aGVsbG8=",
        origin: "file",
      },
    ],
    requestHandlers: { "chat.history": () => history.promise, "chat.send": { status: "started" } },
  });
  const loading = loadChatHistory(host, { deferBranches: true });
  const channel = new MessageChannel();
  const release = channel.port2.postMessage.bind(channel.port2);

  const postInput = vi.spyOn(channel.port2, "postMessage").mockImplementation(() => undefined);
  vi.spyOn(globalThis, "MessageChannel").mockImplementationOnce(function () {
    return channel;
  });
  const sending = handleSendChat(host, undefined, undefined, new Event("submit"));
  let runId: string | undefined;
  try {
    await vi.waitFor(() => expect(host.chatQueue).toHaveLength(1));
    expect(postInput).toHaveBeenCalledOnce();
    expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
    runId = host.chatQueue[0]!.sendRunId;
    expect(runId).toBeTypeOf("string");
    expect(requestCalls(host.request, "chat.history")).toHaveLength(1);
    history.resolve(result);
    await loading;
    await Promise.all([
      resumeStoredChatOutboxes(host),
      resumeStoredChatOutboxes({ ...host, chatQueue: [] }),
    ]);
    // Neither history nor passive drains may deliver before input resumes.
    expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
  } finally {
    history.resolve(result);
    release(undefined);
    await sending;
    channel.port1.close();
    channel.port2.close();
  }
  expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
  expect(findChatSendPayload(host)).toMatchObject({
    expectedLeafEntryId: "held-enter-terminal",
    idempotencyKey: runId,
    message: "",
    attachments: [expect.objectContaining({ fileName: "held-enter.txt", content: "aGVsbG8=" })],
  });
});

it.each([false, true])(
  "steers after superseded history (refresh first: %s)",
  async (refreshBeforeSend) => {
    const history = createDeferred<ChatHistoryResult>();
    const admitted = createDeferred();
    const sessionKey = "agent:main:history-steer";
    const result: ChatHistoryResult = {
      messages: [],
      sessionInfo: historyRow(sessionKey, "active-leaf", true),
    };
    let reads = 0;
    const host = makeChatHost({
      sessionKey,
      currentSessionId: "current-session",
      chatRunId: "active-run",
      chatMessage: "Correct the active reply",
      requestHandlers: {
        "chat.history": () => (++reads === 1 ? history.promise : result),
        "chat.send": { status: "in_flight", runId: "steer-input" },
      },
    });
    const loading = loadChatHistory(host, { deferBranches: true });
    // A live event invalidates the raw read and queues a replacement snapshot.
    let refresh = refreshBeforeSend
      ? loadChatHistory(host, { supersedeInFlight: true, deferBranches: true })
      : undefined;
    const sending = handleSendChat(host, undefined, {
      followUpMode: "steer",
      onOutboxAdmitted: () => admitted.resolve(),
    });
    try {
      await admitted.promise;
      expect(requestCalls(host.request, "chat.send")).toHaveLength(0);
      if (!refreshBeforeSend) {
        refresh = loadChatHistory(host, { supersedeInFlight: true, deferBranches: true });
      }
      history.resolve({
        ...result,
        sessionInfo: { ...result.sessionInfo!, activeLeafEntryId: "stale-leaf" },
      });
      await Promise.all([loading, refresh, sending]);
      expect(reads).toBe(2);
      expect(host).toMatchObject({
        chatDisplayedLeafEntryId: "active-leaf",
        chatRunId: "active-run",
      });
      expect(requestCalls(host.request, "chat.send")).toHaveLength(1);
      expect(findChatSendPayload(host)).toMatchObject({
        sessionKey,
        message: "Correct the active reply",
        queueMode: "steer",
      });
    } finally {
      history.resolve(result);
      await Promise.all([loading, refresh, sending]);
      host.sessions.dispose();
    }
  },
);
