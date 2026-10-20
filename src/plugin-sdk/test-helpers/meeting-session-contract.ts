import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MeetingJoinRequest } from "../../meeting-bot/plugin-entry.js";
import type {
  MeetingPluginSession,
  MeetingPluginChromeHealth,
} from "../../meeting-bot/session-types.js";
import {
  meetingBrowserActScripts as browserActScripts,
  type MeetingBrowserFixture,
} from "./meeting-browser.js";

type Session = MeetingPluginSession<
  "chrome" | "chrome-node",
  "agent" | "bidi" | "transcribe",
  MeetingPluginChromeHealth<string, string>
>;
type Runtime = {
  join(request: MeetingJoinRequest): Promise<{ session: Session }>;
  list(): Session[];
  status(sessionId?: string): Promise<{ found: boolean; session?: Session }>;
  leave(sessionId: string): Promise<unknown>;
  transcript(sessionId: string): Promise<unknown>;
  speak(sessionId: string, message: string): Promise<unknown>;
};

export function defineMeetingSessionFlowTests(options: {
  createFixture(options?: {
    config?: unknown;
    harness?: { tabOpen?: boolean };
    fullConfig?: OpenClawConfig;
  }): { harness: MeetingBrowserFixture; runtime: Runtime };
  url: string;
  tabId: string;
  rewrittenUrl: string;
  rewrittenUrlTestName: string;
  endedHealth: Partial<MeetingPluginChromeHealth<string, string>>;
}) {
  const joinMeeting = (runtime: Runtime, request: Partial<MeetingJoinRequest> = {}) =>
    runtime.join({ url: options.url, mode: "transcribe", ...request });
  const joinedFixture = async (config?: Parameters<typeof options.createFixture>[0]) => {
    const fixture = options.createFixture(config);
    const { session } = await joinMeeting(fixture.runtime);
    return { ...fixture, session, id: session.id };
  };
  const expectTranscriptScripts = (harness: MeetingBrowserFixture, start = 0) => {
    const scripts = browserActScripts(harness, start);
    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toContain("const allowSessionAdoption = false");
    expect(scripts[1]).toContain("expectedSessionId");
    return scripts;
  };
  const audioHealth = (active: boolean) => ({
    audioInputActive: active,
    audioInputRouted: active,
    audioOutputActive: active,
    audioOutputRouted: active,
    captioning: active,
    providerConnected: active,
    realtimeReady: active,
  });
  it("joins, reuses, reports, snapshots, speaks safely, and leaves through core", async () => {
    const { harness, runtime, session, id } = await joinedFixture({
      fullConfig: { agents: { entries: { operator: {} } } },
    });
    expect(session).toMatchObject({
      agentId: "operator",
      chrome: { health: { inCall: true, cameraOff: true } },
    });
    const reused = await joinMeeting(runtime, {
      url: `${options.url.split("?")[0]}?context=%7b%22Tid%22%3a%22two%22%7d`,
    });
    expect(reused.session.id).toBe(id);
    expect(runtime.list()).toHaveLength(1);
    expect(await runtime.status(id)).toMatchObject({ found: true, session: { id } });
    const transcriptStartCall = harness.gatewayRequest.mock.calls.length;
    expect(await runtime.transcript(id)).toMatchObject({ found: true, lines: [], nextIndex: 0 });
    const transcriptActScripts = expectTranscriptScripts(harness, transcriptStartCall);
    expect(transcriptActScripts[0]).toContain("const captureCaptions = true");
    expect(await runtime.speak(id, "hello")).toMatchObject({ found: true, spoken: false });
    Object.assign(session.chrome?.health ?? {}, audioHealth(true));
    const health = {
      ...audioHealth(false),
      ...options.endedHealth,
      providerConnected: false,
      realtimeReady: false,
    };
    expect(await runtime.leave(id)).toMatchObject({
      found: true,
      browserLeft: true,
      session: { state: "ended", chrome: { health } },
    });
    expect(harness.gatewayRequest).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({ path: "/tabs/open" }),
      expect.objectContaining({ scopes: ["operator.admin"] }),
    );
  });

  it("reads an archived transcript without reclaiming a newer live tab owner", async () => {
    const { harness, runtime, id } = await joinedFixture();
    harness.state.sessionConflict = true;
    harness.gatewayRequest.mockClear();

    expect(await runtime.transcript(id)).toMatchObject({
      found: true,
      lines: [{ text: "Archived caption" }],
    });
    expectTranscriptScripts(harness);
  });

  it("recovers and leaves a manually opened tab when Chrome launching is disabled", async () => {
    const { harness, runtime, session, id } = await joinedFixture({
      harness: { tabOpen: true },
      config: { defaultMode: "transcribe", chrome: { launch: false, waitForInCallMs: 1 } },
    });
    expect(session.chrome).toMatchObject({
      browserTab: { openedByPlugin: false, targetId: options.tabId },
      launched: false,
    });
    expect(harness.gatewayRequest).not.toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({ path: "/tabs/open" }),
      expect.anything(),
    );
    expect(await runtime.leave(id)).toMatchObject({
      browserLeft: true,
      session: { state: "ended" },
    });
  });

  it("refreshes a recovered browser tab target", async () => {
    const { harness, runtime, session, id } = await joinedFixture();
    for (const [method, suffix] of [
      ["status", "replaced"],
      ["transcript", "replaced-again"],
    ] as const) {
      const targetId = `${options.tabId}-${suffix}`;
      harness.state.targetId = targetId;
      harness.gatewayRequest.mockClear();
      await runtime[method](id);
      expect(session.chrome?.browserTab).toEqual({ openedByPlugin: false, targetId });
    }
    const transcriptRead = harness.gatewayRequest.mock.calls.find(([, params]) => {
      const fn = (params.body as { fn?: unknown } | undefined)?.fn;
      return params.path === "/act" && typeof fn === "string" && fn.includes("expectedSessionId");
    });
    expect(transcriptRead?.[1]).toMatchObject({
      body: { targetId: `${options.tabId}-replaced-again` },
    });
  });

  it(options.rewrittenUrlTestName, async () => {
    const { harness, runtime, id } = await joinedFixture();
    harness.state.tabUrl = options.rewrittenUrl;
    harness.gatewayRequest.mockClear();

    const status = await runtime.status(id);

    expect(status.session?.chrome?.health?.browserUrl).toBe(options.rewrittenUrl);
    expect(harness.gatewayRequest).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({
        path: "/act",
        body: expect.objectContaining({ targetId: options.tabId }),
      }),
      expect.objectContaining({ scopes: ["operator.admin"] }),
    );
  });
}
