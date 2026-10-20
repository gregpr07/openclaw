import { ChannelType } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  auditDiscordChannelPermissionsWithFetcher,
  collectDiscordAuditChannelIdsForAccount,
} from "./audit-core.js";

const fetchChannelPermissionsDiscordMock = vi.fn();

function audit(
  channelIds: string[],
  cfg: OpenClawConfig = {
    channels: { discord: { enabled: true, token: "t" } },
  },
) {
  return auditDiscordChannelPermissionsWithFetcher({
    cfg,
    token: "t",
    accountId: "default",
    channelIds,
    timeoutMs: 1000,
    fetchChannelPermissions: fetchChannelPermissionsDiscordMock,
  });
}

describe("discord audit", () => {
  beforeEach(() => {
    fetchChannelPermissionsDiscordMock.mockReset();
  });

  it("collects numeric channel ids even when config uses allow=false and counts unresolved keys", async () => {
    const guilds = {
      "123": {
        channels: {
          "111": { allow: true },
          general: { allow: true },
          "222": { allow: false },
        },
      },
    };
    const cfg = {
      channels: {
        discord: {
          enabled: true,
          token: "t",
          groupPolicy: "allowlist",
          guilds,
        },
      },
    } as unknown as OpenClawConfig;

    const collected = collectDiscordAuditChannelIdsForAccount({
      guilds: cfg.channels?.discord?.guilds,
    });
    expect(collected.channelIds).toEqual(["111", "222"]);
    expect(collected.unresolvedChannels).toBe(1);

    fetchChannelPermissionsDiscordMock.mockResolvedValueOnce({
      permissions: ["ViewChannel"],
    });
    fetchChannelPermissionsDiscordMock.mockResolvedValueOnce({
      permissions: ["ViewChannel", "SendMessages"],
    });

    const result = await audit(collected.channelIds, cfg);
    expect(result.ok).toBe(false);
    expect(result.channels).toHaveLength(2);
    expect(result.channels[0]?.channelId).toBe("111");
    expect(result.channels[0]?.missing).toContain("SendMessages");
  });

  it("does not count '*' wildcard key as unresolved channel", () => {
    const cfg = {
      channels: {
        discord: {
          guilds: { "123": { channels: { "111": { allow: true }, "*": { allow: true } } } },
        },
      },
    } as unknown as OpenClawConfig;
    const collected = collectDiscordAuditChannelIdsForAccount({
      guilds: cfg.channels?.discord?.guilds,
    });
    expect(collected.channelIds).toEqual(["111"]);
    expect(collected.unresolvedChannels).toBe(0);
  });

  it("includes configured voice auto-join channels in permission audits", () => {
    const collected = collectDiscordAuditChannelIdsForAccount({
      guilds: {
        "123": {
          channels: {
            "111": { enabled: true },
          },
        },
      },
      voice: {
        autoJoin: [
          { guildId: "123", channelId: "222" },
          { guildId: "123", channelId: "general" },
        ],
      },
    });

    expect(collected.channelIds).toEqual(["111", "222"]);
    expect(collected.unresolvedChannels).toBe(1);
  });

  it.each([ChannelType.GuildVoice, ChannelType.GuildStageVoice])(
    "requires voice permissions for voice channel audit targets of type %s",
    async (channelType) => {
      fetchChannelPermissionsDiscordMock.mockResolvedValueOnce({
        permissions: ["ViewChannel", "SendMessages"],
        channelType,
      });
      const result = await audit(["222"]);
      expect(result.ok).toBe(false);
      expect(result.channels[0]?.missing).toEqual(["Connect", "Speak", "ReadMessageHistory"]);
    },
  );

  it.each([
    ChannelType.GuildNewsThread,
    ChannelType.GuildPublicThread,
    ChannelType.GuildPrivateThread,
  ])("requires thread send permission for thread audit targets of type %s", async (channelType) => {
    fetchChannelPermissionsDiscordMock.mockResolvedValueOnce({
      permissions: ["ViewChannel", "SendMessages"],
      channelType,
    });
    const result = await audit(["333"]);
    expect(result.ok).toBe(false);
    expect(result.channels[0]?.missing).toEqual(["SendMessagesInThreads"]);
  });
});
