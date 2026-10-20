// Tests /loop recognition, work-order rewriting, authorization, and interval guards.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { normalizeCommandBody } from "../commands-registry-normalize.js";
import { handleLoopCommand } from "./commands-loop.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

function buildLoopParams(commandBodyNormalized: string): HandleCommandsParams {
  const params = buildCommandTestParams(
    commandBodyNormalized,
    {},
    {
      Provider: INTERNAL_MESSAGE_CHANNEL,
      Surface: INTERNAL_MESSAGE_CHANNEL,
      RawBody: commandBodyNormalized,
      BodyForCommands: commandBodyNormalized,
      BodyForAgent: commandBodyNormalized,
      BodyStripped: commandBodyNormalized,
    },
  );
  Object.assign(params.command, {
    isAuthorizedSender: true,
    senderIsOwner: true,
    senderId: "tester",
    ownerList: [],
  });
  return Object.assign(params, {
    directives: {},
    sessionKey: "agent:main:webchat:test",
    provider: "openai",
    model: "gpt-5.6",
  });
}

async function rewrite(body: string): Promise<string> {
  const params = buildLoopParams(body);
  expect(await handleLoopCommand(params, true)).toEqual({ shouldContinue: true });
  return params.ctx.BodyForAgent ?? "";
}

// Mirrors the handler's conversation tag for the fixture sessionKey.
const LOOP_PREFIX = `loop[${createHash("sha256").update("agent:main:webchat:test").digest("hex").slice(0, 12)}]`;

describe("loop command", () => {
  it("ignores non-loop text", async () => {
    expect(await handleLoopCommand(buildLoopParams("check ci"), true)).toBeNull();
  });

  it("returns usage for bare /loop without continuing", async () => {
    const result = await handleLoopCommand(buildLoopParams("/loop"), true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe(
      "Usage: /loop [interval] <prompt> — repeat a prompt in this chat (e.g. /loop 5m check deploy status). Without interval the loop self-paces between 1m and 1h. /loop status lists loops; /loop stop [name] stops.",
    );
  });

  it("rewrites a fixed interval loop as a current-session cron job", async () => {
    const body = await rewrite("/loop 5m check ci");
    expect(body).toContain('schedule:{kind:"every",everyMs:300000}');
    expect(body).toContain('sessionTarget:"current"');
    expect(body).toContain(`"${LOOP_PREFIX} check ci"`);
    expect(body).toContain("do not use the message tool");
    // Loop work orders are model-facing prompts: they must teach the canonical
    // automations tool, never the legacy cron alias (RFC 0026).
    expect(body).toContain("with the automations tool");
    expect(body).not.toMatch(/\bcron tool\b/);
  });

  it("rewrites an interval-free loop with pacing and next_check guidance", async () => {
    const body = await rewrite("/loop watch for new github issues");
    expect(body).toContain('pacing:{min:"1m",max:"1h"}');
    expect(body).toContain('action:\\"next_check\\"');
    expect(body).toContain('in:\\"<duration>\\"');
  });

  it("keeps every line of a multi-line loop prompt and a single-line job name", async () => {
    const body = await rewrite(normalizeCommandBody("/loop 10m check these:\n- CI\n- deploy"));
    expect(body).toContain(`name:"${LOOP_PREFIX} check these: - CI - deploy"`);
    expect(body).toContain(
      'message:"[loop check these: - CI - deploy] check these:\\n- CI\\n- deploy\\nDo the task',
    );
  });

  it("rewrites /loop status as a conversation-scoped list work order", async () => {
    const body = await rewrite("/loop status");
    expect(body).toContain('action:"list", includeDisabled:true');
    expect(body).toContain(`name starts with "${LOOP_PREFIX}"`);
    expect(body).toContain("Use the automations tool");
    expect(body).not.toMatch(/\bcron\b/i);
  });

  it("rewrites /loop stop as a scoped cron removal work order", async () => {
    const body = await rewrite("/loop stop");
    expect(body).toContain('action:"list", includeDisabled:true');
    expect(body).toContain(`name starts with "${LOOP_PREFIX}"`);
    expect(body).toContain('action:"remove"');
    expect(body).toContain(`Never remove a job whose name does not start with "${LOOP_PREFIX}"`);
  });

  it("rejects unauthorized senders", async () => {
    const params = buildLoopParams("/loop 5m check ci");
    params.command.isAuthorizedSender = false;

    expect(await handleLoopCommand(params, true)).toEqual({ shouldContinue: false });
    expect(params.ctx.BodyForAgent).toBe("/loop 5m check ci");
  });

  it("rejects authorized non-owner senders before starting an agent turn", async () => {
    const params = buildLoopParams("/loop 5m check ci");
    params.command.senderIsOwner = false;

    expect(await handleLoopCommand(params, true)).toEqual({
      shouldContinue: false,
      reply: { text: expect.stringContaining("operator.admin") },
    });
    expect(params.ctx.BodyForAgent).toBe("/loop 5m check ci");
  });

  it("rejects intervals below 30 seconds", async () => {
    const result = await handleLoopCommand(buildLoopParams("/loop 5s x"), true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Minimum interval 30s");
  });
});
