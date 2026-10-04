import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker, { AttendanceStore } from '../src/worker.js';

class Storage {
  data = new Map(); alarm = null;
  async get(k) { return structuredClone(this.data.get(k)); }
  async put(k,v) { this.data.set(k,structuredClone(v)); }
  async delete(k) { return this.data.delete(k); }
  async list({prefix,limit=Infinity}) { return new Map([...this.data].filter(([k])=>k.startsWith(prefix)).slice(0,limit).map(([k,v])=>[k,structuredClone(v)])); }
  async getAlarm() { return this.alarm; }
  async setAlarm(t) { this.alarm=t; }
  async deleteAlarm() { this.alarm=null; }
  async transaction(fn) { const old=structuredClone(this.data),alarm=this.alarm; try{return await fn(this);}catch(e){this.data=old;this.alarm=alarm;throw e;} }
}
function fixture() {
  const storage=new Storage(); let serial=Promise.resolve();
  const ctx={storage,blockConcurrencyWhile(fn){const next=serial.then(fn);serial=next.catch(()=>{});return next;}};
  const env={GAS_SHARED_SECRET:'test-only',GAS_URL:'https://script.google.com/macros/s/test/exec',HOURLY_RATE:'1000'};
  const actor=new AttendanceStore(ctx,env);
  const command=(command,id)=>actor.fetch(new Request('https://internal/command',{method:'POST',body:JSON.stringify({command,requestId:id})})).then(r=>r.json());
  return {storage,actor,command};
}

test('同時開始を直列化し、終了の再送でも記録と反映待ちを重複させない',async()=>{
  const f=fixture();
  const [a,b]=await Promise.all([f.command('/start','1'),f.command('/start','2')]);
  assert.match(a.text,/開始しました/); assert.match(b.text,/^すでに作業中です。/);
  const first=await f.command('/end','3');
  assert.deepEqual(await f.command('/end','3'),first);
  assert.equal((await f.storage.list({prefix:'record:'})).size,1);
  assert.equal((await f.storage.list({prefix:'outbox:'})).size,1);
  assert.ok(f.storage.alarm);
  assert.match((await f.command('/week','4')).text,/反映待ち/);
});

test('Sheets失敗時に保存を維持し、次の再試行成功で反映待ちのみ消す',async(t)=>{
  const f=fixture();await f.command('/start','1');await f.command('/end','2');
  const stub=t.mock.method(globalThis,'fetch',async()=>Response.json({ok:false}));
  await f.actor.alarm();
  assert.equal((await f.storage.list({prefix:'outbox:'})).size,1);
  assert.ok(f.storage.alarm>Date.now());
  stub.mock.mockImplementation(async(_url,options)=>{
    const envelope=JSON.parse(options.body);
    assert.equal(envelope.signature,createHmac('sha256','test-only').update(`${envelope.timestamp}.${envelope.payload}`).digest('hex'));
    assert.deepEqual(JSON.parse(envelope.payload).work,[...(await f.storage.list({prefix:'record:'})).values()][0].work);
    return Response.json({ok:true});
  });
  await f.actor.alarm();
  assert.equal((await f.storage.list({prefix:'outbox:'})).size,0);
  assert.equal((await f.storage.list({prefix:'record:'})).size,1);
  assert.ok(f.storage.alarm); // Slack posting still pending without its configuration.
});

test('深夜料金導入時は過去の全勤務を一度だけ再転記し、勤務と公開投稿を増やさない',async(t)=>{
  const f=fixture();
  const old={id:'old',startedAt:Date.parse('2026-09-30T23:00:00+09:00'),endedAt:Date.parse('2026-10-01T01:00:00+09:00'),work:[[Date.parse('2026-09-30T23:00:00+09:00'),Date.parse('2026-10-01T01:00:00+09:00')]]};
  await f.storage.put('record:old',old);
  await f.storage.put('record:manual',{id:'manual',kind:'manual',workDate:'2026-09-30',durationMs:60000});
  await f.command('/month','first');
  assert.equal((await f.storage.list({prefix:'outbox:'})).size,2);
  assert.ok(f.storage.alarm);
  const sent=[];
  t.mock.method(globalThis,'fetch',async(_url,options)=>{sent.push(JSON.parse(JSON.parse(options.body).payload));return Response.json({ok:true});});
  await f.actor.alarm();
  assert.equal(sent.length,2);
  assert.deepEqual(sent.find(r=>r.id==='old').work,old.work);
  assert.deepEqual(sent.find(r=>r.id==='manual').work,[]);
  await f.command('/month','second');
  assert.equal((await f.storage.list({prefix:'outbox:'})).size,0);
  assert.equal((await f.storage.list({prefix:'record:'})).size,2);
  assert.equal((await f.storage.list({prefix:'slack:'})).size,0);
});

test('再起動しても勤務状態と再送防止を保持する',async()=>{
  const f=fixture();await f.command('/start','a');
  const restarted=new AttendanceStore({storage:f.storage,blockConcurrencyWhile:fn=>fn()},{});
  const request=()=>new Request('https://internal/command',{method:'POST',body:JSON.stringify({command:'/start',requestId:'a'})});
  assert.match((await (await restarted.fetch(request())).json()).text,/開始しました/);
  assert.ok(await f.storage.get('active'));
});

