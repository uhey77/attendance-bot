// 時給はスクリプトプロパティ HOURLY_RATE で設定する（リポジトリには書かない）。
function payRate_() {
  const rate = Number(PropertiesService.getScriptProperties().getProperty('HOURLY_RATE'));
  if (!(rate > 0)) throw new Error('HOURLY_RATE is not configured');
  return rate;
}
const PAY_EXCLUDED = ['12147896323831.9593658818245.8577e9e1646c8b8c31a03017103e6e08','12158189900133.9593658818245.087f4707ac49748fec37ccb6bae3dfa7'];
function payrollFilter_() {
  return PAY_EXCLUDED.map(id => "'勤怠'!F2:F<>\"" + id + "\"").join(',');
}
function payrollMonth_(book, month) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Invalid month');
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
  let sheet = book.getSheetByName(month);
  if (sheet && sheet.getRange('A1:D1').getValues()[0].join('|') === '日付|休憩合計|実働合計|給与（円）') return;
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

}
function setupPayroll() {
  const lock=LockService.getScriptLock();lock.waitLock(20000);
  try {
    const book=SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID'));
    const source=book.getSheetByName('勤怠');
    const months=new Set(source.getRange(2,1,Math.max(1,source.getLastRow()-1),1).getValues().flat().filter(Boolean).map(v=>v instanceof Date?Utilities.formatDate(v,'Asia/Tokyo','yyyy-MM'):String(v).slice(0,7).replaceAll('/','-')));
    for(const month of months) payrollMonth_(book,month);
    source.hideSheet();
    SpreadsheetApp.flush();
  } finally {lock.releaseLock();}
}
