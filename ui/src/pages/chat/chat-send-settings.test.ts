/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionsListResult, SessionsPatchResult } from "../../api/types.ts";
import {
  createResolvedModelPatch,
  createSessionsListResult,
} from "../../test-helpers/chat-model.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { expectRpc, makeChatHost } from "./chat-host.test-support.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { switchChatModel } from "./chat-session.ts";
import { getPendingChatPickerPatch } from "./chat-settings-patches.ts";

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => vi.stubGlobal("sessionStorage", createStorageMock()));
const mainHello = () => ({
  ...sessionMutationGatewayHello(),
  snapshot: {
    sessionDefaults: {
      defaultAgentId: "main",
      mainKey: "main",
      mainSessionKey: "agent:main:main",
    },
  },
});
function modelHost(
  overrides: Parameters<typeof makeChatHost>[0] & { requestHandlers: Record<string, unknown> },
) {
  const host = makeChatHost(overrides);
  onTestFinished(() => host.sessions.dispose());
  return host;
}

it("does not patch the model for a locked session", async () => {
  const sessionsResult = createSessionsListResult({ model: "gpt-5.5" });
  Object.assign(sessionsResult.sessions[0]!, {
    key: "agent:main:main",
    modelSelectionLocked: true,
    updatedAt: 1,
  });
  const host = modelHost({
    requestHandlers: {},
    sessionKey: "main",
    hello: mainHello(),
    sessionsResult,
  });

  await expect(switchChatModel(host, "openai/gpt-5.4")).resolves.toBe(false);
  expect(host.request).not.toHaveBeenCalled();
});

it("sends without waiting for the background roster", async () => {
  const roster = createDeferred<SessionsListResult>();
  const host = modelHost({
    requestHandlers: {
      "sessions.list": () => roster.promise,
      "chat.send": { status: "started" },
    },
    chatMessage: "send without changing a picker",
  });
  const refresh = host.sessions.refresh({ force: true });
  try {
    expect(getPendingChatPickerPatch(host, host.sessionKey)).toBeUndefined();
    await handleSendChat(host);
    expect(host.request.mock.calls.some(([method]) => method === "sessions.patch")).toBe(false);
    expectRpc(
      host.request,
      "chat.send",
      expect.objectContaining({ message: "send without changing a picker" }),
    );
  } finally {
    roster.resolve(createSessionsListResult());
    await refresh;
  }
});

it.each(["success", "failure"] as const)(
  "settles picker %s before a later roster refresh",
  async (outcome) => {
    const patch = createDeferred<SessionsPatchResult>();
    const reconciliation = createDeferred<SessionsListResult>();
    const unrelated = createDeferred<SessionsListResult>();
    const initial = createSessionsListResult({ model: "gpt-5", modelOverrideSource: "user" });
    for (const row of initial.sessions) {
      row.sessionId = "main";
    }
    const result = createSessionsListResult({
      model: "gpt-5.6-luna",
      modelProvider: "openai",
      modelOverrideSource: "user",
    });
    let lists = 0;
    const host = modelHost({
      sessionKey: "main",
      hello: mainHello(),
      requestHandlers: {
        "sessions.patch": () => patch.promise,
        "sessions.list": () => {
          lists += 1;
          return lists === 1 ? initial : lists === 2 ? reconciliation.promise : unrelated.promise;
        },
        "chat.send": { status: "started" },
      },
      chatMessage: "use my confirmed model",
    });
    await host.sessions.refresh({ agentId: "main", force: true });
    const selection = switchChatModel(host, "openai/gpt-5.6-luna");
    const send = handleSendChat(host);
    let later: Promise<void> | undefined;
    try {
      await waitForFast(() => expect(host.chatQueue[0]?.sendState).toBe("waiting-model"));
      expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
      patch.resolve(createResolvedModelPatch("gpt-5.6-luna", "openai"));
      await waitForFast(() => expect(lists).toBe(2));
      // A later roster read must not extend the picker's delivery barrier.
      later = host.sessions.refresh({ force: true, backgroundHydrate: true });
      if (outcome === "failure") {
        reconciliation.reject(new Error("Roster refresh unavailable"));
      } else {
        reconciliation.resolve(result);
      }
      await waitForFast(() => expect(lists).toBe(3));
      await waitForFast(() =>
        expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(true),
      );
      await expect(selection).resolves.toBe(true);
      await send;
      expect(host.sessions.state.modelOverrides.main).toBeUndefined();
      expect(host.sessions.state.result?.sessions[0]?.model).toBe("gpt-5.6-luna");
      if (outcome === "failure") {
        expect(host.sessions.state.error).toBe("Roster refresh unavailable");
      }
    } finally {
      patch.resolve(createResolvedModelPatch("gpt-5.6-luna", "openai"));
      reconciliation.resolve(result);
      unrelated.resolve(result);
      await Promise.allSettled([selection, send, later]);
    }
  },
);
