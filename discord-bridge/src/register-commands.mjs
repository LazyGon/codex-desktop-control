import { REST, Routes } from 'discord.js';
import { commandPayload } from './commands.mjs';
import { loadConfig, requireBotToken } from './config.mjs';

const config = loadConfig();
const token = requireBotToken();
const rest = new REST({ version: '10' }).setToken(token);

const result = await rest.put(
  Routes.applicationGuildCommands(config.applicationId, config.guildId),
  { body: commandPayload },
);

process.stdout.write(`${JSON.stringify({ registered: result.length, guildId: config.guildId }, null, 2)}\n`);
