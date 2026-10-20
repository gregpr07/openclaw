import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import * as inProcessGateway from "./tools/in-process-gateway.js";
import { withSessionToolTestCaller } from "./tools/sessions-tool.test-helpers.js";

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));

afterEach(() => vi.restoreAllMocks());

function assemble(options: Parameters<typeof createOpenClawCodingTools>[0] = {}, deny?: string[]) {
  return createOpenClawCodingTools({
    config: { tools: { allow: ["sessions", "sessions_create"], deny } },
    sessionKey: "agent:main:main",
    senderIsOwner: false,
    workspaceDir: process.cwd(),
    ...options,
  });
}

describe("session responsibility assignment in non-owner turns", () => {
  it.each([
    { senderIsOwner: false, messageProvider: "webchat" },
    { senderIsOwner: undefined, messageProvider: undefined },
  ])(
    "limits assignment without channel policy or senderless management changes ($messageProvider)",
    async ({ senderIsOwner, messageProvider }) => {
      const gateway = vi.spyOn(inProcessGateway, "callAgentToolGatewayRequest").mockResolvedValue({
        ok: true,
        key: "agent:main:main",
        owner: { actor: { type: "human", id: "profile-requester", label: "Requester" } },
      });
      const tools = assemble({
        config: { tools: { allow: ["sessions"] } },
        messageProvider,
        senderIsOwner,
      });
      const tool = tools.find((candidate) => candidate.name === "sessions");
      expect(
        tool,
        "non-owner turns need the visibility-authorized assignment action",
      ).toBeDefined();
      if (!tool) {
        throw new Error("sessions tool missing");
      }
      const assignmentOnly = senderIsOwner === false;
      // Stable schema; non-owner limits apply at execution.
      expect(tool.parameters).toHaveProperty(
        "properties.action.enum",
        expect.arrayContaining(["assign_owner", "patch", "group_set"]),
      );
      if (assignmentOnly) {
        await expect(
          withSessionToolTestCaller(() =>
            tool.execute("refused-patch", { action: "group_set", names: ["ops"] }),
          ),
        ).rejects.toThrow("Only assign_owner is available to non-owner callers");
      }
      const owner = { type: "human", id: "profile-requester" };
      const action = assignmentOnly
        ? { action: "assign_owner", ownerType: owner.type, ownerId: owner.id }
        : { action: "patch", label: "Scheduled session" };
      const result = await withSessionToolTestCaller(() => tool.execute("manage-session", action));
      expect(result.details).toMatchObject({
        status: "updated",
        ...(assignmentOnly ? { owner } : {}),
      });
      expect(gateway).toHaveBeenCalledWith(
        assignmentOnly
          ? {
              method: "sessions.assignOwner",
              params: { key: "agent:main:main", owner },
              agentToolCaller: { agentId: "main", sessionKey: "agent:main:main" },
              assertDispatchCurrent: expect.any(Function),
            }
          : {
              method: "sessions.patch",
              params: { key: "agent:main:main", label: "Scheduled session" },
            },
      );
      const denied = assemble({
        config: { tools: { allow: ["sessions"], deny: ["sessions"] } },
      });
      expect(denied.some((candidate) => candidate.name === "sessions")).toBe(false);
    },
  );
});

describe("standalone session creation tool registration", () => {
  it("exposes creation only with admitted session-write authority and preserves explicit denies", async () => {
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "profile-requester",
      scopes: ["operator.sessions.write"],
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    expect(assemble().some((tool) => tool.name === "sessions_create")).toBe(false);
    await withSessionToolTestCaller(async () => {
      const tools = assemble();
      expect(tools.find((tool) => tool.name === "sessions_create")).toBeDefined();
      expect(tools.find((tool) => tool.name === "sessions")?.parameters).toHaveProperty(
        "properties.action.enum",
        expect.arrayContaining(["patch", "assign_owner", "group_set"]),
      );
      expect(
        assemble({}, ["sessions_create"]).some((tool) => tool.name === "sessions_create"),
      ).toBe(false);
      expect(assemble({}, ["sessions"]).some((tool) => tool.name === "sessions_create")).toBe(true);
    }, authority);
  });
});
