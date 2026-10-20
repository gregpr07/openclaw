import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import { MatrixMediaSizeLimitError } from "../media-errors.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixRoomMessageEvent,
} from "./handler.test-helpers.js";

const { downloadMatrixMediaMock } = vi.hoisted(() => ({
  downloadMatrixMediaMock: vi.fn(),
}));

vi.mock("./media.js", async () => {
  const actual = await vi.importActual<typeof import("./media.js")>("./media.js");
  return {
    ...actual,
    downloadMatrixMedia: (...args: unknown[]) => downloadMatrixMediaMock(...args),
  };
});

function createMediaFailureHarness() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const runtime = { error: vi.fn() };
  const harness = createMatrixHandlerTestHarness({
    cfg: {
      session: { store: "/tmp/openclaw-test-session.json" },
      channels: { matrix: { dm: { allowFrom: ["*"] } } },
    },
    logger: logger as never,
    runtime: runtime as never,
    shouldHandleTextCommands: () => true,
    resolveMarkdownTableMode: () => "code",
    resolveAgentRoute: () => ({
      agentId: "main",
      accountId: "ops",
      sessionKey: "agent:main:matrix:channel:!room:example.org",
      mainSessionKey: "agent:main:main",
      channel: "matrix",
      matchedBy: "binding.account",
    }),
    getRoomInfo: async () => ({
      name: "Media Room",
      canonicalAlias: "#media:example.org",
      altAliases: [],
    }),
    getMemberDisplayName: async () => "Gum",
    mediaMaxBytes: 5 * 1024 * 1024,
    replyToMode: "first",
  });

  return {
    ...harness,
    logger,
    runtime,
    context: () => {
      const ctx = harness.runPrepared.mock.calls[0]![0].ctxPayload;
      expect(harness.recordInboundSession).toHaveBeenCalledWith(expect.objectContaining({ ctx }));
      return ctx;
    },
  };
}

function createImageEvent(content: Record<string, unknown>) {
  return createMatrixRoomMessageEvent({
    eventId: "$event1",
    sender: "@gum:matrix.example.org",
    content: {
      ...content,
      "m.mentions": { user_ids: ["@bot:matrix.example.org"] },
    } as never,
  });
}

describe("createMatrixRoomMessageHandler media failures", () => {
  beforeEach(() => {
    downloadMatrixMediaMock.mockReset();
    installMatrixMonitorTestRuntime();
  });

  it("downloads encrypted image attachments when the top-level URL is blank", async () => {
    downloadMatrixMediaMock.mockResolvedValue({
      path: "/tmp/inbound/encrypted-image.png",
      contentType: "image/png",
      placeholder: "[matrix image attachment]",
    });
    const { handler, context } = createMediaFailureHarness();
    const file = {
      url: "mxc://example/encrypted-image",
      key: { kty: "oct", key_ops: ["encrypt"], alg: "A256CTR", k: "secret", ext: true },
      iv: "iv",
      hashes: { sha256: "hash" },
      v: "v2",
    };

    await handler(
      "!room:example.org",
      createImageEvent({
        msgtype: "m.image",
        body: " \t ",
        filename: " encrypted-image.png ",
        url: " \t ",
        file,
        info: { mimetype: "image/png", size: 123 },
      }),
    );

    expect(downloadMatrixMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mxcUrl: "mxc://example/encrypted-image",
        file,
        originalFilename: "encrypted-image.png",
      }),
    );
    expect(context().MediaPath).toBe("/tmp/inbound/encrypted-image.png");
  });

  it("replaces bare image filenames with an unavailable marker when unencrypted download fails", async () => {
    downloadMatrixMediaMock.mockRejectedValue(new Error("download failed"));
    const { handler, context, logger, runtime } = createMediaFailureHarness();

    await handler(
      "!room:example.org",
      createImageEvent({
        msgtype: "m.image",
        body: "image.png",
        url: "mxc://example/image",
      }),
    );

    expect(context()).toMatchObject({
      RawBody: "[matrix image attachment unavailable]",
      CommandBody: "[matrix image attachment unavailable]",
    });
    expect(context().MediaPath).toBeUndefined();
    expect(logger.warn.mock.calls[0]).toEqual([
      "matrix media download failed",
      expect.objectContaining({ eventId: "$event1", msgtype: "m.image", encrypted: false }),
    ]);
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("preserves a real caption while marking the attachment too large on size limit error", async () => {
    downloadMatrixMediaMock.mockRejectedValue(new MatrixMediaSizeLimitError());
    const { handler, context } = createMediaFailureHarness();

    await handler(
      "!room:example.org",
      createImageEvent({
        msgtype: "m.image",
        body: "check this out",
        filename: "large-photo.jpg",
        url: "mxc://example/big-image",
      }),
    );

    expect(context()).toMatchObject({
      RawBody: "check this out\n\n[matrix image attachment too large]",
      CommandBody: "check this out\n\n[matrix image attachment too large]",
    });
  });
});
