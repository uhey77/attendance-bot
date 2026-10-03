import { payrollTotals, nightSettings, nightDescription, exactDuration } from './payroll.js';
// Pure attendance logic. The adapter must serialize commands and persist the
// returned state before acknowledging success. All timestamps are epoch ms.
export const COMMANDS = ['/start', '/break', '/resume', '/end', '/week', '/month'];
const MINUTE = 60_000;
const DAY = 86_400_000;
const JST = 9 * 60 * MINUTE;

export function initialState() {
  return { active: null, records: [] };
}

export function formatDuration(milliseconds) {
  const minutes = Math.round(milliseconds / MINUTE);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours}時間${rest ? `${rest}分` : ''}` : `${rest}分`;
}

function clock(now) {
  return new Date(now + JST).toISOString().slice(11, 16);
}

export function periodStart(command, now) {
  const date = new Date(now + JST);
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - JST;
  if (command === '/week') return midnight - ((date.getUTCDay() + 6) % 7) * DAY;
  if (command === '/month') return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) - JST;
  throw new Error('Unknown reporting period');
}

export function workMilliseconds(record) {
  if (record.kind === 'manual') return record.durationMs;
  return record.work.reduce((sum, [start, end]) => sum + end - start, 0);
}

export function summarize(state, command, now) {
  const start = periodStart(command, now);
  return state.records.reduce((sum, record) => sum + (
    (record.kind === 'manual' ? Date.parse(record.workDate + 'T00:00:00+09:00') : record.startedAt) >= start &&
    (record.kind === 'manual' ? Date.parse(record.workDate + 'T00:00:00+09:00') : record.startedAt) <= now ? workMilliseconds(record) : 0
  ), 0);
}

export function execute(state, { command, now, requestId }, { hourlyRate, night = nightSettings() } = {}) {
  if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())) throw new Error('Invalid timestamp');
  if (typeof requestId !== 'string' || !requestId) throw new Error('A request ID is required');
  const result = structuredClone(state);
  const active = result.active;
  if (active && now < active.since) throw new Error('Timestamp precedes the last transition');
  const reply = text => ({ state: result, text });
  switch (command) {
    case '/start':
      if (active?.status === 'working') return reply('すでに作業中です。');
      if (active) return reply('現在休憩中です。/resume を使用してください。');
      result.active = { id: requestId, startedAt: now, since: now, status: 'working', work: [] };
      return reply(`🟢 ${clock(now)} 作業を開始しました`);
    case '/break':
      if (!active) return reply('作業が開始されていません。');
      if (active.status === 'break') return reply('すでに休憩中です。');
      active.work.push([active.since, now]);
      active.since = now;
      active.status = 'break';
      return reply(`☕ ${clock(now)} 休憩を開始しました`);
    case '/resume':
      if (active?.status !== 'break') return reply('現在休憩中ではありません。');
      active.status = 'working';
      active.since = now;
      return reply(`🟢 ${clock(now)} 作業を再開しました`);
    case '/end': {
      if (!active) return reply('作業が開始されていません。');
      if (active.status === 'working') active.work.push([active.since, now]);
      const record = { id: active.id, startedAt: active.startedAt, endedAt: now, work: active.work };
      result.records.push(record);
      result.active = null;
      return reply(`🔴 ${clock(now)} 作業を終了しました\n実働：${formatDuration(workMilliseconds(record))}`);
    }
    case '/week':
    case '/month': {
      const label = { '/week': '今週', '/month': '今月' }[command];
      if (command === '/month') {
        const start = periodStart(command, now);
        const eligible = result.records.filter(r => {
          const date = r.kind === 'manual' ? Date.parse(r.workDate + 'T00:00:00+09:00') : r.startedAt;
          return date >= start && date <= now;
        });
        const { duration, nightDuration, amount } = payrollTotals(eligible, hourlyRate, night);
        const date = new Date(now + JST);
        const month = `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月`;
        return reply(`📊 ${month}の給与対象実働：${exactDuration(duration)}${nightDescription(nightDuration, night)}\n時給：${hourlyRate.toLocaleString('ja-JP')}円\n今月の合計給与：${amount.toLocaleString('ja-JP')}円`);
      }
      return reply(`📊 ${label}の実働：${formatDuration(summarize(result, command, now))}`);
    }
    default: return reply('不明なコマンドです。');
  }
}

export function sheetRow(record) {
  if (record.kind === 'manual') return [record.workDate.replaceAll('-', '/'), '', '', '', record.durationMs / MINUTE];
  const local = time => new Date(time + JST).toISOString().replace('T', ' ').slice(0, 19);
  const work = workMilliseconds(record);
  return [local(record.startedAt).slice(0, 10).replaceAll('-', '/'), local(record.startedAt),
    local(record.endedAt), (record.endedAt - record.startedAt - work) / MINUTE, work / MINUTE];
}

// 月初の定期投稿用：前月（日本時間）の開始日に属する終了済み勤務の給与を集計する。
export function previousMonthPayroll(records, now, hourlyRate, night = nightSettings()) {
  const date = new Date(now + JST);
  const year = date.getUTCFullYear(), month = date.getUTCMonth();
  const start = Date.UTC(year, month - 1, 1) - JST;
  const end = Date.UTC(year, month, 1) - JST;
  const eligible = records.filter(record => {
    const startedAt = record.kind === 'manual' ? Date.parse(record.workDate + 'T00:00:00+09:00') : record.startedAt;
    return startedAt >= start && startedAt < end;
  });
  const { duration, nightDuration, amount } = payrollTotals(eligible, hourlyRate, night);
  const target = new Date(start + JST);
  const key = `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}`;
  const label = `${target.getUTCFullYear()}年${target.getUTCMonth() + 1}月`;
  return { key, duration, nightDuration, amount, text: `💴 ${label}分の給与\n給与対象実働：${exactDuration(duration)}${nightDescription(nightDuration, night)}\n時給：${hourlyRate.toLocaleString('ja-JP')}円\n合計給与：${amount.toLocaleString('ja-JP')}円` };
}
