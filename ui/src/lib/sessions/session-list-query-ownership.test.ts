import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";
import type { SessionListOptions, SessionListSnapshot } from "./session-capability.ts";
import { canApplySessionListSnapshot } from "./session-list-query.ts";

const row = (key: string, extra: Partial<GatewaySessionRow> = {}): GatewaySessionRow => ({
  key: `agent:main:${key}`,
  sessionId: `${key}-session`,
  kind: "direct",
  updatedAt: 1,
  ...extra,
});
function fixture(
  request: Parameters<typeof createTestGatewayClient>[0],
  query: SessionListOptions,
) {
  const { gateway } = createGatewayHarness(createTestGatewayClient(request));
  const sessions = createTestSessionCapability(gateway);
  const updates = vi.fn<(snapshot: SessionListSnapshot) => void>();
  onTestFinished(sessions.subscribeList(query, updates));
  return { sessions, updates, refresh: () => sessions.refresh({ agentId: "main", force: true }) };
}

it.each([
  [200, 60, true],
  [200, 59, false],
  [2, 2, true],
  [2, 1, false],
] as const)(
  "excludes an old owned ancestor only behind the full owner prefix (limit=%i, owned=%i)",
  (limit, owned, expected) => {
    const actor = (id: string) => ({
      type: "human" as const,
      id,
      identity: { type: "profile" as const, id },
    });
    const rows: GatewaySessionRow[] = Array.from({ length: limit }, (_, index) => ({
      key: `agent:main:child-${index}`,
      sessionId: `child-${index}`,
      kind: "direct",
      updatedAt: 1_000 - index,
      owner: { actor: actor(index < owned ? "viewer" : "other") },
      parentSessionKey: "agent:main:main",
    }));
    const parent = row("main", { sessionId: "parent", owner: { actor: actor("viewer") } });
    const result = {
      ...sessionsResult(rows, 2_000),
      hasMore: true,
      nextOffset: limit,
    };
    const event = {
      reason: "patch",
      session: { ...rows[0], updatedAt: 2_001 },
      ancestorSessions: [parent],
    };
    const query = { agentId: "main", limit, ownerFirst: true };
    const canApply = (ancestor: GatewaySessionRow) =>
      canApplySessionListSnapshot(
        result,
        { ...event, ancestorSessions: [ancestor] },
        query,
        "updatedAt",
        undefined,
        "viewer",
      );
    expect(canApply(parent)).toBe(expected);
    // A parent that becomes recent may enter the shared page even with a full owner prefix.
    expect(canApply({ ...parent, updatedAt: 2_002 })).toBe(false);
  },
);

it("keeps deliberate dock-inclusive queries separate from the ordinary roster", async () => {
  const ordinary: GatewaySessionRow = { key: "agent:main:ordinary", kind: "direct" };
  const dock: GatewaySessionRow = { key: "agent:main:board-agent", kind: "direct", isDock: true };
  const request = vi.fn(async (_method: string, params?: unknown) =>
    sessionsResult(
      asOptionalRecord(params)?.excludeDock === false ? [ordinary, dock] : [ordinary],
      1,
    ),
  );
  const query = { agentId: "main", excludeDock: false };
  const { sessions, updates, refresh } = fixture(request, query);
  const expectOrdinary = () => {
    expect(request).toHaveBeenLastCalledWith(
      "sessions.list",
      expect.objectContaining({ excludeDock: true }),
    );
    expect(sessions.state.result?.sessions).toEqual([ordinary]);
  };
  await refresh();
  expectOrdinary();
  await sessions.refreshList(query);
  expect(request).toHaveBeenLastCalledWith("sessions.list", expect.objectContaining(query));
  expect(sessions.state.result?.sessions).toEqual([ordinary]);
  expect(sessions.listSnapshot(query).result?.sessions).toEqual([ordinary, dock]);
  expect(updates.mock.lastCall?.[0].result?.sessions).toEqual([ordinary, dock]);
  await refresh();
  expectOrdinary();
  expect(sessions.listSnapshot(query).result?.sessions).toEqual([ordinary, dock]);
});

it.each(["unfiltered", "excludeSubagents", "excludeCron", "excludeSystem"] as const)(
  "keeps list and subscription membership scoped for %s",
  async (flag) => {
    const ordinary = row("ordinary", { agentId: "main" });
    const excluded: GatewaySessionRow = {
      ...ordinary,
      key:
        flag === "excludeSubagents"
          ? "agent:main:subagent:worker"
          : flag === "excludeCron"
            ? "agent:main:cron:scheduled"
            : "agent:main:system:maintenance",
      sessionId: "excluded-session",
    };
    let primaryRows = [ordinary, excluded];
    let issued = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      const filtered = flag !== "unfiltered" && asOptionalRecord(params)?.[flag] === true;
      return sessionsResult(filtered ? [ordinary] : primaryRows, ++issued);
    });
    const query: SessionListOptions = { agentId: "main" };
    if (flag !== "unfiltered") {
      query[flag] = true;
    }
    const { sessions, updates, refresh } = fixture(request, query);
    const descriptor = sessions.observeRow({ key: excluded.key, agentId: "main" }, () => {});
    onTestFinished(() => descriptor.dispose());
    await refresh();
    const primaryBefore = sessions.state.result;
    const canonicalRevision = sessions.canonicalListRevision;
    const heldDescriptor = descriptor.row;
    expect(heldDescriptor).toMatchObject(excluded);
    updates.mockClear();

    const result = await sessions.list(query);
    const expectedRows = flag === "unfiltered" ? primaryRows : [ordinary];
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject(query);
    expect(result?.sessions).toEqual(expectedRows);
    expect(sessions.state.result).toBe(primaryBefore);
    expect(updates).not.toHaveBeenCalled();

    await sessions.refreshList({ ...query, force: true });
    expect(updates.mock.calls.at(-1)?.[0].result?.sessions).toEqual(expectedRows);
    const queryWindow = sessions.listSnapshot(query).result;
    expect(queryWindow?.sessions).toEqual(expectedRows);
    expect(descriptor.isCurrent()).toBe(true);
    expect(descriptor.row).toBe(heldDescriptor);
    if (flag === "unfiltered") {
      expect(queryWindow).toBe(sessions.state.result);
      expect(sessions.canonicalListRevision).toBe(canonicalRevision + 1);
    } else {
      expect(sessions.state.result).toBe(primaryBefore);
      expect(sessions.state.result?.sessions).toEqual(primaryRows);
      expect(sessions.canonicalListRevision).toBe(canonicalRevision);
      expect(queryWindow).not.toBe(primaryBefore);
    }

    updates.mockClear();
    primaryRows = [...primaryRows, row("later", { agentId: "main" })];
    await refresh();
    expect(sessions.state.result?.sessions).toEqual(primaryRows);
    if (flag === "unfiltered") {
      expect(updates.mock.calls.at(-1)?.[0].result).toBe(sessions.state.result);
      expect(sessions.listSnapshot(query).result).toBe(sessions.state.result);
    } else {
      expect(updates).not.toHaveBeenCalled();
      expect(sessions.listSnapshot(query).result).toBe(queryWindow);
      expect(sessions.listSnapshot(query).result?.sessions).toEqual([ordinary]);
    }
  },
);
