// Temporary loopback-only provisioning UI. Secrets stay in memory and are
// passed over stdin to Wrangler, never in command arguments or local files.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
const route='/'+randomBytes(24).toString('hex');
const fields=['SLACK_BOT_TOKEN','SLACK_SIGNING_SECRET','GAS_SHARED_SECRET','GAS_URL'];
let busy=false;
const server=http.createServer(async(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'none'; form-action 'self'; frame-ancestors 'none'");
 if(req.url!==route){res.writeHead(404);res.end();return;}
 if(req.method==='GET'){
  res.setHeader('Content-Type','text/html;charset=utf-8');
  res.end('<!doctype html><html lang="ja"><meta charset="utf-8"><title>勤怠Bot 接続設定</title><h1>Cloudflare接続設定</h1><p>入力値は保存せず、Cloudflareの暗号化シークレットへ転送します。</p><form method="post">'+fields.map(n=>`<p><label>${n}<input name="${n}" type="password" required autocomplete="off"></label></p>`).join('')+'<button>Cloudflareへ保存</button></form></html>');return;
 }
 if(req.method!=='POST'||req.headers.origin!=='http://127.0.0.1:8794'||busy){res.writeHead(403);res.end();return;}
 let body='';for await(const chunk of req){body+=chunk;if(body.length>16000){res.writeHead(413);res.end();return;}}
 const params=new URLSearchParams(body),secrets={};
 for(const field of fields){if(!params.get(field)){res.writeHead(400);res.end('Missing field');return;}secrets[field]=params.get(field);}
 busy=true;
 const child=spawn('./node_modules/.bin/wrangler',['secret','bulk'],{cwd:process.cwd(),stdio:['pipe','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
 child.stdout.resume();child.stderr.resume();child.stdin.on('error',()=>{});
 child.stdin.end(JSON.stringify(secrets));body='';
 child.on('error',()=>{res.writeHead(500);res.end('Cloudflare configuration failed');busy=false;});
 child.on('exit',code=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end(code===0?'<h1>Cloudflareへの保存が完了しました</h1><p>4項目を暗号化シークレットとして設定しました。</p>':'<h1>保存に失敗しました</h1>');for(const f of fields)delete secrets[f];busy=false;if(code===0)server.close();});
});
server.listen(8794,'127.0.0.1',()=>console.log('Setup URL: http://127.0.0.1:8794'+route));
setTimeout(()=>server.close(),15*60*1000).unref();
