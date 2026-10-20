import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type {
  SessionEventOptions,
  SessionEventOutcome,
} from "../auto-reply/reply/session-event-contract.js";
import type { RestoredGatewayOperatorAuthority } from "../gateway/operator-run-recovery.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { resolveCronSourceDeliveryPlan } from "./isolated-agent/source-delivery-plan.js";
import { runCronSessionTurn } from "./session-run.js";

const fixture = vi.hoisted(() => ({
  config: {},
  capture:
    vi.fn<
      typeof import("../auto-reply/reply/session-event-handoff.js").captureSessionEventTargetForHost
    >(),
  enqueue:
    vi.fn<
      typeof import("../auto-reply/reply/session-event-handoff.js").enqueueSessionEventForHost
    >(),
  delivery:
    vi.fn<typeof import("./isolated-agent/run-delivery-trace.js").resolveCronDeliveryContext>(),
  restore: vi.fn<typeof import("../gateway/cron-operator-source.js").restoreCronOperatorSource>(),
}));

// mock-isolation: Fixed session receipts exercise the Cron owner without invoking a model.
vi.mock("../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: fixture.capture,
  enqueueSessionEventForHost: fixture.enqueue,
}));
// mock-isolation: The fixture supplies current configuration independently of process state.
vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => fixture.config }));
// mock-isolation: The fixed route avoids loading external channel runtimes; retain trace logic.
vi.mock("./isolated-agent/run-delivery-trace.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./isolated-agent/run-delivery-trace.js")>()),
  resolveCronDeliveryContext: fixture.delivery,
}));
// mock-isolation: The restoration boundary supplies an independently revocable source lease.
vi.mock("../gateway/cron-operator-source.js", () => ({
  restoreCronOperatorSource: fixture.restore,
}));

