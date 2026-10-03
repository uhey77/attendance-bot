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
export function exactDuration(milliseconds) {
  const total = Math.floor(milliseconds / 1000);
  const h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
  return `${h ? h + '時間' : ''}${m}分${s}秒`;
}
