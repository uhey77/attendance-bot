// 時給はスクリプトプロパティ HOURLY_RATE で設定する（リポジトリには書かない）。
function payRate_() {
  const rate = Number(PropertiesService.getScriptProperties().getProperty('HOURLY_RATE'));
  if (!Number.isFinite(rate) || !(rate > 0)) throw new Error('HOURLY_RATE is not configured');
  return rate;
}
// Workerと同じ既定値。変更時は両方の設定をそろえてsetupPayrollを実行する。
function nightSettings_() {
  const props = PropertiesService.getScriptProperties();
  const startHour = Number(props.getProperty('NIGHT_START_HOUR') ?? 22);
  const endHour = Number(props.getProperty('NIGHT_END_HOUR') ?? 5);
  const multiplier = Number(props.getProperty('NIGHT_MULTIPLIER') ?? 1.25);
  if (![startHour,endHour].every(h => Number.isInteger(h) && h >= 0 && h < 24) ||
      startHour === endHour || !Number.isFinite(multiplier) || multiplier < 1) throw new Error('Invalid night payroll settings');
  return {startHour,endHour,multiplier};
}
function nightMinutes_(work, settings) {
  const hour = 3600000, day = 24 * hour, jst = 9 * hour;
  return work.reduce((total, [start,end]) => {
    let duration = 0;
    for (let midnight = Math.floor((start+jst)/day)*day-jst-day; midnight < end; midnight += day) {
      const from = midnight + settings.startHour*hour;
      const to = midnight + (settings.endHour + (settings.endHour < settings.startHour ? 24 : 0))*hour;
      duration += Math.max(0,Math.min(end,to)-Math.max(start,from));
    }
    return total+duration;
  },0)/60000;
}
function validateWork_(data) {
  if (!Array.isArray(data.work)) throw new Error('Invalid work intervals');
  if (data.row[1] === '') {
    if (data.work.length) throw new Error('Manual record has unknown times');
    return;
  }
  const start = Date.parse(data.row[1].replace(' ','T')+'+09:00');
  const end = Date.parse(data.row[2].replace(' ','T')+'+09:00');
  let previous = start, duration = 0;
  for (const pair of data.work) {
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(Number.isSafeInteger) ||
        pair[0] < previous || pair[1] < pair[0] || pair[1] >= end+1000) throw new Error('Invalid work intervals');
    previous = pair[1]; duration += pair[1]-pair[0];
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start ||
      Math.abs(duration/60000-data.row[4]) > 0.000001) throw new Error('Work duration mismatch');
}
function nightHeaders_(sheet) {
  sheet.getRange('G1:H1').setValues([['実働区間（JSON）','深夜実働（分）']]);
  sheet.getRange('H2:H').setNumberFormat('0.00');
  sheet.hideColumns(7,2);
}
const PAY_EXCLUDED = ['12147896323831.9593658818245.8577e9e1646c8b8c31a03017103e6e08','12158189900133.9593658818245.087f4707ac49748fec37ccb6bae3dfa7'];
function payrollFilter_() {
  return PAY_EXCLUDED.map(id => "'勤怠'!F2:F<>\"" + id + "\"").join(',');
}
function payrollMonth_(book, month) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Invalid month');
  nightSettings_();
  if (!book.getSheetByName('月別給与')) {
    const summary = book.insertSheet('月別給与');
    summary.getRange('A1:D1').setValues([['月','給与対象実働','時給（円）','合計給与（円）']]);
    summary.getRange('A2').setFormula('=IFNA(QUERY(FILTER({ARRAYFORMULA(TEXT(\'勤怠\'!A2:A,"yyyy-mm")),ARRAYFORMULA(\'勤怠\'!E2:E/1440)},\'勤怠\'!A2:A<>"",ISNUMBER(\'勤怠\'!E2:E),'+payrollFilter_()+'),"select Col1,sum(Col2) group by Col1 order by Col1 label sum(Col2) \'\'",0),"")');
    summary.getRange('C2').setFormula('=ARRAYFORMULA(IF(A2:A="","",'+payRate_()+'))');
    summary.getRange('D2').setFormula('=ARRAYFORMULA(IF(A2:A="","",ROUND(B2:B*24*C2:C,0)))');
    summary.getRange('B2:B').setNumberFormat('[h]:mm:ss');
    summary.getRange('C2:D').setNumberFormat('#,##0');
    summary.getRange('A1:D1').setBackground('#17365d').setFontColor('#ffffff').setFontWeight('bold');
    summary.setColumnWidths(1,4,160); summary.setFrozenRows(1);
  }
  const summary = book.getSheetByName('月別給与');
  summary.getRange('E1').setValue('深夜実働');
  summary.getRange('E2').setFormula(payrollNightFormula_());
  summary.getRange('D2').setFormula('=ARRAYFORMULA(IF(A2:A="","",ROUND((B2:B+E2:E*'+(nightSettings_().multiplier-1)+')*24*C2:C,0)))');
  summary.hideColumns(5);
  let sheet = book.getSheetByName(month);
  if (sheet && sheet.getRange('A1:D1').getValues()[0].join('|') === '日付|休憩合計|実働合計|給与（円）') {
    const oldFormula = sheet.getRange('D2').getFormula();
    const match = oldFormula.match(/C2:C\*24\*([0-9.]+)/) || oldFormula.match(/\*24\*([0-9.]+)\)\)$/);
    updateNightPay_(sheet,month,match ? Number(match[1]) : payRate_());
    return;
  }
  if (!sheet) sheet = book.insertSheet(month);
  const rate = payRate_();
  // Only rebuild this generated month view; source attendance is preserved.
  sheet.getRange('A:E').clear();
  sheet.getRange('A1:D1').setValues([['日付','休憩合計','実働合計','給与（円）']]);
  sheet.getRange('A2').setFormula('=IFNA(QUERY(FILTER({\'勤怠\'!A2:A,ARRAYFORMULA(N(\'勤怠\'!D2:D)/1440),ARRAYFORMULA(\'勤怠\'!E2:E/1440)},ARRAYFORMULA(TEXT(\'勤怠\'!A2:A,"yyyy-mm"))="'+month+'",ISNUMBER(\'勤怠\'!E2:E),'+payrollFilter_()+'),"select Col1,sum(Col2),sum(Col3) group by Col1 order by Col1 label sum(Col2) \'\',sum(Col3) \'\'",0),"")');
  sheet.getRange('D2').setFormula('=ARRAYFORMULA(IF(A2:A="","",C2:C*24*'+rate+'))');
  sheet.getRange('A2:A').setNumberFormat('yyyy/mm/dd');
  sheet.getRange('B2:C').setNumberFormat('[h]:mm:ss');
  sheet.getRange('D2:D').setNumberFormat('#,##0.00');
  sheet.getRange('A1:D1').setBackground('#17365d').setFontColor('#ffffff').setFontWeight('bold');
  sheet.setColumnWidths(1,4,160);sheet.setFrozenRows(1);
  sheet.getRange('D1').setNote('時給'+rate.toLocaleString('ja-JP')+'円。日別給与は小数第2位まで表示（計算値は丸めません）。月別給与では月合計の1円未満を四捨五入。動作確認2件は除外。');

  updateNightPay_(sheet,month,rate);
}
function payrollNightFormula_(month) {
  const date = month ? "'勤怠'!A2:A" : 'ARRAYFORMULA(TEXT(\'勤怠\'!A2:A,"yyyy-mm"))';
  const condition = month ? 'ARRAYFORMULA(TEXT(\'勤怠\'!A2:A,"yyyy-mm"))="'+month+'"' : "'勤怠'!A2:A<>\"\"";
  return '=IFNA(INDEX(QUERY(FILTER({'+date+',ARRAYFORMULA(N(\'勤怠\'!H2:H)/1440)},'+condition+',ISNUMBER(\'勤怠\'!E2:E),'+payrollFilter_()+'),"select Col1,sum(Col2) group by Col1 order by Col1 label sum(Col2) \'\'",0),0,2),"")';
}
function updateNightPay_(sheet,month,rate) {
  const night = nightSettings_();
  sheet.getRange('E1').setValue('深夜実働');
  sheet.getRange('E2').setFormula(payrollNightFormula_(month));
  sheet.getRange('D2').setFormula('=ARRAYFORMULA(IF(A2:A="","",(C2:C+E2:E*'+(night.multiplier-1)+')*24*'+rate+'))');
  sheet.hideColumns(5);
  sheet.getRange('D1').setNote('時給'+rate.toLocaleString('ja-JP')+'円。深夜'+night.startHour+':00〜'+night.endHour+':00は'+night.multiplier+'倍（休憩除外）。時刻不明の手動記録は通常時給。日別は小数第2位まで表示、月合計のみ1円未満を四捨五入。動作確認2件は除外。');
}
function setupPayroll() {
  const lock=LockService.getScriptLock();lock.waitLock(20000);
  try {
    const book=SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID'));
    const source=book.getSheetByName('勤怠');
    nightHeaders_(source);
    const count = source.getLastRow()-1;
    if (count > 0) {
      const work = source.getRange(2,7,count,1).getValues();
      const settings = nightSettings_();
      source.getRange(2,8,count,1).setValues(work.map(([json]) => [json ? nightMinutes_(JSON.parse(json),settings) : '']));
    }
    const months=new Set(source.getRange(2,1,Math.max(1,source.getLastRow()-1),1).getValues().flat().filter(Boolean).map(v=>v instanceof Date?Utilities.formatDate(v,'Asia/Tokyo','yyyy-MM'):String(v).slice(0,7).replaceAll('/','-')));
    for(const month of months) payrollMonth_(book,month);
    source.hideSheet();
    SpreadsheetApp.flush();
  } finally {lock.releaseLock();}
}
