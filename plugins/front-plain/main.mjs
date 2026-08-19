#!/usr/bin/env node
// front-plain — 第三方风格的 CAK 前端插件（roles: frontend），零依赖：只连 daemon 的控制面（~/.cak/daemon/<session>.json）。
// 风格：极简"日志流"——每件事一行、审批用 y/n/s 回答；适合远程终端 / 想把输出重定向到文件的人。
//   node main.mjs [--session NAME] [--agent NAME]
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import readline from 'node:readline';
const argv = process.argv.slice(2); const flag = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined; };
const dir = path.join(os.homedir(), '.cak', 'daemon'); const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs) : [];
const pick = flag('session') ? files.find(f => path.basename(f, '.json') === flag('session')) : files[0]; if (!pick) { console.error('front-plain: 没找到在跑的内核（先 cak up）'); process.exit(2); }
const info = JSON.parse(fs.readFileSync(pick, 'utf8')); let id = 1; const agent = flag('agent') ?? info.defaultAgent ?? undefined;
const rpc = async (method, params = {}) => { const r = await fetch(info.url + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cak-token': info.token }, body: JSON.stringify({ cak: '1', jsonrpc: '2.0', id: id++, method, params: agent && params.agent === undefined ? { agent, ...params } : params }) }); if (r.status === 401) throw new Error('token 不对（内核重启过？）'); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
let st; try { st = await rpc('session.status'); } catch (e) { console.error('front-plain: 连不上内核：' + e.message); process.exit(2); }
console.log(`[front-plain] ${st.session} @ ${st.workspace} · ${st.plugins.length} 插件 · 输入即提交，审批答 y/n/s · /quit 或 Ctrl-C 退出（内核继续跑）`);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); const earlyLines = []; const earlyListener = l => earlyLines.push(l); rl.on('line', earlyListener);   // 管道模式：连上之前到的行先攒着（regress-2） let pending = []; let answering = false; let streamed = false; let quitting = false;
const seen = new Set(); const mine = new Set(); const decidedElsewhere = new Set(); const apInv = new Map();
const bye = () => { if (quitting) return; quitting = true; try { rl.close(); } catch { /* */ } console.log('\n[front-plain] 已退出前端；内核还在后台跑，停：cak stop'); process.exit(0); };
rl.on('SIGINT', bye); process.on('SIGINT', bye); rl.on('close', bye);
const askApproval = async () => { if (answering) return; answering = true; while (pending.length) { const p = pending[0]; if (seen.has(p.approvalId)) { pending.shift(); continue; } seen.add(p.approvalId); apInv.set(p.approvalId, p.invocationId);
    if (streamed) { process.stdout.write('\n'); streamed = false; }
    const ans = await new Promise(res => rl.question(`[审批]${p.agent && p.agent !== st.agent ? ` (agent ${p.agent})` : ''} ${p.contract} ${JSON.stringify(p.args).slice(0, 100)}${p.rule ? ` (s=${p.rule.human})` : ''} y/n/s> `, res)); const a = ans.trim().toLowerCase(); if (a === '/quit') return bye();
    if (decidedElsewhere.has(p.approvalId)) { console.log('[审批] 这条已在别处决定，跳过'); pending.shift(); continue; }
    const d = a === 'y' ? 'grant' : a === 's' && p.rule ? 'standing' : 'deny'; mine.add(p.invocationId);
    try { await rpc('session.decide', { approvalId: p.approvalId, decision: d, ...(p.agent ? { agent: p.agent } : {}), ...(d === 'deny' ? { reason: '用户在 front-plain 拒绝' } : {}) }); console.log(`[审批] ${d === 'grant' ? '已允许' : d === 'deny' ? '已拒绝（你）' : '已设为本会话常设允许'}`); } catch (e) { console.log(/no pending approval/.test(e.message) ? '[审批] 这条已在别处决定' : '[审批] 失败 ' + e.message); }
    pending.shift(); } answering = false; rl.prompt(); };
const u = new URL(info.url + '/events'); u.searchParams.set('since', String(Number.MAX_SAFE_INTEGER - 1)); u.searchParams.set('token', info.token); if (agent) u.searchParams.set('agent', agent);
http.get(u, res => { let buf = ''; res.setEncoding('utf8'); res.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); const d = block.split('\n').find(l => l.startsWith('data: ')); if (!d) continue; let e; try { e = JSON.parse(d.slice(6)); } catch { continue; }
  if (e.type === 'daemon.approval.needed') { pending.push(...e.payload.pending.map(p => ({ ...p, agent: e.payload.agent }))); askApproval(); }
  else if (e.type === 'daemon.task.result') { if (streamed) { process.stdout.write('\n'); streamed = false; } else console.log(`[结果] ${typeof e.payload.output === 'string' ? e.payload.output : JSON.stringify(e.payload.output)}`); const us = e.payload.usage; console.log(`[${e.payload.status === 'finished' ? '完成' : e.payload.status}]${us ? ` ${us.calls} 次调用 · 令牌 ${us.inputTokens}/${us.outputTokens}` : ''}`); if (!answering) rl.prompt(); }
  else if (e.type === 'daemon.model.delta') { process.stdout.write(e.payload.text); streamed = true; }
  else if (e.type === 'daemon.note') { if (streamed) { process.stdout.write('\n'); streamed = false; } console.log(`[${e.payload.level === 'error' ? '错误' : '提示'}] ${e.payload.message}`); }
  else if (e.type === 'invocation.requested' && !['model.generate', 'session.history', 'memory.search'].includes(e.payload?.contract?.name)) { if (streamed) { process.stdout.write('\n'); streamed = false; } console.log(`[调用] ${e.payload.contract.name} ${JSON.stringify(e.payload.args).slice(0, 80)}`); }
  else if (e.type === 'grant.issued') { const ap = e.payload?.approvalId; if (ap && seen.has(ap) && !mine.has(apInv.get(ap))) { decidedElsewhere.add(ap); console.log('[审批] 已允许（别处）' + (answering ? '——上面那条不用答了，直接回车' : '')); } }
  else if (e.type === 'invocation.denied') { const isMine = mine.has(e.payload?.invocationId); const reason = String(e.payload?.reason ?? ''); if (e.payload?.code === 'APPROVAL_INVALID' && /^审批被拒绝/.test(reason)) { if (isMine) return; const ap = [...apInv.entries()].find(([, v]) => v === e.payload.invocationId)?.[0]; if (ap) decidedElsewhere.add(ap); console.log(`[审批] 已拒绝（${reason.replace(/^审批被拒绝[:：]\s*/, '') || '别处'}）` + (answering && ap && pending[0]?.approvalId === ap ? '——上面那条不用答了，直接回车' : '')); } else console.log(`[拒绝] ${reason || e.payload?.code}`); } } }); }).on('error', e => { console.error('front-plain: 事件流断了：' + e.message); });
// 连接时先拉已经在等的审批
try { const pend = await rpc('session.pending'); const s2 = await rpc('session.status'); if (s2.running) console.log(`[状态] agent 在跑${s2.current?.input ? '：' + String(s2.current.input).slice(0, 60) : ''}${s2.queued ? `（排队 ${s2.queued}）` : ''}`); if (pend.length) { console.log(`[状态] 有 ${pend.length} 条审批在等你`); pending.push(...pend); askApproval(); } } catch (e) { console.log('[错误] ' + e.message); }
rl.setPrompt('> '); if (!answering) rl.prompt();
rl.off('line', earlyListener); for (const l of earlyLines) setImmediate(() => rl.emit('line', l));
rl.on('line', async line => { line = line.trim(); if (!line || answering) return; if (line === '/quit' || line === '/exit') return bye(); try { await rpc('session.input', { text: line }); } catch (e) { console.log('✗ ' + e.message); } });
