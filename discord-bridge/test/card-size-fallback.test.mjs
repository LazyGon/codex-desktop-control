import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverCardWithSizeFallback } from '../src/card-size-fallback.mjs';

test('explicit oversized-card rejection delivers the complete attachment instead', async () => {
  const text = '日本語の完了結果\n'.repeat(300);
  const preview = { description: text };
  const compact = { description: '📎 final.txt', attachment: Buffer.from(text) };
  const received = [];
  const result = await deliverCardWithSizeFallback(async payload => {
    if (payload === preview) throw Object.assign(new Error('oversize'), {status:400,code:40005});
    received.push(payload);
    return {id:'accepted'};
  }, preview, () => compact);
  assert.equal(result.message.id,'accepted');
  assert.equal(result.attachmentOnly,true);
  assert.equal(received[0].attachment.toString('utf8'),text);
});

test('accepted cards and uncertain or unrelated failures never dispatch a fallback', async () => {
  const options = {description:'done'};
  let fallbacks = 0;
  const fallback = () => { fallbacks++; return {}; };
  assert.deepEqual(await deliverCardWithSizeFallback(async () => ({id:'original'}),options,fallback),
    {message:{id:'original'},attachmentOnly:false});
  for (const error of [new Error('connection reset'),{status:500,code:40005},{status:400,code:50035}]) {
    await assert.rejects(deliverCardWithSizeFallback(async () => {throw error;},options,fallback),
      actual => actual === error);
  }
  assert.equal(fallbacks,0);
});
