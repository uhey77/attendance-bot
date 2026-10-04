import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';
import { COMMANDS, execute, previousMonthPayroll, sheetRow } from './attendance.js';
import { verifySlackRequest, authorizePayload } from './slack-auth.js';
import { hourlyRate, nightSettings } from './payroll.js';

const json = (text, status = 200) => Response.json({ response_type: 'ephemeral', text }, { status });

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return Response.json({ ok: true });
    if (path !== '/slack/commands' || request.method !== 'POST') return new Response('Not found', { status: 404 });
    if (!env.SLACK_SIGNING_SECRET || !env.ALLOWED_USER_ID || !env.ALLOWED_TEAM_ID ||
        !env.GAS_URL || !env.GAS_SHARED_SECRET || !env.SLACK_BOT_TOKEN || !env.POST_CHANNEL_ID || !env.MENTION_USER_ID || !env.HOURLY_RATE) return json('接続設定が完了していません。', 503);
    if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return new Response(null, { status: 415 });
    // Stream with a hard cap, including when Content-Length is absent.
    const reader = request.body?.getReader();
    if (!reader) return new Response(null, { status: 400 });
    const chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) { await reader.cancel(); return new Response(null, { status: 413 }); }
      chunks.push(Buffer.from(value));
    }
    const rawBody = Buffer.concat(chunks);
    if (!verifySlackRequest({ rawBody, timestamp: request.headers.get('x-slack-request-timestamp'),
      signature: request.headers.get('x-slack-signature'), signingSecret: env.SLACK_SIGNING_SECRET })) {
      return new Response('Unauthorized', { status: 401 });
    }
    const input = authorizePayload(rawBody, { allowedUserId: env.ALLOWED_USER_ID, allowedTeamId: env.ALLOWED_TEAM_ID });
    if (!input) return json('このコマンドは利用できません。');
    if (!COMMANDS.includes(input.command)) return json('不明なコマンドです。');
    try {
      const id = env.ATTENDANCE.idFromName(`${env.ALLOWED_TEAM_ID}:${env.ALLOWED_USER_ID}`);
      return await env.ATTENDANCE.get(id).fetch(new Request('https://internal/command', {
        method: 'POST', body: JSON.stringify(input)
      }));
    } catch {
      // Never log signed payloads or credentials.
      console.error('Attendance persistence failed');
      return json('処理結果を確認できませんでした。同じ操作を再実行する前に状態をご確認ください。', 503);
    }
  },

  // 毎月1日に前月分の給与をメンション付きで投稿する（Cron Trigger）。
  async scheduled(controller, env) {
    if (!env.ALLOWED_USER_ID || !env.ALLOWED_TEAM_ID || !env.HOURLY_RATE) throw new Error('Missing attendance config');
    const id = env.ATTENDANCE.idFromName(`${env.ALLOWED_TEAM_ID}:${env.ALLOWED_USER_ID}`);
    const response = await env.ATTENDANCE.get(id).fetch(new Request('https://internal/monthly-payroll', {
      method: 'POST', body: JSON.stringify({ now: controller.scheduledTime })
    }));
    if (!response.ok) throw new Error('Monthly payroll enqueue failed');
  }
};

// Legacy fetch-style Durable Object interface works without platform imports,
// allowing the storage protocol to be tested with a deterministic adapter.
export class AttendanceStore {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async fetch(request) {
    if (new URL(request.url).pathname === '/monthly-payroll') return this.enqueueMonthlyPayroll(await request.json());
    const input = await request.json();
    return this.ctx.blockConcurrencyWhile(async () => {
      const storage = this.ctx.storage;
      const now = Date.now();
      const text = await storage.transaction(async tx => {
        const cached = await tx.get(`request:${input.requestId}`);
        if (cached) return cached.text;
        await this.enqueueNightBackfill(tx);
        const active = await tx.get('active') || null;
        const reporting = ['/week', '/month'].includes(input.command);
        const records = reporting ? [...(await tx.list({ prefix: 'record:' })).values()] : [];
        const result = execute({ active, records }, { ...input, now }, { hourlyRate: hourlyRate(this.env), night: nightSettings(this.env) });
        const changed = JSON.stringify(active) !== JSON.stringify(result.state.active);
        if (changed) {
          const sequence = (await tx.get('postSequence') || 0) + 1;
          await tx.put('postSequence', sequence);
          await tx.put(`slack:${String(sequence).padStart(12, '0')}`, {
            sessionId: active?.id || result.state.active.id,
            command: input.command, text: result.text, clientId: randomUUID(), status: 'pending'
          });
          if (!(await tx.getAlarm())) await tx.setAlarm(now + 1000);
        }
        await tx.put('active', result.state.active);
        if (input.command === '/end' && active) {
          const record = result.state.records.at(-1);
          await tx.put(`record:${record.id}`, record);
          await tx.put(`outbox:${record.id}`, record);
          // Alarm and record are committed atomically; a crash cannot lose sync.
          if (!(await tx.getAlarm())) await tx.setAlarm(now + 1000);
          result.text += '\n記録を保存しました。Google Sheetsへ順次反映します。';
        }
        const pending = await tx.list({ prefix: 'outbox:', limit: 1 });
        if (reporting && pending.size) result.text += '\nGoogle Sheetsへの反映待ちがあります（集計には保存済みの終了分を含みます）。';
        if ((await tx.list({ prefix: 'slack:', limit: 1 })).size) result.text += '\n勤怠スレッドへの投稿待ちがあります。';
        await tx.put(`request:${input.requestId}`, { text: result.text, expires: now + 600_000 });
        // Keep request deduplication bounded; Slack signatures expire in 5 minutes.
        for (const [key, value] of await tx.list({ prefix: 'request:' })) {
          if (value.expires < now) await tx.delete(key);
        }
        return result.text;
      });
      return json(text);
    });
  }

