import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import type { CommandInteraction, CommandWithSubcommands } from "../internal/discord.js";
import { createDiscordLivePolicyReader } from "../monitor/live-policy.js";
import { createDiscordVoiceCommand } from "./command.js";
import type { DiscordVoiceManager } from "./voice-runtime.js";

function findVoiceSubcommand(command: CommandWithSubcommands, name: string) {
  const subcommand = command.subcommands.find((entry) => entry.name === name);
  if (!subcommand) {
    throw new Error(`Missing vc ${name} subcommand`);
  }
  return subcommand;
}

function createVoiceCommandHarness(
  manager: DiscordVoiceManager | null = null,
  overrides: Partial<Parameters<typeof createDiscordVoiceCommand>[0]> = {},
) {
  const command = createDiscordVoiceCommand({
    cfg: {},
    discordConfig: { allowFrom: ["*"] },
    accountId: "default",
    groupPolicy: "open",
    getManager: () => manager,
    ephemeralDefault: true,
    ...overrides,
  });
  return {
    command,
    leave: findVoiceSubcommand(command, "leave"),
    status: findVoiceSubcommand(command, "status"),
  };
}

function createInteraction(overrides?: Partial<CommandInteraction>) {
  const reply = vi.fn(async () => undefined);
  const defer = vi.fn(async () => undefined);
  const interaction = {
    guild: undefined,
    user: { id: "u1", username: "tester" },
    rawData: { member: { roles: [] } },
    defer,
    reply,
    ...overrides,
  } as unknown as CommandInteraction;
  return { interaction, reply, defer };
}

function guildInteraction(overrides?: Partial<CommandInteraction>) {
  return createInteraction({
    guild: { id: "g1", name: "Guild" } as CommandInteraction["guild"],
    ...overrides,
  });
}
function statusHarness(overrides?: Parameters<typeof createVoiceCommandHarness>[1]) {
  const statusSpy = vi.fn(() => []);
  return {
    ...createVoiceCommandHarness(
      { status: statusSpy } as unknown as DiscordVoiceManager,
      overrides,
    ),
    statusSpy,
  };
}
function expectReply(reply: ReturnType<typeof vi.fn>, content: string) {
  expect(reply).toHaveBeenCalledWith({ content, ephemeral: true });
}

