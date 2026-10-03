const HEADERS = ['日付', '開始日時', '終了日時', '休憩時間（分）', '実働時間（分）', '記録ID'];

// Run once from the editor. Existing sheet contents are never overwritten.
function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('GAS_SHARED_SECRET')) props.setProperty('GAS_SHARED_SECRET', Utilities.getUuid() + Utilities.getUuid());
  let id = props.getProperty('SPREADSHEET_ID');
  const book = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.create('Slack勤怠Bot');
  if (!id) props.setProperty('SPREADSHEET_ID', book.getId());
  book.setSpreadsheetTimeZone('Asia/Tokyo');
  let sheet = book.getSheetByName('勤怠');
  if (!sheet) sheet = book.insertSheet('勤怠');
  if (!sheet.getLastRow()) sheet.appendRow(HEADERS);
  checkHeaders_(sheet);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, 6).setBackground('#17365d').setFontColor('#ffffff').setFontWeight('bold');
  sheet.getRange('D:E').setNumberFormat('0.00');
  sheet.setColumnWidths(1, 1, 110);
  sheet.setColumnWidths(2, 2, 170);
  sheet.setColumnWidths(4, 2, 130);
  sheet.hideColumns(6);
  console.log(book.getUrl());
}

function checkHeaders_(sheet) {
  if (JSON.stringify(sheet.getRange(1, 1, 1, 6).getValues()[0]) !== JSON.stringify(HEADERS)) {
    throw new Error('Unexpected headers');
  }
}

function doPost(e) {
  try {
    const props = PropertiesService.getScriptProperties();
    const secret = props.getProperty('GAS_SHARED_SECRET');
    const id = props.getProperty('SPREADSHEET_ID');
    if (!secret || !id) throw new Error('Missing configuration');
    const envelope = JSON.parse(e.postData.contents);
    if (typeof envelope.timestamp !== 'string' || !/^\d+$/.test(envelope.timestamp) ||
        Math.abs(Date.now() / 1000 - Number(envelope.timestamp)) > 300 ||
        typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') throw new Error('Invalid envelope');
    const expected = Utilities.computeHmacSha256Signature(envelope.timestamp + '.' + envelope.payload, secret)
      .map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
    if (expected.length !== envelope.signature.length) throw new Error('Invalid signature');
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ envelope.signature.charCodeAt(i);
    if (diff) throw new Error('Invalid signature');
    const data = JSON.parse(envelope.payload);
    if (typeof data.id !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(data.id) ||
        !Array.isArray(data.row) || data.row.length !== 5 ||
        !/^\d{4}\/\d{2}\/\d{2}$/.test(data.row[0]) ||
        !(data.row.slice(1, 3).every(v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) ||
          (data.row[1] === '' && data.row[2] === '' && data.row[3] === '')) ||
        !data.row.slice(3).every((v, i) => (i === 0 && v === '' && data.row[1] === '') ||
          (typeof v === 'number' && Number.isFinite(v) && v >= 0))) throw new Error('Invalid record');
    if (data.work !== undefined) validateWork_(data);
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) throw new Error('Busy');
    try {
      const sheet = SpreadsheetApp.openById(id).getSheetByName('勤怠');
      checkHeaders_(sheet);
      const last = sheet.getLastRow();
      const exists = last > 1 && sheet.getRange(2, 6, last - 1, 1).createTextFinder(data.id).matchEntireCell(true).useRegularExpression(false).findNext();
      if (!exists) {
        sheet.appendRow([...data.row, data.id]);
        SpreadsheetApp.flush();
      }
      if (data.work !== undefined) {
        nightHeaders_(sheet);
        const row = exists ? exists.getRow() : sheet.getLastRow();
        sheet.getRange(row, 7, 1, 2).setValues([[JSON.stringify(data.work), nightMinutes_(data.work, nightSettings_())]]);
      }
      payrollMonth_(SpreadsheetApp.openById(id), data.row[0].slice(0, 7).replaceAll('/', '-'));
      SpreadsheetApp.flush();
    } finally { lock.releaseLock(); }
    return response_({ ok: true });
  } catch {
    // Do not expose secret values or request contents to logs or callers.
    return response_({ ok: false });
  }
}

function response_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
