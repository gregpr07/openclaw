import { beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixConfigSchema } from "../../config-schema.js";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import type { CoreConfig, MatrixConfig } from "../../types.js";
import { resolveMatrixAccountConfig } from "../account-config.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";
import type { MatrixRawEvent } from "./types.js";

const roomId = "!room:example.org";
const botUserId = "@bot:example.org";

describe("Matrix bot-owned thread mention policy", () => {
  beforeEach(() => installMatrixMonitorTestRuntime());

  function setup(matrix: MatrixConfig = {}) {
    expect(MatrixConfigSchema.parse(matrix)).toEqual(matrix);
    const cfg: CoreConfig = { channels: { matrix } };
    const accountConfig = resolveMatrixAccountConfig({ cfg, accountId: "work" });
    const root = createMatrixTextMessageEvent({
      eventId: "$root",
      sender: botUserId,
      body: "Discussion started by the bot",
    });
    const getEvent = vi.fn(async () => root);
    const dispatch = vi.fn(async () => ({
      queuedFinal: false,
      counts: { final: 0, block: 0, tool: 0 },
    }));
    const harness = createMatrixHandlerTestHarness({
      cfg,
      accountId: "work",
      accountConfig,
      roomsConfig: accountConfig.groups ?? accountConfig.rooms,
      groupPolicy: accountConfig.groupPolicy ?? "open",
      isDirectMessage: false,
      client: { getEvent },
      dispatchInboundMessage: dispatch,
    });
    return {
      ...harness,
      root,
      getEvent,
      dispatch,
      receive: (overrides: Partial<Parameters<typeof createMatrixTextMessageEvent>[0]> = {}) =>
        harness.handler(
          roomId,
          createMatrixTextMessageEvent({
            eventId: "$followup",
            body: "Continue the discussion",
            relatesTo: { rel_type: "m.thread", event_id: "$root" },
            ...overrides,
          }),
        ),
    };
  }

  it.each<[string, MatrixConfig]>([
    [
      "account",
      {
        requireMentionInBotThreads: true,
        accounts: { work: { requireMentionInBotThreads: false } },
      },
    ],
    [
      "exact group",
      {
        groups: {
          "*": { requireMentionInBotThreads: true },
          [roomId]: { requireMentionInBotThreads: false },
        },
      },
    ],
  ])("accepts unmentioned bot-thread replies with %s configuration", async (_scope, config) => {
    const f = setup(config);
    await f.receive();
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          BodyForAgent: "Continue the discussion",
          ThreadStarterBody: expect.stringContaining("Discussion started by the bot"),
        }),
      }),
    );
    expect(f.getEvent).toHaveBeenCalledTimes(1);
  });

  it("retains mention gating when bot-thread policy explicitly requires it", async () => {
    const f = setup({ requireMentionInBotThreads: true, rooms: { [roomId]: { autoReply: true } } });

    await f.receive();
    expect(f.dispatch).not.toHaveBeenCalled();

    await f.receive({
      eventId: "$mentioned",
      body: `${botUserId} Continue the discussion`,
      mentions: { user_ids: [botUserId] },
    });
    expect(f.dispatch).toHaveBeenCalledOnce();
  });

  it.each<[string, Partial<MatrixRawEvent> | null]>([
    ["another author's root", { sender: "@other:example.org" }],
    ["another event id", { event_id: "$other" }],
    ["another room", { room_id: "!other:example.org" }],
    ["an unreadable root", null],
  ])("retains mention gating for %s", async (_kind, patch) => {
    const f = setup({ requireMentionInBotThreads: false });
    if (patch) {
      f.getEvent.mockResolvedValue({ ...f.root, ...patch });
    } else {
      f.getEvent.mockRejectedValue(new Error("M_FORBIDDEN"));
    }

    await f.receive();

    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("accepts a bot-authored root whose content was redacted", async () => {
    const f = setup({ requireMentionInBotThreads: false });
    f.getEvent.mockResolvedValue({
      ...f.root,
      content: {},
      unsigned: { redacted_because: {} },
    });

    await f.receive();

    expect(f.dispatch).toHaveBeenCalledOnce();
  });

  it.each<[string, MatrixConfig]>([
    ["disabled rooms", { groupPolicy: "disabled" }],
    ["room sender allowlists", { rooms: { [roomId]: { users: ["@trusted:example.org"] } } }],
  ])("preserves %s inside bot threads", async (_restriction, config) => {
    const f = setup({ ...config, requireMentionInBotThreads: false });

    await f.receive();

    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.getEvent).not.toHaveBeenCalled();
  });
});
