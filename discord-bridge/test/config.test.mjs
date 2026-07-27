import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizationConfigErrors,
  MIN_DISCORD_NETWORK_TIMEOUT_MS,
  resolveAuthorizationConfig,
  resolveDiscordTimeoutConfig,
} from '../src/config.mjs';

test('legacy authorization and completion mention settings remain independent', () => {
  const config = resolveAuthorizationConfig({
    allowedUserIds: ['111111111111111', '222222222222222'],
    completionMentionUserId: '333333333333333',
  });

  assert.deepEqual(config.authorizedUserIds, ['111111111111111', '222222222222222']);
  assert.deepEqual(config.completionMentionUserIds, ['333333333333333']);
  assert.deepEqual(config.allowedUserIds, config.authorizedUserIds);
  assert.equal(config.authorizedUserId, '111111111111111');
  assert.equal(config.completionMentionUserId, '333333333333333');
});

test('new authorization and completion mention lists deduplicate independently', () => {
  const config = resolveAuthorizationConfig({
    authorizedUserIds: ['111111111111111', '222222222222222', '111111111111111'],
    completionMentionUserIds: ['333333333333333', '333333333333333'],
  });

  assert.deepEqual(config.authorizedUserIds, ['111111111111111', '222222222222222']);
  assert.deepEqual(config.completionMentionUserIds, ['333333333333333']);
});

test('authorization validation requires authorized users but permits no fixed subscribers', () => {
  assert.deepEqual(authorizationConfigErrors({
    authorizedUserIds: ['111111111111111'],
    completionMentionUserIds: [],
  }), []);

  assert.deepEqual(authorizationConfigErrors({
    authorizedUserIds: [],
    completionMentionUserIds: ['invalid'],
  }), [
    'authorizedUserIds must contain at least one Discord user id.',
    'Every completionMentionUserIds entry must be a Discord snowflake.',
  ]);
});

test('Discord connection and REST response timeouts are never shorter than five minutes', () => {
  assert.deepEqual(resolveDiscordTimeoutConfig({
    discordRestTimeoutMs: 30_000,
    discordConnectTimeoutMs: 10_000,
  }), {
    discordRestTimeoutMs: MIN_DISCORD_NETWORK_TIMEOUT_MS,
    discordConnectTimeoutMs: MIN_DISCORD_NETWORK_TIMEOUT_MS,
  });
  assert.deepEqual(resolveDiscordTimeoutConfig({
    discordRestTimeoutMs: 600_000,
    discordConnectTimeoutMs: 450_000,
  }), {
    discordRestTimeoutMs: 600_000,
    discordConnectTimeoutMs: 450_000,
  });
});