  async enqueueMonthlyPayroll({ now }) {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.transaction(async tx => {
        await this.enqueueNightBackfill(tx);
        const records = [...(await tx.list({ prefix: 'record:' })).values()];
        const report = previousMonthPayroll(records, now, hourlyRate(this.env), nightSettings(this.env));
        // Cronの重複起動でも同じ月の投稿は一度だけにする。
        if (await tx.get(`payrollReport:${report.key}`)) return;
        await tx.put(`payrollReport:${report.key}`, true);
        const sequence = (await tx.get('postSequence') || 0) + 1;
        await tx.put('postSequence', sequence);
        await tx.put(`slack:${String(sequence).padStart(12, '0')}`, {
          command: 'payroll', text: report.text, clientId: randomUUID(), status: 'pending'
        });
        if (!(await tx.getAlarm())) await tx.setAlarm(Date.now() + 1000);
      });
      return Response.json({ ok: true });
    });
  }

  async enqueueNightBackfill(tx) {
    // 初回コマンド/Cronで過去の実働区間を再転記。勤務やSlack投稿は増やさない。
    if (await tx.get('nightBackfill:v1')) return;
    for (const record of (await tx.list({ prefix: 'record:' })).values()) {
      await tx.put(`outbox:${record.id}`, record);
    }
    await tx.put('nightBackfill:v1', true);
    if ((await tx.list({ prefix: 'outbox:', limit: 1 })).size && !(await tx.getAlarm())) {
      await tx.setAlarm(Date.now() + 1000);
    }
  }

  async alarm() {
    const storage = this.ctx.storage;
    // Schedule recovery before doing network work, including process termination.
    await storage.setAlarm(Date.now() + 60_000);
    const pending = await storage.list({ prefix: 'outbox:', limit: 10 });
    let failed = false;
    for (const [key, record] of pending) {
      try {
        const payload = JSON.stringify({ id: record.id, row: sheetRow(record), work: record.kind === 'manual' ? [] : record.work });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = createHmac('sha256', this.env.GAS_SHARED_SECRET)
          .update(`${timestamp}.${payload}`).digest('hex');
        const url = new URL(this.env.GAS_URL);
        if (url.protocol !== 'https:' || url.hostname !== 'script.google.com' || !url.pathname.endsWith('/exec')) throw new Error('Invalid GAS URL');
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ timestamp, payload, signature }), signal: AbortSignal.timeout(15_000) });
        if (!response.ok || (await response.json()).ok !== true) throw new Error('Sync rejected');
        await storage.delete(key);
      } catch {
        failed = true;
        console.error('Sheets sync failed; saved record retained for retry');
        break;
      }
    }
    // Publish in sequence so replies never precede the root post.
    const posts = await storage.list({ prefix: 'slack:', limit: 10 });
    for (const [key, event] of posts) {
      if (event.status === 'uncertain') { failed = true; break; }
      try {
        // 給与の月次投稿は勤務スレッドに属さない独立した親投稿にする。
        const standalone = event.command === 'payroll';
        const thread = standalone ? null : await storage.get(`thread:${event.sessionId}`);
        if (!standalone && event.command !== '/start' && !thread) throw new Error('Missing thread');
        if (!this.env.SLACK_BOT_TOKEN || !/^[CG][A-Z0-9]+$/.test(this.env.POST_CHANNEL_ID || '') ||
            !/^[UW][A-Z0-9]+$/.test(this.env.MENTION_USER_ID || '')) throw new Error('Missing Slack config');
        // An ambiguous network failure must not produce duplicate mentions on retry.
        await storage.put(key, { ...event, status: 'uncertain' });
        const response = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST', headers: { authorization: `Bearer ${this.env.SLACK_BOT_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ channel: this.env.POST_CHANNEL_ID,
            text: event.command === '/start' || standalone ? `<@${this.env.MENTION_USER_ID}>\n${event.text}` : event.text,
            ...(thread ? { thread_ts: thread } : {}), client_msg_id: event.clientId,
            unfurl_links: false, unfurl_media: false, reply_broadcast: false }),
          signal: AbortSignal.timeout(10_000)
        });
        if (response.status === 429) {
          await storage.put(key, event); failed = true; break;
        }
        const data = await response.json();
        if (!data.ok) {
          await storage.put(key, event); throw new Error('Slack rejected');
        }
        if (!response.ok || typeof data.ts !== 'string') throw new Error('Ambiguous Slack result');
        await storage.transaction(async tx => {
          if (event.command === '/start') await tx.put(`thread:${event.sessionId}`, data.ts);
          await tx.delete(key);
        });
        // Respect Slack's per-channel message rate. Next event gets its own alarm.
        break;
      } catch {
        failed = true;
        console.error('Slack post pending; ambiguous deliveries require inspection before retry');
        break;
      }
    }
    // Coordinate with incoming /end so we never clear its newly scheduled alarm.
    await this.ctx.blockConcurrencyWhile(async () => {
      if ((await storage.list({ prefix: 'outbox:', limit: 1 })).size || (await storage.list({ prefix: 'slack:', limit: 1 })).size) {
        const attempts = failed ? (await storage.get('syncFailures') || 0) + 1 : 0;
        await storage.put('syncFailures', attempts);
        await storage.setAlarm(Date.now() + (failed ? Math.min(3_600_000, 30_000 * 2 ** Math.min(attempts, 7)) : 1000));
      } else {
        await storage.delete('syncFailures');
        await storage.deleteAlarm();
      }
    });
  }
}
