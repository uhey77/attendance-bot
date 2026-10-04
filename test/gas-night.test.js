import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {createHmac} from 'node:crypto';

function fixture() {
 const rows=[['日付','開始日時','終了日時','休憩時間（分）','実働時間（分）','記録ID']];
 const sheet={getLastRow:()=>rows.length,appendRow:r=>rows.push([...r]),hideColumns(){},getRange:(r,c)=>({
  getValues:()=>[rows[0]],setValues(v){if(typeof r==='number')rows[r-1].splice(c-1,v[0].length,...v[0]);return this;},setNumberFormat(){return this;},
  createTextFinder:id=>({matchEntireCell(){return this;},useRegularExpression(){return this;},findNext(){const index=rows.findIndex(row=>row[5]===id);return index<0?null:{getRow:()=>index+1};}})
 })};
 const context=vm.createContext({console,Date,PropertiesService:{getScriptProperties:()=>({getProperty:k=>({GAS_SHARED_SECRET:'secret',SPREADSHEET_ID:'sheet',HOURLY_RATE:'1000'})[k]??null})},Utilities:{computeHmacSha256Signature:(body,secret)=>[...createHmac('sha256',secret).update(body).digest()]},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},SpreadsheetApp:{openById:()=>({getSheetByName:()=>sheet}),flush(){}},ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({setMimeType:()=>JSON.parse(text)})}});
 for(const file of ['Payroll.gs','Code.gs']) vm.runInContext(fs.readFileSync(new URL('../gas/'+file,import.meta.url),'utf8'),context);
 context.payrollMonth_=()=>{};
 const call=data=>{
  const payload=JSON.stringify(data),timestamp=String(Math.floor(Date.now()/1000));
  const signature=createHmac('sha256','secret').update(`${timestamp}.${payload}`).digest('hex');
  return context.doPost({postData:{contents:JSON.stringify({timestamp,payload,signature})}});
 };
 return {rows,call};
}
const at=s=>Date.parse(s+'+09:00');
const data={id:'old',row:['2026/09/30','2026-09-30 21:00:00','2026-10-01 06:00:00',60,480],work:[[at('2026-09-30T21:00:00'),at('2026-10-01T00:00:00')],[at('2026-10-01T01:00:00'),at('2026-10-01T06:00:00')]]};

test('GASは既存行へ実働区間と深夜時間だけを追記し、再送でも重複しない',()=>{
 const f=fixture();
 const legacy={...data};delete legacy.work;
 assert.equal(f.call(legacy).ok,true);
 const original=f.rows[1].slice();
 assert.equal(f.call(data).ok,true);
 assert.deepEqual(f.rows[1].slice(0,6),original);
 assert.equal(f.rows[1][6],JSON.stringify(data.work));
 assert.equal(f.rows[1][7],360);
 assert.equal(f.call(data).ok,true);
 assert.equal(f.rows.length,2);
});

test('GASは不正・重複した実働区間と合計不一致を受信前に拒否する',()=>{
 for(const work of [null,[[1,0]],data.work.concat([data.work[1]]),[[at('2026-09-30T21:00:00'),at('2026-10-01T07:00:00')]],[]]){
  const f=fixture();assert.equal(f.call({...data,work}).ok,false);assert.equal(f.rows.length,1);
 }
});

test('GASは時刻不明の手動記録を再転記でき、深夜時間は0にする',()=>{
 const f=fixture();
 assert.equal(f.call({id:'manual',row:['2026/09/30','','','',1246/60],work:[]}).ok,true);
 assert.equal(f.rows[1][7],0);
});
