#!/usr/bin/env node
// front-plain — 第三方风格的 CAK 前端插件（roles: frontend），零依赖：只连 daemon 的控制面（~/.cak/daemon/<session>.json）。
// 风格：极简"日志流"——每件事一行、审批用 y/n/s 回答；适合远程终端 / 想把输出重定向到文件的人。
//   node main.mjs [--session NAME]
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import readline from 'node:readline';
const argv = process.argv.slice(2); const flag = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
const dir = path.join(os.homedir(), '.cak', 'daemon'); const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs) : [];
const pick = flag('session') ? files.find(f => path.basename(f, '.json') === flag('session')) : files[0]; if (!pick) { console.error('front-plain: 没找到在跑的 daemon'); process.exit(2); }
const info = JSON.parse(fs.readFileSync(pick, 'utf8')); let id = 1;
const rpc = async (method, params = {}) => { const r = await fetch(info.url + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cak-token': info.token }, body: JSON.stringify({ cak: '1', jsonrpc: '2.0', id: id++, method, params }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
const st = await rpc('session.status'); console.log(`[front-plain] ${st.session} @ ${st.workspace} · ${st.plugins.length} 插件 · 输入即提交，审批答 y/n/s`);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); let pending = []; let answering = false;
const askApproval = async () => { if (answering) return; answering = true; while (pending.length) { const p = pending[0]; const ans = await new Promise(res => rl.question(`[审批] ${p.contract} ${JSON.stringify(p.args).slice(0, 100)}${p.rule ? ` (s=${p.rule.human})` : ''} y/n/s> `, res)); const d = ans.trim().toLowerCase() === 'y' ? 'grant' : ans.trim().toLowerCase() === 's' && p.rule ? 'standing' : 'deny'; try { await rpc('session.decide', { approvalId: p.approvalId, decision: d }); console.log(`[审批] ${d}`); } catch (e) { console.log('[审批] 失败 ' + e.message); } pending.shift(); } answering = false; };
const u = new URL(info.url + '/events'); u.searchParams.set('since', String(Number.MAX_SAFE_INTEGER - 1)); u.searchParams.set('token', info.token);
http.get(u, res => { let buf = ''; res.setEncoding('utf8'); res.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); const d = block.split('\n').find(l => l.startsWith('data: ')); if (!d) continue; let e; try { e = JSON.parse(d.slice(6)); } catch { continue; }
  if (e.type === 'daemon.approval.needed') { pending.push(...e.payload.pending); askApproval(); }
  else if (e.type === 'daemon.task.result') { console.log(`[结果] ${typeof e.payload.output === 'string' ? e.payload.output : JSON.stringify(e.payload.output)}`); rl.prompt(); }
  else if (e.type === 'daemon.model.delta') { process.stdout.write(e.payload.text); }
  else if (e.type === 'invocation.requested' && !['model.generate', 'session.history', 'memory.search'].includes(e.payload?.contract?.name)) console.log(`[调用] ${e.payload.contract.name} ${JSON.stringify(e.payload.args).slice(0, 80)}`);
  else if (e.type === 'invocation.denied') console.log(`[拒绝] ${e.payload.code} ${e.payload.reason}`); } }); });
rl.setPrompt('> '); rl.prompt();
rl.on('line', async line => { line = line.trim(); if (!line || answering) return; if (line === '/quit') process.exit(0); try { await rpc('session.input', { text: line }); } catch (e) { console.log('✗ ' + e.message); } });