test('公開受付は署名・本人・6コマンドを検証してから保存処理を呼ぶ',async()=>{
  let calls=0;
  const env={SLACK_SIGNING_SECRET:'secret',ALLOWED_USER_ID:'U1',ALLOWED_TEAM_ID:'T1',GAS_URL:'url',GAS_SHARED_SECRET:'key',SLACK_BOT_TOKEN:'test',POST_CHANNEL_ID:'C1',MENTION_USER_ID:'U2',HOURLY_RATE:'1000',ATTENDANCE:{idFromName:v=>v,get:()=>({fetch:async()=>{calls++;return Response.json({ok:true});}})}};
  function req(user='U1',command='/start',sign=true){
    const body=new URLSearchParams({user_id:user,team_id:'T1',command,trigger_id:'123'}).toString();
    const ts=String(Math.floor(Date.now()/1000));
    return new Request('https://example.com/slack/commands',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','x-slack-request-timestamp':ts,'x-slack-signature':sign?'v0='+createHmac('sha256','secret').update(`v0:${ts}:${body}`).digest('hex'):'bad'},body});
  }
  assert.equal((await worker.fetch(req('U1','/start',false),env)).status,401);
  assert.match((await (await worker.fetch(req('U2'),env)).json()).text,/利用できません/);
  assert.match((await (await worker.fetch(req('U1','/today'),env)).json()).text,/不明/);
  assert.equal(calls,0);
  assert.equal((await worker.fetch(req(),env)).status,200);assert.equal(calls,1);
  assert.equal((await worker.fetch(req(),{})).status,503);
});

test('勤務ごとに親投稿を作り、開始だけメンションし、返信を順番に同じスレッドへ送る',async(t)=>{
 const f=fixture();Object.assign(f.actor.env,{SLACK_BOT_TOKEN:'test',POST_CHANNEL_ID:'C123',MENTION_USER_ID:'U123'});
 const sent=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
   if(String(url).includes('script.google.com'))return Response.json({ok:true});
   sent.push(JSON.parse(options.body));return Response.json({ok:true,ts:String(sent.length)+'.000001'});
 });
 for(const [i,c] of ['/start','/break','/resume','/end','/start'].entries())await f.command(c,String(i));
 await f.command('/start','4'); // exact retry
 for(let i=0;i<5;i++)await f.actor.alarm();
 assert.equal(sent.length,5);
 assert.equal(sent[0].thread_ts,undefined);assert.match(sent[0].text,/^<@U123>/);
 for(const msg of sent.slice(1,4)){assert.equal(msg.thread_ts,'1.000001');assert.ok(!msg.text.includes('<@'));assert.equal(msg.channel,'C123');}
 assert.equal(sent[4].thread_ts,undefined);assert.match(sent[4].text,/^<@U123>/);
});

test('Slack投稿の結果が不明な場合、再送してメンションを重複させない',async(t)=>{
 const f=fixture();Object.assign(f.actor.env,{SLACK_BOT_TOKEN:'test',POST_CHANNEL_ID:'C123',MENTION_USER_ID:'U123'});
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('Network disconnected');});
 await f.command('/start','a');await f.actor.alarm();await f.actor.alarm();
 assert.equal(calls,1);assert.equal([...(await f.storage.list({prefix:'slack:'})).values()][0].status,'uncertain');
 assert.ok(await f.storage.get('active'));
});


test('毎月1日のCronで前月分の給与を独立した親投稿としてメンション付きで一度だけ送る',async(t)=>{
 const f=fixture();Object.assign(f.actor.env,{SLACK_BOT_TOKEN:'test',POST_CHANNEL_ID:'C123',MENTION_USER_ID:'U123'});
 const sent=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
   if(String(url).includes('script.google.com'))return Response.json({ok:true});
   sent.push(JSON.parse(options.body));return Response.json({ok:true,ts:String(sent.length)+'.000001'});
 });
 await f.storage.put('record:a',{id:'a',startedAt:Date.parse('2026-09-10T10:00:00+09:00'),endedAt:0,work:[[0,7_200_000]]});
 await f.storage.put('record:b',{id:'b',startedAt:Date.parse('2026-10-01T08:00:00+09:00'),endedAt:0,work:[[0,3_600_000]]});
 let calls=0;
 const env={ALLOWED_USER_ID:'U1',ALLOWED_TEAM_ID:'T1',HOURLY_RATE:'1000',ATTENDANCE:{idFromName:v=>v,get:()=>({fetch:r=>{calls++;return f.actor.fetch(r);}})}};
 const scheduledTime=Date.parse('2026-10-01T09:00:00+09:00');
 await worker.scheduled({scheduledTime},env);
 await worker.scheduled({scheduledTime},env); // Cronの重複起動
 assert.equal(calls,2);
 for(let i=0;i<3;i++)await f.actor.alarm();
 assert.equal(sent.length,1);
 assert.equal(sent[0].channel,'C123');assert.equal(sent[0].thread_ts,undefined);
 assert.equal(sent[0].text,'<@U123>\n💴 2026年9月分の給与\n給与対象実働：2時間0分0秒\n深夜実働（22:00〜5:00・1.25倍）：0分0秒\n時給：1,000円\n合計給与：2,000円');
 assert.equal(f.storage.alarm,null);
});
