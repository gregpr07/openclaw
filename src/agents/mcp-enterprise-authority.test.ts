import { expect, it } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withMcpEnterpriseBearer } from "./mcp-enterprise-fetch.js";
import { mcpEnterpriseIdpStoreKey, type McpEnterpriseConfig } from "./mcp-enterprise.js";
import { clearMcpOAuthStore } from "./mcp-oauth-store.js";
import { seedMcpOAuthStoreForTest, withMcpOAuthTestLease } from "./mcp-oauth.test-support.js";

const resource = "http://127.0.0.1:40101/mcp";
const authorizationServer = "http://127.0.0.1:40102";
const idp = "http://127.0.0.1:40103";
const config: McpEnterpriseConfig = {
  identity: "shared",
  idpIssuer: idp,
  idpClientId: "fixture-idp-client",
  idpClientSecret: "fixture-idp-secret",
  resourceIssuer: authorizationServer,
  resourceClientId: "fixture-resource-client",
  resourceClientSecret: "fixture-resource-secret",
  scope: "mcp.read",
  redirectUrl: "http://localhost:3097/callback",
};

it.each([
  ["idp", "logout"],
  ["idp", "replacement"],
  ["resource-as", "logout"],
  ["resource-as", "replacement"],
] as const)(
  "stops enterprise redemption after %s response during %s",
  async (blockedAt, change) => {
    await withOpenClawTestState({ label: `mcp-enterprise-${blockedAt}-${change}` }, async () => {
      const storeKey = mcpEnterpriseIdpStoreKey(config);
      const seed = (authorizationId: string) =>
        seedMcpOAuthStoreForTest(storeKey, {
          authorizationId,
          tokens: {
            access_token: "fixture-idp-access",
            id_token: "fixture-id-token",
            token_type: "Bearer",
          },
          tokenExpiresAt: Date.now() + 300_000,
        });
      seed("first-account");
      const entered = createDeferredCore<void>();
      const release = createDeferredCore<void>();
      const requests: string[] = [];
      const blockedUrl = blockedAt === "idp" ? `${idp}/token` : `${authorizationServer}/token`;
      let blocked = false;
      const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = request.url;
        requests.push(url);
        if (url === blockedUrl && !blocked) {
          blocked = true;
          entered.resolve();
          await release.promise;
        }
        if (url === resource) {
          return request.headers.get("authorization") === "Bearer fixture-resource-token"
            ? Response.json({ ok: true })
            : new Response(null, {
                status: 401,
                headers: {
                  "www-authenticate": `Bearer resource_metadata="${resource}/metadata"`,
                },
              });
        }
        if (url === `${resource}/metadata`) {
          return Response.json({ resource, authorization_servers: [authorizationServer] });
        }
        if (url === `${authorizationServer}/.well-known/oauth-authorization-server`) {
          return Response.json({
            issuer: authorizationServer,
            token_endpoint: `${authorizationServer}/token`,
            authorization_endpoint: `${authorizationServer}/authorize`,
            response_types_supported: ["code"],
            authorization_grant_profiles_supported: ["urn:ietf:params:oauth:grant-profile:id-jag"],
          });
        }
        if (url === `${idp}/.well-known/oauth-authorization-server`) {
          return Response.json({
            issuer: idp,
            token_endpoint: `${idp}/token`,
            authorization_endpoint: `${idp}/authorize`,
            response_types_supported: ["code"],
          });
        }
        if (url === `${idp}/token`) {
          return Response.json({
            access_token: "fixture-id-jag",
            issued_token_type: "urn:ietf:params:oauth:token-type:id-jag",
            token_type: "N_A",
            expires_in: 300,
          });
        }
        if (url === `${authorizationServer}/token`) {
          return Response.json({
            access_token: "fixture-resource-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
        }
        throw new Error(`Unexpected fixture request: ${url}`);
      };
      const fetch = withMcpEnterpriseBearer({
        resourceUrl: resource,
        config,
        fetchFn,
        authFetchFn: fetchFn,
      });
      const first = fetch(resource);
      await awaitGateBeforeSettlement(
        entered.promise,
        first,
        "MCP request settled before the paused exchange",
      );
      if (change === "logout") {
        await withMcpOAuthTestLease(storeKey, (lease, context) =>
          clearMcpOAuthStore({ storeKey, lease, context }),
        );
      } else {
        seed("replacement-account");
      }
      release.resolve();
      await expect(first).rejects.toThrow(/expired|changed/i);
      expect(requests.filter((url) => url === resource)).toHaveLength(1);
      expect(requests.filter((url) => url === `${authorizationServer}/token`)).toHaveLength(
        blockedAt === "idp" ? 0 : 1,
      );

      if (change === "logout") {
        seed("replacement-account");
      }
      expect((await fetch(resource)).status).toBe(200);
      expect(requests.filter((url) => url === resource)).toHaveLength(3);
    });
  },
);
