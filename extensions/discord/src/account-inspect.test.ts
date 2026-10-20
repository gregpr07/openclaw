import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { inspectDiscordAccount } from "./account-inspect.js";

function inspectWorkAccount(discord: unknown) {
  return inspectDiscordAccount({
    cfg: { channels: { discord } } as OpenClawConfig,
    accountId: "work",
  });
}

describe("inspectDiscordAccount", () => {
  it("prefers account token over channel token and strips Bot prefix", () => {
    const inspected = inspectWorkAccount({
      token: "Bot channel-token",
      accounts: { work: { token: "Bot account-token" } },
    });
    expect(inspected).toMatchObject({
      token: "account-token",
      tokenSource: "config",
      tokenStatus: "available",
      configured: true,
    });
  });

  it("reports configured_unavailable for unresolved configured secret input", () => {
    const inspected = inspectWorkAccount({
      accounts: { work: { token: { source: "env", id: "DISCORD_TOKEN" } } },
    });
    expect(inspected).toMatchObject({
      token: "",
      tokenSource: "config",
      tokenStatus: "configured_unavailable",
      enabled: true,
      configured: true,
    });
  });

  it("does not fall back when account token key exists but is missing", () => {
    const inspected = inspectWorkAccount({
      token: "Bot channel-token",
      accounts: { work: { token: "" } },
    });
    expect(inspected).toMatchObject({
      token: "",
      tokenSource: "none",
      tokenStatus: "missing",
      enabled: true,
      configured: false,
    });
  });

  it("falls back to channel token when account token is absent", () => {
    const inspected = inspectWorkAccount({
      token: "Bot channel-token",
      accounts: { work: {} },
    });
    expect(inspected).toMatchObject({
      token: "channel-token",
      tokenSource: "config",
      tokenStatus: "available",
      configured: true,
    });
  });

  it("allows env token only for default account", () => {
    const defaultInspected = inspectDiscordAccount({
      cfg: {},
      accountId: "default",
      envToken: "Bot env-default",
    });
    const namedInspected = inspectDiscordAccount({
      cfg: { channels: { discord: { accounts: { work: {} } } } },
      accountId: "work",
      envToken: "Bot env-work",
    });

    expect(defaultInspected).toMatchObject({
      token: "env-default",
      tokenSource: "env",
      configured: true,
    });
    expect(namedInspected).toMatchObject({ token: "", tokenSource: "none", configured: false });
  });
});
