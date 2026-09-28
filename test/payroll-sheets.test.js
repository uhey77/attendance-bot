import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

test('月別給与シートは初回のみ作り、翌月を追加しても過去月を上書きしない',()=>{
 const sheets=new Map();
 const book={getSheetByName:n=>sheets.get(n),insertSheet(n){
  const cells=new Map();
  const sheet={cells,getRange(a){return {clear(){cells.clear();return this;},getValues(){return cells.get(a)||[['']];},setValue(v){cells.set(a,v);return this;},setValues(v){cells.set(a,v);return this;},setFormula(v){cells.set(a,v);return this;},setNumberFormat(){return this;},setBackground(){return this;},setFontColor(){return this;},setFontWeight(){return this;},setNote(){return this;}};},setColumnWidths(){},setColumnWidth(){},setFrozenRows(){}};
  sheets.set(n,sheet);return sheet;
 }};
 const context=vm.createContext({console});
 vm.runInContext(fs.readFileSync(new URL('../gas/Payroll.gs',import.meta.url),'utf8'),context);
 context.payrollMonth_(book,'2026-09');
 assert.deepEqual([...sheets.keys()],['月別給与','2026-09']);
 const monthly=sheets.get('2026-09');
 assert.equal(monthly.cells.get('A1:D1')[0].join('|'),'日付|休憩合計|実働合計|給与（円）');
 assert.match(monthly.cells.get('A2'),/group by Col1/);
 assert.match(monthly.cells.get('A2'),/12147896323831/);
 assert.match(monthly.cells.get('A2'),/12158189900133/);
 assert.equal(monthly.cells.get('D2'),'=ARRAYFORMULA(IF(A2:A="","",C2:C*24*1000))');
 assert.match(sheets.get('月別給与').cells.get('D2'),/ROUND\(B2:B\*24\*C2:C,0\)/);
 monthly.cells.set('A2','sentinel');
 context.payrollMonth_(book,'2026-09');context.payrollMonth_(book,'2026-10');
 assert.equal(monthly.cells.get('A2'),'sentinel');
 assert.deepEqual([...sheets.keys()],['月別給与','2026-09','2026-10']);
 assert.throws(()=>context.payrollMonth_(book,'invalid'));
});
