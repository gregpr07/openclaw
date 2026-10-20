// Tests owner gating for group activation session changes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleActivationCommand } from "./commands-session.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const persistSessionEntryMock = vi.hoisted(() => vi.fn(async () => true));
const persistenceConflictReply = vi.hoisted(() => ({
  shouldContinue: false,
  reply: { text: "retry session command" },
}));

vi.mock("./commands-session-store.js", () => ({
  persistCommandSession: persistSessionEntryMock,
  sessionEntryPersistenceConflictReply: () => persistenceConflictReply,
}));

function buildActivationParams(senderIsOwner = true): HandleCommandsParams {
  const commandBody = "/activation always";
  const params = buildCommandTestParams(
    commandBody,
    { commands: { text: true } },
    {
      Surface: "telegram",
      Provider: "telegram",
    },
  );
  Object.assign(params.command, {
    isAuthorizedSender: true,
    senderIsOwner,
    senderId: "group-member",
    ownerList: ["owner"],
    from: "group-member",
    to: "bot",
  });
  return Object.assign(params, {
    directives: {},
    sessionKey: "telegram:group:main",
    sessionEntry: {
      sessionId: "session-1",
      updatedAt: 1,
      channel: "telegram",
      chatType: "group" as const,
      groupActivation: "mention" as const,
    },
    sessionStore: {},
    workspaceDir: "/tmp/workspace",
    provider: "openai",
    model: "gpt-5.5",
    isGroup: true,
  });
}

describe("handleActivationCommand", () => {
  beforeEach(() => {
    persistSessionEntryMock.mockClear();
    persistSessionEntryMock.mockResolvedValue(true);
  });

  it("rejects authorized non-owner senders without changing group activation", async () => {
    const params = buildActivationParams(false);

    const result = await handleActivationCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: expect.stringContaining("commands.ownerAllowFrom") },
    });
    expect(params.sessionEntry?.groupActivation).toBe("mention");
    expect(params.sessionEntry?.groupActivationNeedsSystemIntro).toBeUndefined();
    expect(persistSessionEntryMock).not.toHaveBeenCalled();
  });

  it("allows owners to change group activation", async () => {
    const params = buildActivationParams();

    const result = await handleActivationCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "⚙️ Group activation set to always." },
    });
    expect(params.sessionEntry).toMatchObject({
      groupActivation: "always",
      groupActivationNeedsSystemIntro: true,
    });
    expect(persistSessionEntryMock).toHaveBeenCalledWith({
      ...params,
      touchedFields: ["groupActivation", "groupActivationNeedsSystemIntro"],
    });
  });

  it("reports a concurrent session change instead of acknowledging persistence", async () => {
    const params = buildActivationParams();
    persistSessionEntryMock.mockResolvedValueOnce(false);

    await expect(handleActivationCommand(params, true)).resolves.toEqual(persistenceConflictReply);
  });
});
