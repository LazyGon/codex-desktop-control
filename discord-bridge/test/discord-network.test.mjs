import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscordRestAgent, discordRestOptions } from '../src/discord-network.mjs';

test('Discord REST uses the shared agent and five-minute network timeouts', async () => {
  const config = {
    discordConnectTimeoutMs: 300_000,
    discordRestTimeoutMs: 300_000,
  };
  const agent = createDiscordRestAgent(config);
  try {
    assert.deepEqual(discordRestOptions(config, agent), {
      timeout: 300_000,
      agent,
    });
  } finally {
    await agent.close();
  }
});
