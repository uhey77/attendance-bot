import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { nightSettings, nightMilliseconds, payrollTotals } from '../src/payroll.js';
import { execute, previousMonthPayroll } from '../src/attendance.js';

const at = s => Date.parse(s + '+09:00');
const interval = (a,b) => [at(a),at(b)];
const record = work => ({id:'real',startedAt:work[0][0],endedAt:work.at(-1)[1],work});

test('22時と5時の境界・日またぎ・深夜休憩・複数日を秒精度で計算する', () => {
  const cases = [
    [interval('2026-09-30T21:00:00','2026-09-30T22:00:00'),0],
    [interval('2026-09-30T22:00:00','2026-10-01T05:00:00'),7*3600000],
    [interval('2026-10-01T05:00:00','2026-10-01T06:00:00'),0],
    [interval('2026-10-01T00:00:00','2026-10-01T06:00:00'),5*3600000],
    [interval('2026-09-30T21:59:59','2026-09-30T22:00:01'),1000],
    [interval('2026-09-30T04:59:59','2026-09-30T05:00:01'),1000],
    [interval('2026-09-30T21:00:00','2026-10-02T06:00:00'),14*3600000]
  ];
  const gas = vm.createContext({PropertiesService:{getScriptProperties:()=>({getProperty:()=>null})}});
  vm.runInContext(fs.readFileSync(new URL('../gas/Payroll.gs',import.meta.url),'utf8'),gas);
  for (const [pair, expected] of cases) {
    assert.equal(nightMilliseconds([pair]),expected);
    assert.equal(gas.nightMinutes_([pair],gas.nightSettings_())*60000,expected);
  }
  const work = [interval('2026-09-30T21:00:00','2026-10-01T00:00:00'),interval('2026-10-01T01:00:00','2026-10-01T06:00:00')];
  assert.equal(nightMilliseconds(work),6*3600000);
  assert.deepEqual(payrollTotals([record(work)],1000),{duration:8*3600000,nightDuration:6*3600000,amount:9500});
  assert.equal(gas.nightMinutes_(work,gas.nightSettings_()),360);
});

test('深夜帯と倍率を変更でき、不正値は拒否する', () => {
  const work = [interval('2026-09-30T07:00:00','2026-09-30T18:00:00')];
  const settings = nightSettings({NIGHT_START_HOUR:'9',NIGHT_END_HOUR:'17',NIGHT_MULTIPLIER:'1.5'});
  assert.equal(nightMilliseconds(work,settings),8*3600000);
  assert.equal(payrollTotals([record(work)],1000,settings).amount,15000);
  assert.equal(payrollTotals([record(work)],1000,nightSettings({NIGHT_MULTIPLIER:'1'})).amount,11000);
  for (const env of [{NIGHT_START_HOUR:24},{NIGHT_END_HOUR:22},{NIGHT_START_HOUR:1.5},{NIGHT_MULTIPLIER:0.5},{NIGHT_MULTIPLIER:'bad'}]) assert.throws(()=>nightSettings(env));
});

test('月末の勤務は開始月に割増を含めて計上し月次コマンドと定期投稿が一致する', () => {
  const r = record([interval('2026-09-30T21:00:00','2026-10-01T06:00:00')]);
  const completed = record([interval('2026-09-29T21:00:00','2026-09-30T06:00:00')]);
  const now = at('2026-09-30T09:00:00');
  const result = execute({active:null,records:[completed]}, {command:'/month',now,requestId:'m'}, {hourlyRate:1000});
  assert.match(result.text,/深夜実働.*7時間0分0秒/);
  assert.match(result.text,/今月の合計給与：10,750円/);
  assert.equal(previousMonthPayroll([r],at('2026-10-01T09:00:00'),1000).amount,10750);
});

test('秒単位の割増を勤務ごとには丸めない', () => {
  const a = record([interval('2026-09-30T22:00:00','2026-09-30T22:00:01')]);
  const b = record([interval('2026-09-30T23:00:00','2026-09-30T23:00:01')]);
  assert.equal(payrollTotals([a,b],1000).amount,1);
});
