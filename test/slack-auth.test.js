import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySlackRequest, authorizePayload } from '../src/slack-auth.js';

const signingSecret = 'test-secret-only';
const timestamp = '1790467200';
const rawBody = Buffer.from('user_id=U1&team_id=T1&command=%2Fstart&trigger_id=123');
const signature = 'v0=' + createHmac('sha256', signingSecret).update(`v0:${timestamp}:`).update(rawBody).digest('hex');
const request = { rawBody, signingSecret, timestamp, signature, now: Number(timestamp) * 1000 };

test('正規署名を受け入れ、本文・署名・時刻の偽装を拒否する', () => {
  assert.equal(verifySlackRequest(request), true);
  for (const change of [
    { rawBody: Buffer.from('user_id=U2') }, { signingSecret: 'wrong-secret' },
    { signature: 'v0=bad' }, { timestamp: 'invalid' },
    { now: request.now + 301_000 }, { now: request.now - 301_000 },
    { signingSecret: '' }
  ]) assert.equal(verifySlackRequest({ ...request, ...change }), false);
});

test('本人とワークスペースの両方を照合し、未設定時は拒否する', () => {
  const config = { allowedUserId: 'U1', allowedTeamId: 'T1' };
  assert.deepEqual(authorizePayload(rawBody, config), { command: '/start', requestId: '123' });
  assert.equal(authorizePayload(rawBody, { ...config, allowedUserId: 'U2' }), null);
  assert.equal(authorizePayload(rawBody, { ...config, allowedTeamId: 'T2' }), null);
  assert.equal(authorizePayload(Buffer.concat([rawBody, Buffer.from('&user_id=U2')]), config), null);
  assert.throws(() => authorizePayload(rawBody, {}));
});
