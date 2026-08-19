import { test } from 'node:test'; import assert from 'node:assert/strict'; import http from 'node:http';
import { CalendarProvider, LIST, EVENTS, CREATE, parseMultistatus, parseIso } from './dist/provider.js';
const call = (p, contract, args) => p.execute({ id: 'i', revision: 0, contract, args, handle: { id: 'h', contract, caveats: [], delegable: true }, principal: [], digest: 'x', idempotencyKey: 'i' }, { principal: [], trace: { traceId: 't', spanId: 's' } });

// ---------- 假 CalDAV 服务器（不联网）----------
const ms = (inner) => `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/">${inner}</D:multistatus>`;
const resp = (href, props) => `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
const priv = (...names) => `<D:current-user-privilege-set>${names.map(n => `<D:privilege><D:${n}/></D:privilege>`).join('')}</D:current-user-privilege-set>`;
const HOME = ms(
  resp('/calendars/u1/', '<D:displayname>Home</D:displayname><D:resourcetype><D:collection/></D:resourcetype>') +
  resp('/calendars/u1/work/', '<D:displayname>Work</D:displayname><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><A:calendar-color>#FF0000FF</A:calendar-color><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>' + priv('read', 'write', 'bind')) +
  resp('/calendars/u1/holidays/', '<D:displayname>Holidays &amp; Fun</D:displayname><D:resourcetype><D:collection/><C:calendar/></D:resourcetype>' + priv('read')) +
  resp('/calendars/u1/inbox/', '<D:displayname>Inbox</D:displayname><D:resourcetype><D:collection/><C:schedule-inbox/></D:resourcetype>') +
  resp('/calendars/u1/tasks/', '<D:displayname>Tasks</D:displayname><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>' + priv('read', 'write')));
const V = (body) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n${body}END:VCALENDAR\r\n`;
const EV_ALLDAY = V('BEGIN:VEVENT\r\nUID:allday-1\r\nDTSTAMP:20251201T000000Z\r\nDTSTART;VALUE=DATE:20260110\r\nDTEND;VALUE=DATE:20260111\r\nSUMMARY:Company Day\r\nLOCATION:HQ\r\nEND:VEVENT\r\n');
const EV_WEEKLY = V('BEGIN:VEVENT\r\nUID:weekly-1\r\nDTSTAMP:20251201T000000Z\r\nDTSTART:20251201T090000Z\r\nDTEND:20251201T100000Z\r\nRRULE:FREQ=WEEKLY\r\nSUMMARY:Weekly Sync\r\nORGANIZER;CN=Boss:mailto:boss@example.invalid\r\nATTENDEE;CN=Alice:mailto:alice@example.invalid\r\nSTATUS:CONFIRMED\r\nEND:VEVENT\r\n');
const EV_PLAIN = V('BEGIN:VEVENT\r\nUID:plain-1\r\nDTSTAMP:20251201T000000Z\r\nDTSTART:20260103T020000Z\r\nDTEND:20260103T030000Z\r\nSUMMARY:Dentist & stuff\r\nDESCRIPTION:' + 'x'.repeat(2500) + '\r\nEND:VEVENT\r\n');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const REPORT_WORK = ms([EV_PLAIN, EV_ALLDAY, EV_WEEKLY].map((ics, i) => resp(`/calendars/u1/work/e${i}.ics`, `<D:getetag>"e${i}"</D:getetag><C:calendar-data>${esc(ics)}</C:calendar-data>`)).join(''));
const seen = [];
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: b });
    if (!req.headers.authorization?.startsWith('Basic ')) { res.statusCode = 401; return res.end(); }
    const send = (code, xml) => { res.statusCode = code; res.setHeader('content-type', 'application/xml'); res.end(xml); };
    if (req.method === 'PROPFIND') {
      if (req.url === '/' && /current-user-principal/.test(b)) return send(207, ms(resp('/', '<D:current-user-principal><D:href>/principals/u1/</D:href></D:current-user-principal>')));
      if (req.url === '/principals/u1/') return send(207, ms(resp('/principals/u1/', '<C:calendar-home-set><D:href>/calendars/u1/</D:href></C:calendar-home-set>')));
      if (req.url === '/calendars/u1/' && req.headers.depth === '1') return send(207, HOME);
      if (req.url === '/nodiscovery/' && req.headers.depth === '1') return send(207, HOME);   // 发现失败时 serverUrl 直接当 home 的回退
      if (req.url === '/wk/.well-known/caldav') { res.statusCode = 301; res.setHeader('location', '/wk/dav/'); return res.end(); }   // RFC 6764 well-known → 301
      if (req.url === '/wk/dav/' && /current-user-principal/.test(b)) return send(207, ms(resp('/wk/dav/', '<D:current-user-principal><D:href>/principals/u1/</D:href></D:current-user-principal>')));
      return send(404, '');
    }
    if (req.method === 'REPORT') {
      if (req.url === '/calendars/u1/work/') return send(207, REPORT_WORK);
      if (req.url === '/calendars/u1/holidays/') return send(207, ms(''));
      return send(404, '');
    }
    if (req.method === 'PUT') { if (req.url.startsWith('/calendars/u1/work/') && req.url.endsWith('.ics')) { res.statusCode = 201; return res.end(); } res.statusCode = 403; return res.end(); }
    res.statusCode = 405; res.end();
  });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${srv.address().port}`;
process.env['FAKE_CALDAV_PASS'] = 'secret-pass';
const cfg = { accounts: { default: { serverUrl: base + '/', username: 'u1', passEnv: 'FAKE_CALDAV_PASS' }, direct: { serverUrl: base + '/nodiscovery/', username: 'u1', passEnv: 'FAKE_CALDAV_PASS' } } };
const mk = () => new CalendarProvider({ config: cfg, now: () => new Date(2026, 0, 1, 12, 0, 0) });

test('xml helpers + iso parse', () => {
  const rows = parseMultistatus(HOME); assert.equal(rows.length, 5); assert.equal(rows[2].href, '/calendars/u1/holidays/'); assert.equal(rows[2].props.find(p => p.name === 'displayname').text, 'Holidays & Fun');
  assert.equal(parseIso('2026-01-01').getTime(), new Date(2026, 0, 1).getTime()); assert.equal(parseIso('bad'), undefined);
});
test('list: two VEVENT calendars, readOnly correct, inbox/VTODO filtered; discovery via principal → home', async () => {
  const p = mk(); const r = await call(p, LIST, { account: 'default' });
  assert.deepEqual(r.output, { account: 'default', calendars: [{ id: '/calendars/u1/work/', name: 'Work', color: '#FF0000FF', readOnly: false }, { id: '/calendars/u1/holidays/', name: 'Holidays & Fun', readOnly: true }] });
  const pf = seen.filter(s => s.method === 'PROPFIND').map(s => s.url); assert.deepEqual(pf, ['/', '/principals/u1/', '/calendars/u1/']);
  assert.equal(seen[0].headers.authorization, 'Basic ' + Buffer.from('u1:secret-pass').toString('base64'));
  assert.doesNotMatch(JSON.stringify(r), /secret-pass/);
});
test('list: root 404 → /.well-known/caldav (301) → principal → home', async () => {
  const wkBase = `http://127.0.0.1:${srv.address().port}`;
  const srv2 = http.createServer((req, res) => { if (req.url === '/' ) { res.statusCode = 404; return res.end(); } if (req.url === '/.well-known/caldav') { res.statusCode = 301; res.setHeader('location', wkBase + '/wk/dav/'); return res.end(); } res.statusCode = 404; res.end(); });
  await new Promise(r => srv2.listen(0, '127.0.0.1', r));
  const p = new CalendarProvider({ config: { accounts: { default: { serverUrl: `http://127.0.0.1:${srv2.address().port}/`, username: 'u1', passEnv: 'FAKE_CALDAV_PASS' } } } });
  const r = await call(p, LIST, { account: 'default' }); srv2.close();
  assert.ok(r.output, JSON.stringify(r)); assert.equal(r.output.calendars.length, 2);
  const wk = seen.find(s => s.url === '/wk/dav/'); assert.ok(wk, 'PROPFIND must have followed the 301 to /wk/dav/'); assert.equal(wk.method, 'PROPFIND'); assert.match(wk.body, /current-user-principal/);
});
test('list: serverUrl given directly as calendar-home (discovery 404) still works', async () => {
  const r = await call(mk(), LIST, { account: 'direct' }); assert.equal(r.output.calendars.length, 2); assert.equal(r.output.calendars[0].name, 'Work');
});
test('events: 14-day window expands weekly ×2, allDay detected, sorted, description truncated, REPORT time-range sent', async () => {
  const p = mk(); const r = await call(p, EVENTS, { account: 'default', from: '2026-01-01', to: '2026-01-15' });
  assert.ok(r.output, JSON.stringify(r)); const ev = r.output.events;
  assert.deepEqual(ev.map(e => e.uid), ['plain-1', 'weekly-1', 'allday-1', 'weekly-1']);
  const weekly = ev.filter(e => e.uid === 'weekly-1'); assert.equal(weekly.length, 2); assert.ok(weekly.every(e => e.recurring && e.calendar === 'Work' && e.status === 'CONFIRMED' && e.organizer === 'boss@example.invalid' && e.attendees[0] === 'Alice <alice@example.invalid>'));
  assert.equal(new Date(weekly[0].start).getTime(), Date.UTC(2026, 0, 5, 9)); assert.equal(new Date(weekly[1].start).getTime(), Date.UTC(2026, 0, 12, 9));
  const ad = ev.find(e => e.uid === 'allday-1'); assert.equal(ad.allDay, true); assert.equal(ad.start, '2026-01-10'); assert.equal(ad.end, '2026-01-11'); assert.equal(ad.location, 'HQ'); assert.equal(ad.recurring, false);
  const pl = ev.find(e => e.uid === 'plain-1'); assert.equal(pl.allDay, false); assert.equal(pl.title, 'Dentist & stuff'); assert.equal(pl.description.length, 2000);
  for (let i = 1; i < ev.length; i++) assert.ok(new Date(ev[i - 1].start) <= new Date(ev[i].start));
  const rep = seen.filter(s => s.method === 'REPORT'); assert.deepEqual(rep.map(s => s.url), ['/calendars/u1/work/', '/calendars/u1/holidays/']); assert.equal(rep[0].headers.depth, '1'); assert.match(rep[0].body, /time-range start="20251231T160000Z|time-range start="\d{8}T\d{6}Z" end="\d{8}T\d{6}Z"/);
  // 只查一个日历 + limit + 默认窗口（now 注入 → 2026-01-01 00:00 起 7 天）
  const one = await call(p, EVENTS, { account: 'default', calendar: 'Work', from: '2026-01-01', to: '2026-01-15', limit: 2 }); assert.equal(one.output.events.length, 2);
  const dflt = await call(p, EVENTS, { account: 'default' }); assert.equal(dflt.output.from.slice(0, 10), '2026-01-01'); assert.equal(dflt.output.to.slice(0, 10), '2026-01-08'); assert.deepEqual(dflt.output.events.map(e => e.uid), ['plain-1', 'weekly-1']);
  const nocal = await call(p, EVENTS, { account: 'default', calendar: 'Nope' }); assert.equal(nocal.error.code, 'CAPABILITY_ERROR'); assert.match(nocal.error.message, /not found/);
});
test('create: ics has SUMMARY/DTSTART/DTEND/VALARM, PUT to correct href with If-None-Match; readOnly / unknown calendar / unknown account → CAPABILITY_ERROR', async () => {
  const p = mk(); const r = await call(p, CREATE, { account: 'default', calendar: 'work', title: 'Standup', start: '2026-01-02T10:00:00', location: 'Room 1', reminderMinutes: 15 });
  assert.ok(r.output, JSON.stringify(r)); assert.equal(r.output.calendar, 'Work'); assert.equal(r.output.href, `/calendars/u1/work/${r.output.uid}.ics`);
  const put = seen.filter(s => s.method === 'PUT').at(-1); assert.equal(put.url, r.output.href); assert.equal(put.headers['if-none-match'], '*'); assert.match(put.headers['content-type'], /text\/calendar/);
  const ics = put.body; assert.match(ics, /SUMMARY:Standup/); assert.match(ics, /UID:/); assert.match(ics, /LOCATION:Room 1/); assert.match(ics, /BEGIN:VALARM[\s\S]*TRIGGER:-PT15M[\s\S]*END:VALARM/);
  const ds = /DTSTART:(\d{8}T\d{6}Z)/.exec(ics); const de = /DTEND:(\d{8}T\d{6}Z)/.exec(ics); assert.ok(ds && de);
  const toMs = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15));
  assert.equal(toMs(ds[1]), new Date(2026, 0, 2, 10).getTime()); assert.equal(toMs(de[1]) - toMs(ds[1]), 3600_000);   // 无 end → +1h
  const ad = await call(p, CREATE, { account: 'default', calendar: '/calendars/u1/work/', title: 'Trip', start: '2026-02-01', allDay: true, end: '2026-02-03' });
  const ics2 = seen.filter(s => s.method === 'PUT').at(-1).body; assert.match(ics2, /DTSTART;VALUE=DATE:20260201/); assert.match(ics2, /DTEND;VALUE=DATE:20260203/); assert.doesNotMatch(ics2, /VALARM/); assert.ok(ad.output);
  const ro = await call(p, CREATE, { account: 'default', calendar: 'Holidays & Fun', title: 'x', start: '2026-01-02T10:00:00' }); assert.equal(ro.error.code, 'CAPABILITY_ERROR'); assert.match(ro.error.message, /read-only/);
  const nc = await call(p, CREATE, { account: 'default', calendar: 'Nope', title: 'x', start: '2026-01-02T10:00:00' }); assert.equal(nc.error.code, 'CAPABILITY_ERROR'); assert.match(nc.error.message, /not found/);
  const na = await call(p, CREATE, { account: 'ghost', calendar: 'Work', title: 'x', start: '2026-01-02T10:00:00' }); assert.equal(na.error.code, 'CAPABILITY_ERROR'); assert.match(na.error.message, /unknown account/);
  const bad = await call(p, CREATE, { account: 'default', calendar: 'Work', title: 'x', start: 'not-a-date' }); assert.equal(bad.error.code, 'CAPABILITY_ERROR');
  assert.equal(seen.filter(s => s.method === 'PUT').length, 2);   // 三个错误都没发 PUT
});
test('no config at all → CAPABILITY_ERROR (not a crash); auth failure → CAPABILITY_ERROR', async () => {
  const r = await call(new CalendarProvider({ config: { accounts: {} } }), LIST, { account: 'default' }); assert.equal(r.error.code, 'CAPABILITY_ERROR'); assert.match(r.error.message, /unknown account/);
  process.env['EMPTY_PASS'] = '';
  const nopass = await call(new CalendarProvider({ config: { accounts: { default: { serverUrl: base, username: 'u', passEnv: 'EMPTY_PASS' } } } }), LIST, { account: 'default' }); assert.match(nopass.error.message, /no password/);
  const badf = await call(new CalendarProvider({ config: { accounts: { default: { serverUrl: base, username: 'u', passFile: '/nonexistent/x.pass' } } } }), LIST, { account: 'default' }); assert.match(badf.error.message, /cannot read passFile/);
});
test('recurring exception (RECURRENCE-ID) overrides that instance; EXDATE removes one', () => {
  const ics = V('BEGIN:VEVENT\r\nUID:r1\r\nDTSTAMP:20251201T000000Z\r\nDTSTART:20260105T090000Z\r\nDTEND:20260105T100000Z\r\nRRULE:FREQ=DAILY;COUNT=5\r\nEXDATE:20260107T090000Z\r\nSUMMARY:Daily\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:r1\r\nRECURRENCE-ID:20260106T090000Z\r\nDTSTAMP:20251201T000000Z\r\nDTSTART:20260106T150000Z\r\nDTEND:20260106T160000Z\r\nSUMMARY:Daily (moved)\r\nEND:VEVENT\r\n');
  const out = CalendarProvider.expand(ics, 'C', new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 0, 20)));
  assert.deepEqual(out.map(e => e.title), ['Daily', 'Daily (moved)', 'Daily', 'Daily']); assert.equal(new Date(out[1].start).getTime(), Date.UTC(2026, 0, 6, 15));
});
test.after(() => srv.close());
