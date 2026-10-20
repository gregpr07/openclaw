import { describe, expect, it } from "vitest";
import { createApiKeyCredential } from "./credential-fixtures.test-support.js";
import {
  buildPortableAuthProfileStoreForAgentCopy,
  resolveAuthProfilePortability,
} from "./portability.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";

const oauth = {
  type: "oauth",
  provider: "openai",
  access: "access-token",
  refresh: "refresh-token",
  expires: Date.now() + 60_000,
} satisfies AuthProfileCredential;

describe("auth profile portability", () => {
  it("copies static credentials but skips OAuth refresh tokens by default", () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:api-key": createApiKeyCredential("openai", "sk-test"),
        "github-copilot:default": {
          type: "token",
          provider: "github-copilot",
          token: "gho-test",
        },
        "openai:default": oauth,
      },
      order: {
        openai: ["openai:default", "openai:api-key"],
        "github-copilot": ["github-copilot:default"],
      },
      lastGood: { openai: "openai:api-key" },
      usageStats: { "openai:api-key": { lastUsed: 1_000 } },
    };

    const portable = buildPortableAuthProfileStoreForAgentCopy(store);

    expect(portable).toEqual({
      copiedProfileIds: ["openai:api-key", "github-copilot:default"],
      skippedProfileIds: ["openai:default"],
      store: {
        version: 1,
        profiles: {
          "openai:api-key": store.profiles["openai:api-key"],
          "github-copilot:default": store.profiles["github-copilot:default"],
        },
        order: { openai: ["openai:api-key"], "github-copilot": ["github-copilot:default"] },
      },
    });
  });

  it("allows provider-owned OAuth profiles to opt in explicitly", () => {
    expect(
      resolveAuthProfilePortability({ ...oauth, provider: "demo", copyToAgents: true }),
    ).toEqual({
      portable: true,
      reason: "oauth-provider-opted-in",
    });
  });

  it("does not copy empty OAuth profiles even when they opt in", () => {
    const credential = {
      type: "oauth",
      provider: "openai",
      expires: Date.now() + 60_000,
      copyToAgents: true,
      oauthRef: {
        source: "openclaw-credentials",
        provider: "openai",
        id: "0123456789abcdef0123456789abcdef",
      },
    } as unknown as AuthProfileCredential;

    expect(resolveAuthProfilePortability(credential)).toEqual({
      portable: false,
      reason: "non-portable-oauth-refresh-token",
    });
  });

  it("lets static credentials opt out", () => {
    expect(
      resolveAuthProfilePortability({
        type: "api_key",
        provider: "openai",
        key: "sk-test",
        copyToAgents: false,
      }),
    ).toEqual({
      portable: false,
      reason: "credential-opted-out",
    });
  });
});
