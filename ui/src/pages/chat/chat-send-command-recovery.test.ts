// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import {
  captureChatOutboxAdmission,
  storedChatOutboxScopeKey,
} from "../../lib/chat/outbox-store.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";
import { createStagedAttachment } from "./chat-delivery-attachments.test-support.ts";
import { findChatSendPayload, makeChatHost } from "./chat-host.test-support.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

const attachmentDataUrl = "data:application/pdf;base64,JVBERi0xLjQK";
const sentAttachments = [
  {
    type: "file",
    mimeType: "application/pdf",
    fileName: "brief.pdf",
    content: "JVBERi0xLjQK",
  },
];

useChatSendBrowserFixture();

describe.each(["steer", "redirect"] as const)("handleSendChat /%s recovery", (command) => {
  const draft = `/${command} keep the correction available`;
  const commandHost = (response: unknown, overrides: Parameters<typeof makeChatHost>[0] = {}) =>
    makeChatHost({ chatMessage: draft, requestHandlers: { "chat.send": response }, ...overrides });

  it.each(["timeout", "error", "rejected"] as const)(
    "restores submitted input after the %s acknowledgment",
    async (outcome) => {
      const attachment = createStagedAttachment(`${command}-${outcome}`);
      const host = commandHost(
        () => {
          if (outcome === "rejected") {
            throw new GatewayRequestError({ code: "UNAVAILABLE", message: "Request rejected" });
          }
          return { runId: "command-run", status: outcome };
        },
        { chatAttachments: [attachment] },
      );

      await handleSendChat(host);

      expect(findChatSendPayload(host)).toMatchObject({
        message: "keep the correction available",
        queueMode: command === "steer" ? "steer" : "interrupt",
        attachments: sentAttachments,
      });
      expect(host.chatMessage).toBe(draft);
      expect(host.chatAttachments).toEqual([expect.objectContaining({ id: attachment.id })]);
      expect(getChatAttachmentDataUrl(host.chatAttachments[0]!)).toBe(attachmentDataUrl);
      expect(host.chatError).toBeTruthy();
      expect(host.chatQueue).toEqual([]);
    },
  );

  it.each(["started", "in_flight", "ok"] as const)(
    "retires the submitted draft after a successful %s acknowledgment",
    async (status) => {
      const attachment = createStagedAttachment(`${command}-${status}`);
      const host = commandHost(
        { runId: "command-run", status },
        {
          chatAttachments: [attachment],
          chatRunId: "active-run",
        },
      );

      await handleSendChat(host);

      expect(host.chatMessage).toBe("");
      expect(findChatSendPayload(host)).toMatchObject({ attachments: sentAttachments });
      expect(host.chatAttachments).toEqual([]);
      expect(getChatAttachmentDataUrl(attachment)).toBeNull();
      expect(host.chatComposerFallbackByScope).toEqual({});
      expect(host.chatError).toBeFalsy();
      expect(host.chatRunId).toBe(
        command === "redirect" && status !== "ok" ? "command-run" : "active-run",
      );
    },
  );

  it("does not restore a failed command over a newer draft", async () => {
    const acknowledgment = createDeferred<{ runId: string; status: "timeout" }>();
    const newerAttachment = createStagedAttachment(`${command}-newer`);
    const host = commandHost(() => acknowledgment.promise);

    const send = handleSendChat(host);
    await vi.waitFor(() => expect(findChatSendPayload(host)).toBeDefined());
    host.chatMessage = "Newer operator draft";
    host.chatAttachments = [newerAttachment];
    acknowledgment.resolve({ runId: "command-run", status: "timeout" });
    await send;

    expect(host.chatMessage).toBe("Newer operator draft");
    expect(host.chatAttachments).toEqual([newerAttachment]);
    expect(getChatAttachmentDataUrl(newerAttachment)).toBe(attachmentDataUrl);
  });

  it("retains a failed command in its submitted session after navigation", async () => {
    const acknowledgment = createDeferred<{ runId: string; status: "timeout" }>();
    const attachment = createStagedAttachment(`${command}-submitted-session`);
    const host = commandHost(() => acknowledgment.promise, {
      sessionKey: "agent:main:first",
      chatAttachments: [attachment],
    });
    const submittedScopeKey = storedChatOutboxScopeKey(
      captureChatOutboxAdmission(host, host.sessionKey).scope,
    );

    const send = handleSendChat(host);
    await vi.waitFor(() => expect(findChatSendPayload(host)).toBeDefined());
    host.sessionKey = "agent:main:second";
    host.chatMessage = "Second session draft";
    host.chatError = "Second session error";
    acknowledgment.resolve({ runId: "command-run", status: "timeout" });
    await send;

    expect(host.chatMessage).toBe("Second session draft");
    expect(host.chatError).toBe("Second session error");
    const fallbacks = Object.entries(host.chatComposerFallbackByScope);
    expect(fallbacks).toHaveLength(1);
    const [scopeKey, fallback] = fallbacks[0]!;
    expect(scopeKey).toBe(submittedScopeKey);
    expect(fallback.message).toBe(draft);
    expect(getChatAttachmentDataUrl(fallback.attachments[0]!)).toBe(attachmentDataUrl);
  });

  if (command === "redirect") {
    it("does not send captured files into a conversation selected during the route wait", async () => {
      const attachment = createStagedAttachment("redirect-route");
      const host = commandHost(
        { status: "ok" },
        {
          chatAttachments: [attachment],
        },
      );
      const send = handleSendChat(host);
      host.sessionKey = "agent:main:other";
      await send;
      expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toEqual([]);
      expect(host.chatMessage).toBe(draft);
      expect(host.chatAttachments).toEqual([attachment]);
      expect(getChatAttachmentDataUrl(attachment)).toBe(attachmentDataUrl);
    });
  }
});
