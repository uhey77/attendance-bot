import { createHmac, timingSafeEqual } from 'node:crypto';

// Verify the exact, unparsed request body before trusting any payload field.
export function verifySlackRequest({ rawBody, timestamp, signature, signingSecret, now = Date.now() }) {
  if (!signingSecret || !Buffer.isBuffer(rawBody) || typeof timestamp !== 'string' ||
      !/^\d+$/.test(timestamp) || typeof signature !== 'string' || !/^v0=[a-f0-9]{64}$/.test(signature)) return false;
  if (!Number.isFinite(now) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = 'v0=' + createHmac('sha256', signingSecret)
    .update(`v0:${timestamp}:`).update(rawBody).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function authorizePayload(rawBody, { allowedUserId, allowedTeamId }) {
  if (!allowedUserId || !allowedTeamId) throw new Error('Allowed user and workspace must be configured');
  const params = new URLSearchParams(rawBody.toString('utf8'));
  // Reject ambiguous duplicate fields instead of depending on parser behavior.
  for (const field of ['user_id', 'team_id', 'command', 'trigger_id']) {
    if (params.getAll(field).length !== 1 || !params.get(field)) return null;
  }
  if (params.get('user_id') !== allowedUserId || params.get('team_id') !== allowedTeamId) return null;
  return { command: params.get('command'), requestId: params.get('trigger_id') };
}
