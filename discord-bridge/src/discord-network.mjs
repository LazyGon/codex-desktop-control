import { Agent } from 'undici';

export function createDiscordRestAgent(config) {
  return new Agent({
    connectTimeout: config.discordConnectTimeoutMs,
  });
}

export function discordRestOptions(config, agent) {
  return {
    timeout: config.discordRestTimeoutMs,
    agent,
  };
}
