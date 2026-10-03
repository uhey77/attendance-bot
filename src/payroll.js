// 時給は環境変数 HOURLY_RATE で設定する（リポジトリには書かない）。
export function hourlyRate(env) {
  const rate = Number(env?.HOURLY_RATE);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('HOURLY_RATE is not configured');
  return rate;
}
export const PAYROLL_EXCLUDED_IDS = new Set([
  '12147896323831.9593658818245.8577e9e1646c8b8c31a03017103e6e08',
  '12158189900133.9593658818245.087f4707ac49748fec37ccb6bae3dfa7'
]);
export const wages = (milliseconds, rate) => Math.round(milliseconds * rate / 3600000);

// 時間帯は日本時間。倍率1で割増なし。未設定時は22時〜翌5時・1.25倍。
export function nightSettings(env = {}) {
  const startHour = Number(env.NIGHT_START_HOUR ?? 22);
  const endHour = Number(env.NIGHT_END_HOUR ?? 5);
  const multiplier = Number(env.NIGHT_MULTIPLIER ?? 1.25);
  if (![startHour, endHour].every(h => Number.isInteger(h) && h >= 0 && h < 24) ||
      startHour === endHour || !Number.isFinite(multiplier) || multiplier < 1) {
    throw new Error('Invalid night payroll settings');
  }
  return { startHour, endHour, multiplier };
}

export function nightMilliseconds(work, { startHour, endHour } = nightSettings()) {
  const hour = 3_600_000, day = 24 * hour, jst = 9 * hour;
  return work.reduce((total, [start, end]) => {
    let duration = 0;
    // 前日の窓も調べ、午前0時〜終了時刻の勤務を含める。
    for (let midnight = Math.floor((start + jst) / day) * day - jst - day; midnight < end; midnight += day) {
      const from = midnight + startHour * hour;
      const to = midnight + (endHour + (endHour < startHour ? 24 : 0)) * hour;
      duration += Math.max(0, Math.min(end, to) - Math.max(start, from));
    }
    return total + duration;
  }, 0);
}

export function payrollTotals(records, rate, settings = nightSettings()) {
  let duration = 0, nightDuration = 0;
  for (const record of records) {
    if (PAYROLL_EXCLUDED_IDS.has(record.id)) continue;
    duration += record.kind === 'manual' ? record.durationMs : record.work.reduce((sum, [a, b]) => sum + b - a, 0);
    if (record.kind !== 'manual') nightDuration += nightMilliseconds(record.work, settings);
  }
  return { duration, nightDuration, amount: wages(duration + nightDuration * (settings.multiplier - 1), rate) };
}

export function nightDescription(nightDuration, settings) {
  if (settings.multiplier === 1) return '';
  return `\n深夜実働（${settings.startHour}:00〜${settings.endHour}:00・${settings.multiplier}倍）：${exactDuration(nightDuration)}`;
}
export function exactDuration(milliseconds) {
  const total = Math.floor(milliseconds / 1000);
  const h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
  return `${h ? h + '時間' : ''}${m}分${s}秒`;
}
