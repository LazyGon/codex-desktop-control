import process from 'node:process';
import { Client, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { loadConfig } from '../src/config.mjs';
import { createDiscordRestAgent, discordRestOptions } from '../src/discord-network.mjs';

const targetGuildId = process.argv[2];
const targetChannelId = process.argv[3];
const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error('DISCORD_BOT_TOKEN is not set.');

const config = loadConfig();
const discordRestAgent = createDiscordRestAgent(config);
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  rest: discordRestOptions(config, discordRestAgent),
});
const timeout = setTimeout(() => {
  process.stderr.write('Discord Gateway readiness timed out after 300 seconds.\n');
  client.destroy();
  process.exitCode = 1;
}, 300_000);

try {
  await client.login(token);
  if (!client.isReady()) await new Promise((resolve) => client.once('clientReady', resolve));
  clearTimeout(timeout);
  const guilds = client.guilds.cache.map((guild) => ({
    id: guild.id,
    name: guild.name,
    ownerId: guild.ownerId,
    available: guild.available,
    memberCount: guild.memberCount,
  }));
  const target = targetGuildId ? client.guilds.cache.get(targetGuildId) : null;
  let targetPermissions = null;
  let targetChannel = null;
  if (target) {
    const me = await target.members.fetchMe();
    const required = [
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.PinMessages,
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.ReadMessageHistory,
    ];
    targetPermissions = {
      bitfield: me.permissions.bitfield.toString(),
      administrator: me.permissions.has(PermissionFlagsBits.Administrator),
      required: Object.fromEntries(required.map((permission) => [permission.toString(), me.permissions.has(permission)])),
      allRequired: required.every((permission) => me.permissions.has(permission)),
    };
    if (targetChannelId) {
      try {
        const channel = await client.channels.fetch(targetChannelId);
        const permissions = channel?.permissionsFor(me);
        targetChannel = channel ? {
          id: channel.id,
          name: channel.name,
          type: channel.type,
          guildId: channel.guildId,
          parentId: channel.parentId,
          viewable: channel.viewable,
          permissions: permissions?.bitfield.toString() ?? null,
        } : null;
      } catch (error) {
        targetChannel = { id: targetChannelId, error: error.message };
      }
    }
  }
  process.stdout.write(`${JSON.stringify({
    ready: true,
    bot: { id: client.user.id, tag: client.user.tag },
    targetGuildId,
    targetVisible: Boolean(target),
    targetOwnerId: target?.ownerId ?? null,
    targetPermissions,
    targetChannelId: targetChannelId ?? null,
    targetChannel,
    guilds,
  }, null, 2)}\n`);
} finally {
  clearTimeout(timeout);
  client.destroy();
  await discordRestAgent.close();
}