describe("createDiscordVoiceCommand", () => {
  it("serializes subcommands without top-level command-only fields", () => {
    const { command } = createVoiceCommandHarness(null);
    const serialized = command.serialize();
    const firstOption = serialized.options?.[0];

    expect(serialized.options?.map((option) => option.name)).toEqual(["join", "leave", "status"]);

    expect(firstOption).toEqual({
      name: "join",
      type: 1,
      description: "Join a voice channel",
      options: [
        {
          name: "channel",
          description: "Voice channel to join",
          type: 7,
          required: true,
          channel_types: [2, 13],
        },
      ],
    });
  });

  it("dispatches slash-command subcommand interactions", async () => {
    const { command } = createVoiceCommandHarness(null);
    const { interaction, reply, defer } = guildInteraction({
      rawData: {
        data: {
          options: [{ name: "status", type: 1 }],
        },
        member: { roles: [] },
      } as unknown as CommandInteraction["rawData"],
    });

    await command.run(interaction);

    expect(defer).toHaveBeenCalledWith({ ephemeral: true });
    expectReply(reply, "Voice manager is not available yet.");
  });

  it("vc leave reports missing guild before manager lookup", async () => {
    const { leave } = createVoiceCommandHarness(null);
    const { interaction, reply } = createInteraction();

    await leave.run(interaction);

    expect(reply).toHaveBeenCalledTimes(1);
    expectReply(reply, "Unable to resolve guild for this command.");
  });

  it.each([
    { owner: "100000000000000001", authorized: true },
    { owner: "discord:100000000000000001", authorized: true },
    { owner: "discord:user:100000000000000001", authorized: true },
    { owner: "user:100000000000000001", authorized: true },
    { owner: "pk:100000000000000001", authorized: true },
    { owner: "user:*", authorized: false },
    { owner: "pk:*", authorized: false },
  ])("preserves owner target authority for vc commands: $owner", async ({ owner, authorized }) => {
    const ownerId = "100000000000000001";
    const { status, statusSpy } = statusHarness({
      cfg: { commands: { ownerAllowFrom: [owner] } },
      discordConfig: { dmPolicy: "disabled", allowFrom: ["*"] },
    });
    const { interaction, reply } = guildInteraction({
      user: { id: ownerId, username: "owner" } as CommandInteraction["user"],
    });

    await status.run(interaction);

    expect(statusSpy).toHaveBeenCalledTimes(1);
    expectReply(
      reply,
      authorized ? "No active voice sessions." : "You are not authorized to use this command.",
    );
  });

  it("runs vc leave only for the current typed owner", async () => {
    const ownerId = "100000000000000001";
    const otherId = "100000000000000002";
    const discordConfig: DiscordAccountConfig = { dmPolicy: "disabled", allowFrom: ["*"] };
    let cfg: OpenClawConfig = {
      commands: { ownerAllowFrom: [`discord:user:${ownerId}`] },
      channels: { discord: discordConfig },
    };
    const leaveSpy = vi.fn(async () => ({ ok: true, message: "Left voice." }));
    const manager = { status: () => [], leave: leaveSpy } as unknown as DiscordVoiceManager;
    const { leave } = createVoiceCommandHarness(manager, {
      cfg,
      discordConfig,
      readPolicy: createDiscordLivePolicyReader({
        cfg,
        readConfig: () => cfg,
        accountId: "default",
        token: "discord-test-token",
        discordConfig,
        resolvedAllowlist: { guildEntries: undefined, allowFrom: ["*"] },
      }),
    });
    const runAs = async (id: string) => {
      const { interaction, reply } = guildInteraction({
        user: { id, username: "member" } as CommandInteraction["user"],
      });
      await leave.run(interaction);
      return reply.mock.calls[0]?.[0];
    };

    expect(await runAs(otherId)).toMatchObject({
      content: "You are not authorized to use this command.",
    });
    expect(leaveSpy).not.toHaveBeenCalled();
    expect(await runAs(ownerId)).toMatchObject({ content: "Left voice." });
    expect(leaveSpy).toHaveBeenCalledTimes(1);

    // The live policy reader sees owner reassignment before the next privileged effect.
    cfg = { ...cfg, commands: { ownerAllowFrom: [`discord:user:${otherId}`] } };
    expect(await runAs(ownerId)).toMatchObject({
      content: "You are not authorized to use this command.",
    });
    expect(leaveSpy).toHaveBeenCalledTimes(1);
  });

  it("normalizes an account wildcard before admitting vc commands", async () => {
    const { status, statusSpy } = statusHarness({
      discordConfig: { allowFrom: [" * "], guilds: { g1: {} } },
      groupPolicy: "allowlist",
    });
    const { interaction, reply } = guildInteraction({
      user: { id: "u-guest", username: "guest" } as CommandInteraction["user"],
    });

    await status.run(interaction);

    expect(statusSpy).toHaveBeenCalledTimes(1);
    expectReply(reply, "No active voice sessions.");
  });

  it("vc status handles channels without optional metadata", async () => {
    const { status, statusSpy } = statusHarness();
    const { interaction, reply } = guildInteraction({
      channel: { id: "123456789012345678" } as CommandInteraction["channel"],
      client: { fetchChannel: vi.fn(async () => null) } as unknown as CommandInteraction["client"],
    });

    await expect(status.run(interaction)).resolves.toBeUndefined();

    expect(statusSpy).toHaveBeenCalledTimes(1);
    expectReply(reply, "No active voice sessions.");
  });
});
