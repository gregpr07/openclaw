// Prove authoritative Mattermost channel kinds over the real Bot API transport.
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { resolveMattermostOutboundSessionRoute } from "../session-route.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { resolveMattermostOpaqueTarget } from "./target-resolution.js";

const PUBLIC_CHANNEL_ID = "abcdefghijklmnopqrstuvwxyz";
const PRIVATE_CHANNEL_ID = "bcdefghijklmnopqrstuvwxyza";
const cases = [
  { id: PUBLIC_CHANNEL_ID, kind: "channel", type: "O" },
  { id: PRIVATE_CHANNEL_ID, kind: "group", type: "P" },
] as const;

describe("Mattermost opaque channel resolution over real HTTP", () => {
  it("preserves real public and private channel identities in outbound thread routes", async () => {
    const requests: Array<{ method: string; path: string; authorization?: string }> = [];

    await withServer(
      (request, response) => {
        const path = request.url ?? "";
        requests.push({
          method: request.method ?? "",
          path,
          authorization: request.headers.authorization,
        });
        response.setHeader("content-type", "application/json");

        if (path.startsWith("/api/v4/users/")) {
          response.writeHead(404);
          response.end(JSON.stringify({ message: "user not found" }));
          return;
        }

        const channel = cases.find(({ id }) => path === `/api/v4/channels/${id}`);
        if (channel) {
          response.writeHead(200);
          response.end(JSON.stringify({ id: channel.id, type: channel.type }));
          return;
        }

        response.writeHead(404);
        response.end(JSON.stringify({ message: "unexpected loopback path" }));
      },
      async (baseUrl) => {
        const cfg = {
          channels: {
            mattermost: {
              botToken: "mattermost-loopback-fixture",
              baseUrl,
              network: { dangerouslyAllowPrivateNetwork: true },
            },
          },
        } as OpenClawConfig;

        for (const testCase of cases) {
          const resolved = await resolveMattermostOpaqueTarget({
            input: testCase.id,
            cfg,
            accountId: "default",
          });
          expect(resolved).toEqual({
            kind: testCase.kind,
            id: testCase.id,
            to: `channel:${testCase.id}`,
          });

          const route = resolveMattermostOutboundSessionRoute({
            cfg,
            agentId: "main",
            accountId: "default",
            target: `channel:${testCase.id}`,
            resolvedTarget: {
              to: `channel:${testCase.id}`,
              kind: testCase.kind,
              source: "directory",
            },
            threadId: "loopback-thread",
          });
          expect(route).toMatchObject({
            peer: { kind: testCase.kind, id: testCase.id },
            chatType: testCase.kind,
            from: `mattermost:${testCase.kind}:${testCase.id}`,
            to: `channel:${testCase.id}`,
            sessionKey: `agent:main:mattermost:${testCase.kind}:${testCase.id}:thread:loopback-thread`,
          });
        }

        expect(requests).toEqual(
          cases.flatMap(({ id }) =>
            ["users", "channels"].map((resource) => ({
              method: "GET",
              path: `/api/v4/${resource}/${id}`,
              authorization: "Bearer mattermost-loopback-fixture",
            })),
          ),
        );
      },
    );
  });
});
