import test from 'node:test';
import assert from 'node:assert/strict';
import { execute, initialState, summarize, periodStart, sheetRow, formatDuration } from '../src/attendance.js';

const at = value => Date.parse(value + '+09:00');
function session() {
  let state = initialState();
  let id = 0;
  return {
    run(command, time) {
      const response = execute(state, { command, now: at(time), requestId: String(++id) });
      state = response.state;
      return response;
    },
    get state() { return state; }
  };
}

test('手順書の例：日またぎ、30分休憩、実働3時間', () => {
  const s = session();
  s.run('/start', '2026-09-27T23:30:00');
  s.run('/break', '2026-09-28T01:00:00');
  s.run('/resume', '2026-09-28T01:30:00');
  assert.match(s.run('/end', '2026-09-28T03:00:00').text, /実働：3時間$/);
  assert.deepEqual(sheetRow(s.state.records[0]), ['2026/09/27', '2026-09-27 23:30:00', '2026-09-28 03:00:00', 30, 180]);
  const now = at('2026-09-28T03:00:00');
  assert.equal(summarize(s.state, '/week', now, 'completed-start-date'), 0);
  assert.equal(summarize(s.state, '/month', now), 180 * 60_000);
});

test('休憩中の終了は最後の休憩も除外する', () => {
  const s = session();
  s.run('/start', '2026-09-27T09:00:00');
  s.run('/break', '2026-09-27T10:00:00');
  s.run('/end', '2026-09-27T11:00:00');
  assert.deepEqual(sheetRow(s.state.records[0]).slice(3), [60, 60]);
});

test('不正な状態遷移と二重終了で記録を増やさない', () => {
  const s = session();
  for (const cmd of ['/break', '/resume', '/end']) s.run(cmd, '2026-09-27T09:00:00');
  assert.deepEqual(s.state, initialState());
  s.run('/start', '2026-09-27T09:00:00');
  const before = structuredClone(s.state);
  s.run('/start', '2026-09-27T09:01:00');
  assert.deepEqual(s.state, before);
  s.run('/end', '2026-09-27T10:00:00');
  s.run('/end', '2026-09-27T10:01:00');
  assert.equal(s.state.records.length, 1);
});

test('週はJST月曜始まり、月初・年境界を正しく扱う', () => {
  assert.equal(periodStart('/week', at('2026-09-27T23:59:59')), at('2026-09-21T00:00:00'));
  assert.equal(periodStart('/week', at('2026-09-28T00:00:00')), at('2026-09-28T00:00:00'));
  assert.equal(periodStart('/month', at('2027-01-01T00:00:00')), at('2027-01-01T00:00:00'));
});

test('作業中と休憩中の勤務は集計に含まない', () => {
  const s = session();
  s.run('/start', '2026-09-27T09:00:00');
  const now = at('2026-09-27T10:00:00');
  assert.equal(summarize(s.state, '/week', now, 'completed-start-date'), 0);
  assert.equal(summarize(s.state, '/week', now), 0);
  s.run('/break', '2026-09-27T09:30:00');
  assert.equal(summarize(s.state, '/week', now), 0);
});

test('複数勤務と短い休憩を丸めず合算する', () => {
  const s = session();
  s.run('/start', '2026-09-27T09:00:00');
  s.run('/break', '2026-09-27T09:00:40');
  s.run('/resume', '2026-09-27T09:01:00');
  s.run('/end', '2026-09-27T09:01:20');
  s.run('/start', '2026-09-27T10:00:00');
  s.run('/end', '2026-09-27T10:00:20');
  assert.equal(summarize(s.state, '/week', at('2026-09-27T11:00:00'), 'completed-start-date'), 80_000);
  assert.equal(formatDuration(80_000), '1分');
});

test('時刻の逆行を拒否し、元の状態を変更しない', () => {
  const s = session();
  s.run('/start', '2026-09-27T09:00:00');
  const before = structuredClone(s.state);
  assert.throws(() => s.run('/break', '2026-09-27T08:00:00'));
  assert.deepEqual(s.state, before);
  assert.equal(s.run('/today', '2026-09-27T10:00:00').text, '不明なコマンドです。');
});


test('時刻不明の手動記録は秒精度で開始日の週・月に集計する', () => {
  const record = { kind: 'manual', workDate: '2026-09-27', durationMs: 1246000, startedAt: null, endedAt: null };
  const state = { active: null, records: [record] };
  assert.equal(summarize(state, '/month', at('2026-09-28T01:00:00')), 1246000);
  assert.equal(summarize(state, '/week', at('2026-09-28T01:00:00')), 0);
  assert.equal(summarize(state, '/week', at('2026-09-27T23:59:59')), 1246000);
  assert.deepEqual(sheetRow(record), ['2026/09/27', '', '', '', 1246 / 60]);
});


test('月給は動作確認を除外し月合計を一度だけ四捨五入する', async () => {
  const { wages } = await import('../src/payroll.js');
  assert.equal(wages(1246000), 346);
  assert.equal(wages(1200), 1);
  const manual = { id: 'real', kind: 'manual', workDate: '2026-09-27', durationMs: 1246000 };
  const testRecord = { ...manual, id: '12147896323831.9593658818245.8577e9e1646c8b8c31a03017103e6e08' };
  const state = { active: null, records: [manual, testRecord] };
  const result = execute(state, { command: '/month', now: at('2026-09-28T01:00:00'), requestId: 'payroll' });
  assert.match(result.text, /2026年9月の給与対象実働/);
  assert.match(result.text, /20分46秒/);
  assert.match(result.text, /346円/);
  assert.equal(result.state.records.length, 2);
  const nextMonth = execute(state, { command: '/month', now: at('2026-10-01T00:00:00'), requestId: 'next' });
  assert.match(nextMonth.text, /2026年10月の給与対象実働/);
  assert.match(nextMonth.text, /合計給与：0円/);
});

test('月初の給与投稿は前月の開始日に属する終了済み勤務だけを集計する', async () => {
  const { previousMonthPayroll } = await import('../src/attendance.js');
  const s = session();
  s.run('/start', '2026-08-31T23:00:00'); s.run('/end', '2026-09-01T01:00:00'); // 8月扱い
  s.run('/start', '2026-09-30T23:30:00'); s.run('/end', '2026-10-01T00:30:00'); // 9月扱い：1時間
  s.run('/start', '2026-10-01T00:30:00'); s.run('/end', '2026-10-01T01:00:00'); // 10月扱い
  const records = [...s.state.records, { id: 'm', kind: 'manual', workDate: '2026-09-27', durationMs: 1246000 }];
  const report = previousMonthPayroll(records, at('2026-10-01T09:00:00'));
  assert.equal(report.key, '2026-09');
  assert.equal(report.duration, 3_600_000 + 1246000);
  assert.equal(report.text, '💴 2026年9月分の給与\n給与対象実働：1時間20分46秒\n時給：1,000円\n合計給与：1,346円');
  assert.equal(previousMonthPayroll([], at('2027-01-01T09:00:00')).key, '2026-12');
});
