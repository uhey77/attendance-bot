import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {createHmac} from 'node:crypto';

test('Google側：署名不正・期限切れを拒否し、再送で行を増やさない',()=>{
 const rows=[['日付','開始日時','終了日時','休憩時間（分）','実働時間（分）','記録ID']];
 const sheet={getLastRow:()=>rows.length,appendRow:r=>rows.push(r),getRange:(r,c)=>({getValues:()=>[rows[0]],createTextFinder:id=>({matchEntireCell(){return this;},useRegularExpression(){return this;},findNext:()=>rows.some(row=>row[5]===id)})})};
 const context=vm.createContext({console,Date,PropertiesService:{getScriptProperties:()=>({getProperty:k=>({GAS_SHARED_SECRET:'secret',SPREADSHEET_ID:'sheet'})[k]})},Utilities:{computeHmacSha256Signature:(body,secret)=>[...createHmac('sha256',secret).update(body).digest()]},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},SpreadsheetApp:{openById:()=>({getSheetByName:()=>sheet}),flush(){}},ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({setMimeType:()=>JSON.parse(text)})}});
 vm.runInContext(fs.readFileSync(new URL('../gas/Code.gs',import.meta.url),'utf8'),context);
 context.payrollMonth_=()=>{}; // Payroll rendering is verified on the live sheet.
 const payload=JSON.stringify({id:'session-1',row:['2026/09/27','2026-09-27 23:00:00','2026-09-28 01:00:00',0,120]});
 const timestamp=String(Math.floor(Date.now()/1000));
 const signature=createHmac('sha256','secret').update(`${timestamp}.${payload}`).digest('hex');
 const call=env=>context.doPost({postData:{contents:JSON.stringify(env)}});
 assert.equal(call({timestamp,payload,signature:'bad'}).ok,false);assert.equal(rows.length,1);
 assert.equal(call({timestamp:String(Number(timestamp)-301),payload,signature}).ok,false);
 assert.equal(call({timestamp,payload,signature}).ok,true);assert.equal(rows.length,2);
 assert.equal(call({timestamp,payload,signature}).ok,true);assert.equal(rows.length,2);
});
