// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import {
  createBrowserAnnotationAttachment,
  findChatSendPayload,
  makeChatHost,
} from "./chat-host.test-support.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";
useChatSendBrowserFixture();
const recipient = (profileId: string, start = 0) => ({ profileId, start, end: start + 5 });

describe("human mention submission", () => {
  it("keeps only selected recipients after annotation and reply prefixes", async () => {
    const host = makeChatHost({
      chatMessage: "  🔎 @Alex please review  ",
      chatMentions: [recipient("profile-alex", 5)],
      chatAttachments: [createBrowserAnnotationAttachment("mention", "Unselected @Other context")],
      chatReplyTarget: {
        messageId: "synthetic-reply",
        text: "Unselected @Other quote",
        senderLabel: "Reader",
      },
      getWorkContext: () => ({ page: "chat", title: "Unselected @Other work context" }),
      requestHandlers: { "chat.send": { status: "started" } },
    });

    await handleSendChat(host);

    const expected =
      "> **Reader:** Unselected @Other quote\n\nUnselected @Other context\n\n🔎 @Alex please review";
    expect(findChatSendPayload(host)).toMatchObject({
      message: expected,
      mentions: [recipient("profile-alex", expected.indexOf("@Alex"))],
    });
  });

  it("does not clear a same-label replacement recipient while history is loading", async () => {
    const history = createDeferred<ChatHistoryResult>();
    const host = makeChatHost({
      chatMessage: "@Alex please review",
      chatMentions: [recipient("profile-first")],
      chatLoading: true,
      currentSessionId: "existing-conversation",
      requestHandlers: {
        "chat.history": () => history.promise,
        "chat.send": { status: "started" },
      },
    });
    const sending = handleSendChat(host);
    await vi.waitFor(() =>
      expect(host.request).toHaveBeenCalledWith("chat.history", expect.anything(), {
        timeoutMs: 30_000,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(host.chatMessage).toBe("");
    host.chatMessage = "@Alex please review";
    host.chatMentions = [recipient("profile-second")];
    history.resolve({
      messages: [],
      sessionInfo: {
        key: host.sessionKey,
        kind: "direct",
        updatedAt: 1,
        status: "done",
        hasActiveRun: false,
      },
    });
    await sending;

    expect(findChatSendPayload(host).mentions).toEqual([recipient("profile-first")]);
    expect(host.chatMessage).toBe("@Alex please review");
    expect(host.chatMentions).toEqual([recipient("profile-second")]);
  });

  it.each(["/new @Alex", "/status @Alex", "/btw @Alex review"])(
    "preserves mention intent instead of dropping it in %s",
    async (message) => {
      const mentions = [recipient("profile-alex", message.indexOf("@Alex"))];
      const host = makeChatHost({
        chatMessage: message,
        chatMentions: mentions,
        requestHandlers: {},
      });

      await handleSendChat(host);

      expect(host.request).not.toHaveBeenCalled();
      expect(host.chatMessage).toBe(message);
      expect(host.chatMentions).toEqual(mentions);
      expect(host.chatError).toBeTruthy();
    },
  );
});
