import { auth, extractWWWAuthenticateParams, type FetchLike } from "@modelcontextprotocol/client";
import {
  createMcpEnterpriseProvider,
  readMcpEnterpriseAuthorizationId,
  type McpEnterpriseConfig,
} from "./mcp-enterprise.js";

async function requestInit(request: Request): Promise<RequestInit> {
  return {
    method: request.method,
    headers: request.headers,
    body: request.body ? await request.arrayBuffer() : undefined,
    signal: request.signal,
  };
}

/** Keep resource tokens bound to one server and one transport instance. */
export function withMcpEnterpriseBearer(params: {
  resourceUrl: string;
  config: McpEnterpriseConfig;
  fetchFn: FetchLike;
  authFetchFn: FetchLike;
}): FetchLike {
  const resourceOrigin = new URL(params.resourceUrl).origin;
  let cached: { authorizationId: string; token: string; expiresAt: number } | undefined;
  type ResourceAuthorization = { authorizationId: string; token: string; expiresAt: number };
  const authorizations = new Map<string, Promise<ResourceAuthorization>>();
  const authorize = async (
    authorizationId: string,
    challenge?: ReturnType<typeof extractWWWAuthenticateParams>,
  ): Promise<string> => {
    const grantedScopes = new Set(params.config.scope.split(/\s+/).filter(Boolean));
    const requestedScopes = challenge?.scope?.split(/\s+/).filter(Boolean);
    if (requestedScopes?.some((scope) => !grantedScopes.has(scope))) {
      throw new Error("Enterprise MCP server requested a scope outside the configured grant.");
    }
    const scope = requestedScopes?.join(" ") || params.config.scope;
    const key = JSON.stringify([authorizationId, scope]);
    let pending = authorizations.get(key);
    if (!pending) {
      pending = (async () => {
        const provider = createMcpEnterpriseProvider(params.config, params.authFetchFn);
        const result = await auth(provider, {
          serverUrl: params.resourceUrl,
          scope,
          resourceMetadataUrl: challenge?.resourceMetadataUrl,
          fetchFn: params.authFetchFn,
        });
        const tokens = provider.tokens();
        if (result !== "AUTHORIZED" || !tokens?.access_token) {
          throw new Error("Enterprise MCP authorization did not return an access token.");
        }
        if ((await readMcpEnterpriseAuthorizationId(params.config)) !== authorizationId) {
          throw new Error("Enterprise SSO changed during MCP authorization. Retry the request.");
        }
        return {
          authorizationId,
          token: tokens.access_token,
          expiresAt: Date.now() + Math.max(0, (tokens.expires_in ?? 300) - 30) * 1000,
        };
      })();
      authorizations.set(key, pending);
    }
    try {
      const result = await pending;
      if (result.authorizationId !== authorizationId) {
        throw new Error("Enterprise SSO changed during MCP authorization. Retry the request.");
      }
      cached = result;
      return result.token;
    } finally {
      if (authorizations.get(key) === pending) {
        authorizations.delete(key);
      }
    }
  };
  return async (input, init) => {
    const request = new Request(input instanceof Request ? input.clone() : input, init);
    if (new URL(request.url).origin !== resourceOrigin) {
      return params.fetchFn(request.url, await requestInit(request));
    }
    const authorizationId = await readMcpEnterpriseAuthorizationId(params.config);
    if (cached?.authorizationId !== authorizationId) {
      cached = undefined;
    }
    const original = await requestInit(request);
    const token = cached && cached.expiresAt > Date.now() ? cached.token : undefined;
    const firstHeaders = new Headers(original.headers);
    if (token) {
      firstHeaders.set("authorization", `Bearer ${token}`);
    }
    const response = await params.fetchFn(request.url, { ...original, headers: firstHeaders });
    if (response.status !== 401 && response.status !== 403) {
      return response;
    }
    const challenge = extractWWWAuthenticateParams(response);
    if (response.status === 403 && challenge.error !== "insufficient_scope") {
      return response;
    }
    await response.body?.cancel().catch(() => undefined);
    cached = undefined;
    const freshToken = await authorize(authorizationId, challenge);
    const retryHeaders = new Headers(original.headers);
    retryHeaders.set("authorization", `Bearer ${freshToken}`);
    return params.fetchFn(request.url, { ...original, headers: retryHeaders });
  };
}
