import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizationConfigErrors, resolveAuthorizationConfig } from '../src/config.mjs';

test('authorization config collapses legacy allowlists to the completion mention user', () => {
  const config = resolveAuthorizationConfig({
    allowedUserIds: ['111111111111111', '222222222222222'],
    completionMentionUserId: '222222222222222',
  });

  assert.equal(config.authorizedUserId, '222222222222222');
  assert.equal(config.completionMentionUserId, '222222222222222');
  assert.deepEqual(config.allowedUserIds, ['222222222222222']);
});

test('explicit authorized user becomes the single legacy-compatible allowlist entry', () => {
  const config = resolveAuthorizationConfig({
    authorizedUserId: '333333333333333',
    allowedUserIds: ['111111111111111', '222222222222222'],
  });

  assert.equal(config.authorizedUserId, '333333333333333');
  assert.equal(config.completionMentionUserId, '333333333333333');
  assert.deepEqual(config.allowedUserIds, ['333333333333333']);
});

test('authorization config fails closed when the completion mention targets another user', () => {
  const errors = authorizationConfigErrors({
    authorizedUserId: '111111111111111',
    completionMentionUserId: '222222222222222',
  });

  assert.deepEqual(errors, ['completionMentionUserId must match authorizedUserId.']);
});
