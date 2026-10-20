import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const inspectGoogleChatAccount = vi.hoisted(() => vi.fn());
const listGoogleChatAccountIds = vi.hoisted(() => vi.fn());
const resolveGoogleChatAccount = vi.hoisted(() => vi.fn());
const sendGoogleChatMessage = vi.hoisted(() => vi.fn());
const resolveGoogleChatOutboundSpace = vi.hoisted(() => vi.fn());
const availableAccount = {
  enabled: true,
  credentialSource: "inline",
  tokenStatus: "available",
  config: {},
};

vi.mock("./accounts.js", () => ({
  inspectGoogleChatAccount,
  listGoogleChatAccountIds,
  resolveGoogleChatAccount,
}));

vi.mock("./api.js", () => ({ sendGoogleChatMessage }));
vi.mock("./targets.js", () => ({ resolveGoogleChatOutboundSpace }));

let googlechatMessageActions: typeof import("./message-tool-api.js").googlechatMessageActions;

describe("googlechat message actions", () => {
  beforeAll(async () => {
    ({ googlechatMessageActions } = await import("./message-tool-api.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./api.js");
    vi.doUnmock("./targets.js");
    vi.resetModules();
  });

  function handleAction(action: string, params: Record<string, unknown>) {
    return googlechatMessageActions.handleAction({
      action,
      params,
      cfg: {},
      accountId: "default",
    } as never);
  }

  it("describes only send actions when enabled accounts exist", () => {
    listGoogleChatAccountIds.mockReturnValueOnce([]);
    expect(googlechatMessageActions.describeMessageTool?.({ cfg: {} as never })).toBeNull();

    listGoogleChatAccountIds.mockReturnValueOnce(["default"]);
    inspectGoogleChatAccount.mockReturnValueOnce(availableAccount);

    expect(googlechatMessageActions.describeMessageTool?.({ cfg: {} as never })).toEqual({
      actions: ["send"],
    });
  });

  it("keeps account-scoped discovery send-only", () => {
    inspectGoogleChatAccount.mockReturnValue(availableAccount);

    for (const accountId of ["default", "work"]) {
      expect(
        googlechatMessageActions.describeMessageTool?.({ cfg: {} as never, accountId }),
      ).toEqual({ actions: ["send"] });
    }
  });

  it("sends text through the resolved space", async () => {
    const account = { credentialSource: "service-account" };
    resolveGoogleChatAccount.mockReturnValue(account);
    resolveGoogleChatOutboundSpace.mockResolvedValue("spaces/AAA");
    const sent = {
      messageName: "spaces/AAA/messages/msg-1",
      threadName: "spaces/AAA/threads/thread-1",
    };
    sendGoogleChatMessage.mockResolvedValue(sent);

    const result = await handleAction("send", {
      to: "spaces/AAA",
      message: "caption",
      threadId: "thread-1",
    });

    expect(resolveGoogleChatOutboundSpace).toHaveBeenCalledWith({
      account,
      target: "spaces/AAA",
    });
    expect(sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/AAA",
      text: "caption",
      thread: "thread-1",
    });
    const details = { ok: true, to: "spaces/AAA", ...sent };
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
      details,
    });
  });

  it.each([
    { media: "remote.png" },
    { mediaUrls: ["remote.png"] },
    { attachments: [{ url: "remote.png" }] },
  ])("rejects outbound attachment %j before provider access", async (attachment) => {
    await expect(
      handleAction("send", { to: "spaces/AAA", message: "caption", ...attachment }),
    ).rejects.toThrow(
      "Google Chat outbound attachments require user OAuth and are not supported by this service-account channel.",
    );

    expect(resolveGoogleChatAccount).not.toHaveBeenCalled();
    expect(resolveGoogleChatOutboundSpace).not.toHaveBeenCalled();
    expect(sendGoogleChatMessage).not.toHaveBeenCalled();
  });

  it("rejects unsupported actions without provider access", async () => {
    const action = "react";
    resolveGoogleChatAccount.mockReturnValue({ credentialSource: "service-account" });

    await expect(
      handleAction(action, { messageId: "spaces/AAA/messages/msg-1", emoji: "👍" }),
    ).rejects.toThrow(`Action ${action} is not supported for provider googlechat.`);

    expect(sendGoogleChatMessage).not.toHaveBeenCalled();
  });
});