beforeEach(() => {
  vi.resetAllMocks();
  fixture.capture.mockResolvedValue({
    sessionId: "target-session",
    sessionKey: "agent:main:scheduled",
    lifecycleRevision: "target-revision",
    generation: "target-generation",
  });
  const deliveryPlan = { mode: "none" as const, source: "delivery" as const, requested: false };
  const resolvedDelivery = {
    ok: false as const,
    mode: "implicit" as const,
    error: new Error("delivery is disabled"),
  };
  fixture.delivery.mockResolvedValue({
    deliveryPlan,
    deliveryRequested: false,
    resolvedDelivery,
    sourceDelivery: resolveCronSourceDeliveryPlan({ deliveryPlan, resolvedDelivery }),
    deliverySystemPrompt: undefined,
    messageToolFormatPrompt: undefined,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function input(): Parameters<typeof runCronSessionTurn>[0] {
  return {
    cfg: fixture.config,
    agentId: "main",
    sessionKey: "agent:main:scheduled",
    admissionSource: "requester-schedule",
    deliveryAttemptFence: null,
    text: "Check the report.",
    job: {
      ...makeCronJob({
        sessionTarget: "session:agent:main:scheduled",
        delivery: { mode: "none" },
      }),
      operatorSource: {
        executionRevision: "original-definition",
        source: {
          version: 1,
          agentId: "main",
          sessionKey: "agent:main:scheduled",
          sessionId: "target-session",
          lifecycleRevision: "target-revision",
          sourceRunId: "original-request",
          snapshot: {
            profileId: "requester",
            scopes: ["operator.read"],
            assignedRole: null,
            githubLogin: null,
            grant: null,
            aliasBindingIds: [],
            authPolicy: {
              generation: "",
              grantGeneration: "original-grant",
              role: "operator",
              authMethod: "token",
            },
            controlUiAdmin: true,
            localOperator: false,
            sourceIngress: "control-ui",
          },
        },
      },
    },
    prepare: vi.fn(async () => {}),
    assertCurrent: vi.fn(() => {}),
  };
}

function restoredSource(): RestoredGatewayOperatorAuthority {
  const authority: AdmittedRunOperatorAuthority = {
    profileId: "requester",
    scopes: ["operator.read"],
    assertCurrent: vi.fn(() => {}),
  };
  return {
    authority,
    assertPolicyCurrent: vi.fn(),
    authenticatedUserProfile: {
      profileId: "requester",
      displayName: null,
      avatarRevision: "0",
      hasAvatar: false,
      updatedAt: 0,
    },
    controlUiAdmin: true,
    release: vi.fn(),
  };
}

describe("scheduled session prompts", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T16:00:00Z"));
    fixture.enqueue.mockReturnValue({
      id: "event",
      cancel: () => false,
      accepted: Promise.resolve({ ok: true }),
      settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
    });
  });

  it("submits the job identity and localized current time with the scheduled instructions", async () => {
    const params = input();
    params.cfg = { agents: { defaults: { userTimezone: "America/Los_Angeles" } } };
    await runCronSessionTurn(params);
    const text = fixture.enqueue.mock.calls[0]?.[0];
    expect(text).toContain("[cron:job-1 test] Check the report.");
    expect(text).toMatch(/Current time: .*9:00.*\(America\/Los_Angeles\)/);
    expect(text).toContain("Reference UTC: 2026-10-20 16:00 UTC");
  });

  it.each([
    ["hook:gmail:message", "Email"],
    ["agent:main:hook:gmail:message", "Email"],
    ["agent:main:hook:custom:message", "Webhook"],
  ])(
    "wraps legacy external content sent to %s without an explicit source marker",
    async (sessionKey, source) => {
      const params = input();
      params.sessionKey = sessionKey;
      params.job.sessionTarget = `session:${sessionKey}`;
      await runCronSessionTurn(params);
      const text = fixture.enqueue.mock.calls[0]?.[0];
      expect(text).toContain(`Source: ${source}`);
      expect(text).toMatch(
        /<<<EXTERNAL_UNTRUSTED_CONTENT id="[^"]+">>>[\s\S]*Check the report\.[\s\S]*<<<END_EXTERNAL_UNTRUSTED_CONTENT id="[^"]+">>>[\s\S]*This is an unattended scheduled run/,
      );
      expect(text).not.toContain("the job's instructions win");
      expect(text).not.toContain("remove it if your available tools allow");
    },
  );

  it("honors the existing Gmail unsafe-content opt-in without granting trusted job guidance", async () => {
    const params = input();
    params.sessionKey = "agent:main:hook:gmail:message";
    params.job.sessionTarget = `session:${params.sessionKey}`;
    params.cfg = { hooks: { gmail: { allowUnsafeExternalContent: true } } };
    await runCronSessionTurn(params);
    const text = fixture.enqueue.mock.calls[0]?.[0];
    expect(text).toContain("[cron:job-1 test] Check the report.");
    expect(text).not.toContain("EXTERNAL_UNTRUSTED_CONTENT");
    expect(text).not.toContain("the job's instructions win");
  });
});

describe("scheduled session execution custody", () => {
  it("retains the restored source after acceptance until the controller settles", async () => {
    const source = restoredSource();
    fixture.restore.mockResolvedValue(source);
    const accepted = createDeferred<{ ok: true }>();
    const terminal = createDeferred<SessionEventOutcome>();
    const enqueued = createDeferred<SessionEventOptions>();
    fixture.enqueue.mockImplementation((_text, options) => {
      enqueued.resolve(options);
      return {
        id: "event",
        cancel: () => false,
        accepted: accepted.promise,
        settled: terminal.promise,
      };
    });
    const onExecutionStarted = vi.fn();
    const run = runCronSessionTurn({ ...input(), onExecutionStarted });
    const options = await awaitGateBeforeSettlement(
      enqueued.promise,
      run,
      "settled before enqueue",
    );
    accepted.resolve({ ok: true });
    await accepted.promise;
    expect(source.release).not.toHaveBeenCalled();
    expect(options.scheduledAutomation?.operatorAuthority).toBe(source.authority);
    expect(options.scheduledAutomation?.controlUiAdmin).toBe(true);
    expect(options.scheduledAutomation?.admissionSource).toBe("requester-schedule");
    options.scheduledAutomation?.onExecutionStarted?.({
      runId: "scheduled-run",
      sessionId: "target-session",
      sessionKey: "agent:main:scheduled",
    });
    terminal.resolve({
      status: "completed",
      executionStarted: true,
      delivered: false,
      summary: "Report checked.",
      nextCheckMs: 120_000,
    });
    await expect(run).resolves.toMatchObject({
      status: "ok",
      summary: "Report checked.",
      sessionId: "target-session",
      sessionKey: "agent:main:scheduled",
      nextCheck: { delayMs: 120_000 },
    });
    expect(source.release).toHaveBeenCalledOnce();
    expect(onExecutionStarted).toHaveBeenCalledOnce();
  });

  it.each(["failed", "cancelled"] as const)(
    "records controller %s as error and releases the restored source",
    async (status) => {
      const source = restoredSource();
      fixture.restore.mockResolvedValue(source);
      fixture.enqueue.mockReturnValue({
        id: "event",
        cancel: () => false,
        accepted: Promise.resolve({ ok: true }),
        settled: Promise.resolve({ status, executionStarted: false, delivered: false }),
      });
      await expect(runCronSessionTurn(input())).resolves.toMatchObject({ status: "error" });
      expect(source.release).toHaveBeenCalledOnce();
    },
  );

  it("refuses a source revoked while restoration was awaited", async () => {
    const source = restoredSource();
    const restoring = createDeferred();
    const restored = createDeferred<RestoredGatewayOperatorAuthority>();
    fixture.restore.mockImplementation(() => {
      restoring.resolve();
      return restored.promise;
    });
    const run = runCronSessionTurn(input());
    await awaitGateBeforeSettlement(restoring.promise, run, "settled before restoring source");
    vi.mocked(source.authority.assertCurrent).mockImplementation(() => {
      throw new Error("original requester revoked");
    });
    restored.resolve(source);
    await expect(run).rejects.toThrow("original requester revoked");
    expect(fixture.enqueue).not.toHaveBeenCalled();
    expect(source.release).toHaveBeenCalledOnce();
  });
});
