import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  ReplyBackendQueueMessageOptions,
  ReplyOperation,
} from "../../sessions/session-controller.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { isExplicitFollowupCommandTurn } from "../command-turn-context.js";
import { handleFollowupCommand } from "./commands-followup.js";
import { buildCommandTestParams } from "./commands.test-harness.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { createMockFollowupRun } from "./test-helpers.js";

const { handleSteerCommand } = await import("./commands-steer.js");

const baseCfg = {
  commands: { text: true },
  session: { mainKey: "main", scope: "per-sender" },
} as OpenClawConfig;
const queueMessage = vi.fn(
  async (_text: string, _options?: ReplyBackendQueueMessageOptions) => undefined,
);
const operations: ReplyOperation[] = [];

function buildParams(commandBody: string) {
  return buildCommandTestParams(commandBody, baseCfg);
}

function expectBody(params: ReturnType<typeof buildParams>, message: string) {
  expect(params.ctx).toMatchObject({ Body: message, BodyForAgent: message });
  expect(params.command.commandBodyNormalized).toBe(message);
}

async function expectSteer(params: ReturnType<typeof buildParams>, message: string) {
  expect(await handleSteerCommand(params, true)).toEqual({
    shouldContinue: true,
    queueModeOverride: "steer",
  });
  expect(params.ctx.BodyForAgent).toBe(message);
  expect(queueMessage).not.toHaveBeenCalled();
}

async function beginActiveOperation(sessionKey: string, sessionId = "session-active") {
  const authorityRun = createMockFollowupRun({ run: { sessionId, sessionKey } });
  const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
  const { provider, model } = authorityRun.run;
  await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(authorityRun));
  const fingerprint = await operation.bindToolAuthorityRouteAsync({ provider, model });
  operation.setPhase("running");
  operation.attachBackend({
    kind: "embedded",
    cancel: vi.fn(),
    messageInjection: { isAvailable: () => true, queueMessage },
  });
  operations.push(operation);
  return fingerprint;
}

describe("handleSteerCommand", () => {
  beforeEach(() => queueMessage.mockReset().mockResolvedValue(undefined));

  afterEach(() => {
    for (const operation of operations.splice(0)) {
      operation.complete();
    }
  });

  it("routes an active /steer through the prepared reply path without a premature ack", async () => {
    const message = "stop the deploy\nand revert the migration first";
    const params = buildParams(`/steer ${message}`);
    params.opts = { toolsAllow: ["read"] };
    expect(await beginActiveOperation("agent:main:main")).toEqual(expect.any(String));
    await expectSteer(params, message);
    expectBody(params, message);
  });

  it("prefers the native command target over the slash-command source", async () => {
    await beginActiveOperation("agent:main:discord:direct:target", "session-target");
    const params = buildParams("/steer check the target");
    params.ctx.CommandSource = "native";
    params.ctx.CommandTargetSessionKey = "agent:main:discord:direct:target";
    params.sessionKey = "agent:main:discord:slash:user";

    await expectSteer(params, "check the target");
  });

  it("maps a text slash source lane to its active direct conversation", async () => {
    await beginActiveOperation("agent:main:telegram:direct:123", "session-direct-active");
    const params = buildParams("/steer use the active direct lane");
    params.sessionKey = "agent:main:telegram:slash:123";

    await expectSteer(params, "use the active direct lane");
  });

  it("maps a text slash source lane after its active embedded owner's operation clears", async () => {
    const sessionId = "session-direct-active";
    const sessionKey = "agent:main:telegram:direct:123";
    const handle = {
      kind: "embedded" as const,
      queueMessage: vi.fn(),
      isStreaming: () => true,
      isCompacting: () => false,
      abort: vi.fn(),
    };
    setActiveEmbeddedRun(sessionId, handle, sessionKey);
    try {
      const params = buildParams("/steer use the active direct lane");
      params.sessionKey = "agent:main:telegram:slash:123";

      expect(await handleSteerCommand(params, true)).toEqual({
        shouldContinue: true,
        queueModeOverride: "steer",
      });
      expect(params.ctx.BodyForAgent).toBe("use the active direct lane");
    } finally {
      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
    }
  });

  it("returns usage for an empty steer command", async () => {
    expect(await handleSteerCommand(buildParams("/steer"), true)).toEqual({
      shouldContinue: false,
      reply: { text: "Usage: /steer <message>" },
    });
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("continues visibly as a normal prompt when no direct owner is active", async () => {
    const params = buildParams("/steer keep going");
    expect(await handleSteerCommand(params, true)).toEqual({ shouldContinue: true });
    expectBody(params, "keep going");
    expect(queueMessage).not.toHaveBeenCalled();
  });
});

describe("handleFollowupCommand", () => {
  it.each(["text", "native"] as const)(
    "preserves authorized %s intent while forwarding only the message without an early ack",
    async (source) => {
      const message = "review the result\n\n    keep the formatting";
      const params = buildParams(`/followup ${message}`);
      params.ctx.CommandSource = source;
      params.rootCtx = { ...params.ctx };
      params.sessionEntry = { sessionId: "session-followup", updatedAt: 1, queueMode: "collect" };

      expect(await handleFollowupCommand(params, true)).toEqual({
        shouldContinue: true,
        queueModeOverride: "followup",
      });
      for (const ctx of [params.ctx, params.rootCtx]) {
        expect(ctx).toMatchObject({ Body: message, BodyForAgent: message });
        expect(isExplicitFollowupCommandTurn(ctx)).toBe(true);
        expect(ctx.CommandTurn).toMatchObject({
          source,
          authorized: true,
          commandName: "followup",
        });
      }
      expect(params.command.commandBodyNormalized).toBe(message);
      expect(params.sessionEntry.queueMode).toBe("collect");
    },
  );

  it("returns usage without dispatching an empty followup or accepting unauthorized input", async () => {
    expect(await handleFollowupCommand(buildParams("/followup"), true)).toEqual({
      shouldContinue: false,
      reply: { text: "Usage: /followup <message>" },
    });
    const params = buildParams("/followup private instruction");
    params.command.isAuthorizedSender = false;
    params.ctx.CommandAuthorized = false;
    expect(await handleFollowupCommand(params, true)).toEqual({ shouldContinue: false });
    expect(isExplicitFollowupCommandTurn(params.ctx)).toBe(false);
    expect(params.ctx.Body).toBe("/followup private instruction");
  });
});
