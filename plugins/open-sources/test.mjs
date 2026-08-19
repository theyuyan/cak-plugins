// node --test：本机 http server 假装四个远端（RSS/Atom/JSON Feed、HN Firebase、Wikipedia、arXiv），全程默认不联网。
// 样本按各官方文档/真实响应形状手写（RSS 2.0 规范示例 Liftoff News、RFC 4287 Atom 示例、jsonfeed.org 1.1 示例、HN API 文档 item、
// MediaWiki list=search + REST page/summary、arXiv API 文档 Atom 示例）。OPEN_SOURCES_LIVE=1 时额外对真实端点各调一次只断言不报错。
import { test } from 'node:test'; import assert from 'node:assert/strict'; import http from 'node:http';
import { OpenSourcesProvider, FEED_READ, HN_TOP, WIKI_SEARCH, ARXIV_SEARCH, parseXml, htmlToText, isPrivateHost } from './dist/provider.js';

const call = (p, contract, args) => p.execute({ id: 'i', revision: 0, contract, args, handle: { id: 'h', contract, caveats: [], delegable: true }, principal: [], digest: 'x', idempotencyKey: 'i' }, { principal: [], trace: { traceId: 't', spanId: 's' } });

// ---------- 样本 ----------
const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
 <channel>
  <title>Liftoff News</title>
  <link>http://liftoff.msfc.nasa.gov/</link>
  <description>Liftoff to Space Exploration.</description>
  <language>en-us</language>
  <pubDate>Tue, 10 Jun 2003 04:00:00 GMT</pubDate>
  <lastBuildDate>Tue, 10 Jun 2003 09:41:01 GMT</lastBuildDate>
  <item>
   <title>Star City</title>
   <link>http://liftoff.msfc.nasa.gov/news/2003/news-starcity.asp</link>
   <description>How do Americans get ready to work with Russians aboard the International Space Station? They take a crash course in culture, language and protocol at Russia's &lt;a href="http://howe.iki.rssi.ru/GCTC/gctc_e.htm"&gt;Star City&lt;/a&gt;.</description>
   <content:encoded><![CDATA[<p>How do Americans get ready to work with Russians aboard the <b>International Space Station</b>?</p><p>Full body paragraph two with a <a href="http://x">link</a>.</p>]]></content:encoded>
   <dc:creator>NASA Liftoff</dc:creator>
   <category>Space</category>
   <category domain="http://example.com/tax">ISS</category>
   <pubDate>Tue, 03 Jun 2003 09:39:21 GMT</pubDate>
   <guid>http://liftoff.msfc.nasa.gov/2003/06/03.html#item573</guid>
  </item>
  <item>
   <description>Sky watchers in Europe, Asia, and parts of Alaska and Canada will experience a &lt;a href="http://science.nasa.gov/headlines/y2003/30may_solareclipse.htm"&gt;partial eclipse of the Sun&lt;/a&gt; on Saturday, May 31st.</description>
   <pubDate>Fri, 30 May 2003 11:06:42 GMT</pubDate>
   <guid>http://liftoff.msfc.nasa.gov/2003/05/30.html#item572</guid>
  </item>
  <item>
   <title>The Engine That Does More</title>
   <link>http://liftoff.msfc.nasa.gov/news/2003/news-VASIMR.asp</link>
   <description>Before man travels to Mars, NASA hopes to design new engines that will let us fly through the Solar System more quickly.  The proposed VASIMR engine would do that.</description>
   <pubDate>Tue, 27 May 2003 08:37:32 GMT</pubDate>
   <guid>http://liftoff.msfc.nasa.gov/2003/05/27.html#item571</guid>
  </item>
 </channel>
</rss>`;
const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Feed</title>
  <link href="http://example.org/"/>
  <updated>2003-12-13T18:30:02Z</updated>
  <author><name>John Doe</name></author>
  <id>urn:uuid:60a76c80-d399-11d9-b93C-0003939e0af6</id>
  <entry>
    <title>Atom-Powered Robots Run Amok</title>
    <link href="http://example.org/2003/12/13/atom03"/>
    <id>urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a</id>
    <updated>2003-12-13T18:30:02Z</updated>
    <summary>Some text.</summary>
  </entry>
  <entry>
    <title type="html">Second &amp;amp; &lt;em&gt;emphasised&lt;/em&gt; entry</title>
    <link rel="alternate" type="text/html" href="http://example.org/2005/04/02/atom"/>
    <link rel="enclosure" type="audio/mpeg" length="1337" href="http://example.org/audio/ph34r_my_podcast.mp3"/>
    <id>tag:example.org,2003:3.2397</id>
    <updated>2005-07-31T12:29:29Z</updated>
    <published>2003-12-13T08:29:29-04:00</published>
    <author><name>Mark Pilgrim</name><uri>http://example.org/</uri><email>f8dy@example.com</email></author>
    <category term="atom" label="Atom"/>
    <category term="xml"/>
    <content type="xhtml" xml:lang="en" xml:base="http://diveintomark.org/"><div xmlns="http://www.w3.org/1999/xhtml"><p><i>[Update: The Atom draft is finished.]</i></p><p>Second paragraph of the full content.</p></div></content>
  </entry>
</feed>`;
const JSONFEED = {
  version: 'https://jsonfeed.org/version/1.1', title: 'My Example Feed', home_page_url: 'https://example.org/', feed_url: 'https://example.org/feed.json',
  authors: [{ name: 'Brent Simmons', url: 'http://example.org/', avatar: 'https://example.org/avatar.png' }], language: 'en-US',
  items: [
    { id: '2', content_text: 'This is a second item.', url: 'https://example.org/second-item', date_published: '2010-02-07T14:04:00-05:00', tags: ['news', 'meta'] },
    { id: '1', content_html: '<p>Hello, <b>world</b>!</p><p>Second paragraph.</p>', summary: 'Hello world summary', url: 'https://example.org/initial-post', date_published: '2010-02-06T14:04:00-05:00', authors: [{ name: 'Brent Simmons' }] },
  ],
};
// HN：id 列表 + item（形状照 HN API 文档：by/descendants/id/kids/score/time/title/type/url；Ask HN 无 url 有 text）
const HN_TOP_IDS = [8863, 121003, 192327, 1000, 2000];
const HN_ITEMS = {
  8863: { by: 'dhouston', descendants: 71, id: 8863, kids: [8952, 9224], score: 111, time: 1175714200, title: 'My YC app: Dropbox - Throw away your USB drive', type: 'story', url: 'http://www.getdropbox.com/u/2/screencast.html' },
  121003: { by: 'tel', descendants: 16, id: 121003, kids: [121016], score: 25, text: 'I would like to know what other Arc users think', time: 1210981217, title: 'Ask HN: The Arc Effect', type: 'story' },
  192327: { by: 'justin', descendants: 0, id: 192327, score: 6, time: 1210981217, title: 'Justin.tv is looking for a Lead Flash Engineer!', type: 'job', url: 'http://www.justin.tv/jobs' },
  1000: { by: 'pg', descendants: 3, id: 1000, score: 40, time: 1172394646, title: 'Show HN: something', type: 'story', url: 'http://example.org/show' },
  2000: null, // 已删除条目 Firebase 返回 null
};
// Wikipedia：list=search 与 REST summary
const WIKI_SEARCH_RESP = { batchcomplete: '', continue: { sroffset: 1, continue: '-||' }, query: { searchinfo: { totalhits: 2412 }, search: [
  { ns: 0, title: 'Hacker News', pageid: 12345, size: 21580, wordcount: 2237, snippet: '<span class="searchmatch">Hacker</span> <span class="searchmatch">News</span> (sometimes abbreviated as HN) is a social news website', timestamp: '2024-05-01T10:11:12Z' },
  { ns: 0, title: 'No Summary Page', pageid: 99, size: 100, wordcount: 10, snippet: 'only <span class="searchmatch">snippet</span> here', timestamp: '2024-05-01T10:11:12Z' },
] } };
const WIKI_SUMMARY = { type: 'standard', title: 'Hacker News', displaytitle: '<span class="mw-page-title-main">Hacker News</span>', namespace: { id: 0, text: '' }, wikibase_item: 'Q3437', titles: { canonical: 'Hacker_News', normalized: 'Hacker News', display: 'Hacker News' }, pageid: 12345,
  thumbnail: { source: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b2/Y_Combinator_logo.svg/320px-Y_Combinator_logo.svg.png', width: 320, height: 320 }, originalimage: { source: 'https://upload.wikimedia.org/wikipedia/commons/b/b2/Y_Combinator_logo.svg', width: 512, height: 512 },
  lang: 'en', dir: 'ltr', revision: '1220000000', tid: 'x', timestamp: '2024-05-01T10:11:12Z', description: 'Social news website', description_source: 'local',
  content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Hacker_News', revisions: 'https://en.wikipedia.org/wiki/Hacker_News?action=history', edit: 'https://en.wikipedia.org/wiki/Hacker_News?action=edit', talk: 'https://en.wikipedia.org/wiki/Talk:Hacker_News' }, mobile: { page: 'https://en.m.wikipedia.org/wiki/Hacker_News', revisions: 'x', edit: 'x', talk: 'x' } },
  extract: 'Hacker News (sometimes abbreviated as HN) is a social news website focusing on computer science and entrepreneurship. It is run by the investment fund and startup incubator Y Combinator. ' + 'x'.repeat(3000), extract_html: '<p><b>Hacker News</b> is a social news website</p>' };
// arXiv：API 文档示例 + 一条新式 id、多作者
const ARXIV = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <link href="http://arxiv.org/api/query?search_query%3Dall%3Aelectron%26id_list%3D%26start%3D0%26max_results%3D2" rel="self" type="application/atom+xml"/>
  <title type="html">ArXiv Query: search_query=all:electron&amp;id_list=&amp;start=0&amp;max_results=2</title>
  <id>http://arxiv.org/api/cHxbiOdZaP56ODnBPIenZhzg5f8</id>
  <updated>2007-10-08T00:00:00-04:00</updated>
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">1000</opensearch:totalResults>
  <opensearch:startIndex xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:startIndex>
  <opensearch:itemsPerPage xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">2</opensearch:itemsPerPage>
  <entry>
    <id>http://arxiv.org/abs/hep-ex/0307015v1</id>
    <updated>2003-07-07T13:46:39-04:00</updated>
    <published>2003-07-07T13:46:39-04:00</published>
    <title>Multi-Electron Production at High Transverse Momenta in ep Collisions at
  HERA</title>
    <summary>  Multi-electron production is studied at high electron transverse momentum in
positron- and electron-proton collisions using the H1 detector at HERA.
</summary>
    <author><name>H1 Collaboration</name></author>
    <arxiv:comment xmlns:arxiv="http://arxiv.org/schemas/atom">23 pages, 8 figures and 4 tables</arxiv:comment>
    <arxiv:journal_ref xmlns:arxiv="http://arxiv.org/schemas/atom">Eur.Phys.J. C31 (2003) 17-29</arxiv:journal_ref>
    <link href="http://arxiv.org/abs/hep-ex/0307015v1" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/hep-ex/0307015v1" rel="related" type="application/pdf"/>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="hep-ex" scheme="http://arxiv.org/schemas/atom"/>
    <category term="hep-ex" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.01234v2</id>
    <updated>2024-02-01T00:00:00Z</updated>
    <published>2024-01-02T18:00:00Z</published>
    <title>Agents That Plan</title>
    <summary>  ${'long summary '.repeat(300)}</summary>
    <author><name>Alice Author</name><arxiv:affiliation xmlns:arxiv="http://arxiv.org/schemas/atom">Uni A</arxiv:affiliation></author>
    <author><name>Bob Builder</name></author>
    <author><name>Carol Coder</name></author>
    <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.1000/xyz123</arxiv:doi>
    <link title="doi" href="http://dx.doi.org/10.1000/xyz123" rel="related"/>
    <link href="http://arxiv.org/abs/2401.01234v2" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2401.01234v2" rel="related" type="application/pdf"/>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.MA" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`;
const ARXIV_ERR = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title type="html">ArXiv Query: search_query=&amp;id_list=1234.12345</title><id>http://arxiv.org/api/x</id><updated>2007-10-12T00:00:00-04:00</updated>
<entry><id>http://arxiv.org/api/errors#incorrect_id_format_for_1234.12345</id><title>Error</title><summary>incorrect id format for 1234.12345</summary><updated>2007-10-12T00:00:00-04:00</updated><link href="http://arxiv.org/api/errors#incorrect_id_format_for_1234.12345" rel="alternate" type="text/html"/><author><name>arXiv api core</name></author></entry></feed>`;

// ---------- 假远端 ----------
const seen = { hnInflight: 0, hnMaxInflight: 0, hnItemCalls: 0, wikiUA: [], wikiPaths: [], arxivTimes: [], arxivQueries: [] };
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname; const send = (code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };
  if (p === '/rss.xml') return send(200, 'application/rss+xml; charset=utf-8', RSS);
  if (p === '/atom.xml') return send(200, 'application/atom+xml', ATOM);
  if (p === '/feed.json') return send(200, 'application/feed+json', JSON.stringify(JSONFEED));
  if (p === '/html') return send(200, 'text/html', '<html><body>not a feed</body></html>');
  if (p === '/r1') { res.writeHead(302, { location: '/r2' }); return res.end(); }
  if (p === '/r2') { res.writeHead(301, { location: '/rss.xml' }); return res.end(); }
  if (p.startsWith('/loop')) { res.writeHead(302, { location: '/loop' + Math.random() }); return res.end(); }
  if (p === '/to-private') { res.writeHead(302, { location: 'http://10.0.0.1/feed.xml' }); return res.end(); }
  if (p === '/500') return send(500, 'text/plain', 'boom');
  if (p === '/404') return send(404, 'text/plain', 'nope');
  if (p === '/slow') { await new Promise(r => setTimeout(r, 1500)); return send(200, 'application/rss+xml', RSS); }
  if (p === '/big') { res.writeHead(200, { 'content-type': 'application/rss+xml' }); res.write('<rss><channel><title>big</title>'); const chunk = 'x'.repeat(65536); for (let i = 0; i < 40; i++) res.write(chunk); return res.end('</channel></rss>'); }
  // HN
  if (p === '/v0/topstories.json') return send(200, 'application/json', JSON.stringify(HN_TOP_IDS));
  if (p === '/v0/askstories.json') return send(200, 'application/json', JSON.stringify([121003]));
  if (p === '/v0/beststories.json') return send(200, 'application/json', JSON.stringify(Array.from({ length: 30 }, (_, i) => 8863)));
  const im = /^\/v0\/item\/(\d+)\.json$/.exec(p);
  if (im) { seen.hnItemCalls++; seen.hnInflight++; seen.hnMaxInflight = Math.max(seen.hnMaxInflight, seen.hnInflight); await new Promise(r => setTimeout(r, 30)); seen.hnInflight--; return send(200, 'application/json', JSON.stringify(HN_ITEMS[im[1]] ?? null)); }
  // Wikipedia（/{lang}/...）
  const wm = /^\/([a-z-]+)\/(w\/api\.php|api\/rest_v1\/page\/summary\/(.+))$/.exec(p);
  if (wm) {
    seen.wikiUA.push(req.headers['user-agent']); seen.wikiPaths.push(p + u.search);
    if (wm[2] === 'w/api.php') return send(200, 'application/json', JSON.stringify(u.searchParams.get('srsearch') === 'nothing-here' ? { batchcomplete: '', query: { searchinfo: { totalhits: 0 }, search: [] } } : WIKI_SEARCH_RESP));
    if (wm[3] === 'Hacker_News') return send(200, 'application/json', JSON.stringify(WIKI_SUMMARY));
    return send(404, 'application/json', JSON.stringify({ type: 'https://mediawiki.org/wiki/HyperSwitch/errors/not_found', title: 'Not found.', method: 'get', detail: 'Page or revision not found.', uri: p }));
  }
  // arXiv
  if (p === '/api/query') { seen.arxivTimes.push(Date.now()); seen.arxivQueries.push(u.search); if (u.searchParams.get('search_query') === 'bad') return send(200, 'application/atom+xml', ARXIV_ERR); return send(200, 'application/atom+xml; charset=UTF-8', ARXIV); }
  send(404, 'text/plain', 'not found');
});
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${srv.address().port}`;
const mk = (extra = {}) => new OpenSourcesProvider({ allowPrivate: true, cacheTtlMs: 0, hnUrl: base, wikiUrl: `${base}/{lang}`, arxivUrl: `${base}/api/query`, arxivMinIntervalMs: 100, timeoutMs: 5000, ...extra });

test('unit: parseXml / htmlToText / isPrivateHost', () => {
  const x = parseXml('<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "y">]><a b="1" c=\'2&amp;\'><!-- c --><d>t&lt;1</d><e><![CDATA[<raw>]]></e><ns:f/></a>');
  assert.equal(x.name, 'a'); assert.equal(x.attrs.c, '2&'); assert.equal(x.children[0].text, 't<1'); assert.equal(x.children[1].text, '<raw>'); assert.equal(x.children[2].name, 'f'); assert.equal(x.children[2].qname, 'ns:f');
  assert.equal(htmlToText('<p>a &amp; b</p><script>x</script><p>c</p>'), 'a & b\nc');
  assert.ok(isPrivateHost('127.0.0.1') && isPrivateHost('10.1.2.3') && isPrivateHost('192.168.0.1') && isPrivateHost('localhost') && isPrivateHost('169.254.169.254') && isPrivateHost('[::1]'));
  assert.ok(!isPrivateHost('hnrss.org') && !isPrivateHost('8.8.8.8'));
});

test('① feed.read: RSS 2.0', async () => {
  const p = mk(); const r = await call(p, FEED_READ, { url: `${base}/rss.xml` });
  assert.ok(r.output, JSON.stringify(r)); assert.equal(r.output.kind, 'rss'); assert.equal(r.output.title, 'Liftoff News'); assert.equal(r.output.items.length, 3);
  const it = r.output.items[0]; assert.equal(it.title, 'Star City'); assert.equal(it.link, 'http://liftoff.msfc.nasa.gov/news/2003/news-starcity.asp'); assert.equal(it.published, '2003-06-03T09:39:21.000Z'); assert.equal(it.author, 'NASA Liftoff'); assert.deepEqual(it.categories, ['Space', 'ISS']);
  assert.ok(!it.summary.includes('<a'), 'summary 去标签'); assert.ok(it.summary.includes('Star City.')); assert.ok(!it.summary.includes('Full body'), '默认取 description 不取全文');
  assert.equal(r.output.items[1].title, ''); assert.equal(r.output.items[1].link, 'http://liftoff.msfc.nasa.gov/2003/05/30.html#item572', '无 link 时用 guid');
  // fullText + maxCharsPerItem
  const f = await call(p, FEED_READ, { url: `${base}/rss.xml`, fullText: true, maxCharsPerItem: 60 });
  assert.ok(f.output.items[0].summary.startsWith('How do Americans get ready to work with Russians aboard the')); assert.ok(f.output.items[0].summary.length <= 60); assert.ok(!f.output.items[0].summary.includes('<b>'));
  const f2 = await call(p, FEED_READ, { url: `${base}/rss.xml`, fullText: true }); assert.ok(f2.output.items[0].summary.includes('Full body paragraph two with a link.'));
  // since + limit
  const s = await call(p, FEED_READ, { url: `${base}/rss.xml`, since: '2003-05-30T00:00:00Z' }); assert.deepEqual(s.output.items.map(i => i.published), ['2003-06-03T09:39:21.000Z', '2003-05-30T11:06:42.000Z']);
  const l = await call(p, FEED_READ, { url: `${base}/rss.xml`, limit: 1 }); assert.equal(l.output.items.length, 1);
  const bad = await call(p, FEED_READ, { url: `${base}/rss.xml`, since: 'yesterday' }); assert.equal(bad.error.code, 'CAPABILITY_ERROR');
});

test('① feed.read: Atom', async () => {
  const r = await call(mk(), FEED_READ, { url: `${base}/atom.xml` });
  assert.ok(r.output, JSON.stringify(r)); assert.equal(r.output.kind, 'atom'); assert.equal(r.output.title, 'Example Feed'); assert.equal(r.output.items.length, 2);
  const [a, b] = r.output.items;
  assert.equal(a.title, 'Atom-Powered Robots Run Amok'); assert.equal(a.link, 'http://example.org/2003/12/13/atom03'); assert.equal(a.published, '2003-12-13T18:30:02.000Z', '无 published 用 updated'); assert.equal(a.summary, 'Some text.'); assert.equal(a.author, undefined);
  assert.equal(b.title, 'Second & emphasised entry', 'type=html 的标题要解实体去标签'); assert.equal(b.link, 'http://example.org/2005/04/02/atom', '取 rel=alternate 不取 enclosure'); assert.equal(b.published, '2003-12-13T12:29:29.000Z'); assert.equal(b.author, 'Mark Pilgrim'); assert.deepEqual(b.categories, ['atom', 'xml']);
  assert.ok(b.summary.includes('[Update: The Atom draft is finished.]') && b.summary.includes('Second paragraph'), '无 summary 时退回 content');
});

test('① feed.read: JSON Feed 1.1', async () => {
  const p = mk(); const r = await call(p, FEED_READ, { url: `${base}/feed.json` });
  assert.ok(r.output, JSON.stringify(r)); assert.equal(r.output.kind, 'json'); assert.equal(r.output.title, 'My Example Feed'); assert.equal(r.output.items.length, 2);
  const [a, b] = r.output.items; assert.equal(a.link, 'https://example.org/second-item'); assert.equal(a.summary, 'This is a second item.'); assert.equal(a.published, '2010-02-07T19:04:00.000Z'); assert.deepEqual(a.categories, ['news', 'meta']);
  assert.equal(b.summary, 'Hello world summary', '默认取 summary'); assert.equal(b.author, 'Brent Simmons');
  const f = await call(p, FEED_READ, { url: `${base}/feed.json`, fullText: true }); assert.equal(f.output.items[1].summary, 'Hello, world!\nSecond paragraph.');
});

test('① feed.read: 重定向 ≤3 / 循环 / 转向内网 / 非 feed / 2MB', async () => {
  const p = mk(); const r = await call(p, FEED_READ, { url: `${base}/r1` }); assert.equal(r.output.title, 'Liftoff News'); assert.equal(r.output.url, `${base}/rss.xml`, 'url 为最终地址');
  const loop = await call(p, FEED_READ, { url: `${base}/loop` }); assert.match(loop.error.message, /too many redirects/);
  const nf = await call(p, FEED_READ, { url: `${base}/html` }); assert.match(nf.error.message, /not a recognizable/);
  const big = await call(p, FEED_READ, { url: `${base}/big` }); assert.match(big.error.message, /2MB/);
});

test('② hn.top: 排序保持、minScore、并发 ≤8、Ask HN 无 url 但有 hnUrl、null 条目跳过', async () => {
  const p = mk(); seen.hnItemCalls = 0; seen.hnMaxInflight = 0;
  const r = await call(p, HN_TOP, { limit: 10 }); assert.ok(r.output, JSON.stringify(r)); assert.equal(r.output.list, 'top');
  assert.deepEqual(r.output.items.map(i => i.id), [8863, 121003, 192327, 1000], '按榜单顺序、null 跳过');
  const drop = r.output.items[0]; assert.equal(drop.url, 'http://www.getdropbox.com/u/2/screencast.html'); assert.equal(drop.hnUrl, 'https://news.ycombinator.com/item?id=8863'); assert.equal(drop.score, 111); assert.equal(drop.by, 'dhouston'); assert.equal(drop.comments, 71); assert.equal(drop.time, '2007-04-04T19:16:40.000Z');
  const ask = r.output.items[1]; assert.equal(ask.url, undefined); assert.equal(ask.hnUrl, 'https://news.ycombinator.com/item?id=121003'); assert.equal(ask.title, 'Ask HN: The Arc Effect');
  assert.ok(seen.hnMaxInflight > 1 && seen.hnMaxInflight <= 8, `并发 ${seen.hnMaxInflight}`);
  const ms = await call(p, HN_TOP, { list: 'top', limit: 10, minScore: 30 }); assert.deepEqual(ms.output.items.map(i => i.id), [8863, 1000]);
  const lim = await call(p, HN_TOP, { limit: 1 }); assert.equal(lim.output.items.length, 1);
  const ask2 = await call(p, HN_TOP, { list: 'ask' }); assert.equal(ask2.output.list, 'ask'); assert.equal(ask2.output.items.length, 1);
  seen.hnItemCalls = 0; seen.hnMaxInflight = 0; const best = await call(p, HN_TOP, { list: 'best', limit: 3 }); assert.equal(best.output.items.length, 3); assert.ok(seen.hnItemCalls <= 16, `凑够就停：${seen.hnItemCalls}`); assert.ok(seen.hnMaxInflight <= 8);
  // 缓存：同参不再打远端
  const c = mk({ cacheTtlMs: 60000 }); seen.hnItemCalls = 0; await call(c, HN_TOP, { limit: 2 }); const n1 = seen.hnItemCalls; await call(c, HN_TOP, { limit: 2 }); assert.equal(seen.hnItemCalls, n1, '第二次命中缓存');
});

test('③ wiki.search: extract 截断、lang 拼进 URL、UA、summary 404 退回 snippet、空结果', async () => {
  const p = mk(); seen.wikiUA = []; seen.wikiPaths = [];
  const r = await call(p, WIKI_SEARCH, { q: 'Hacker News', lang: 'en', limit: 2, extractChars: 100 }); assert.ok(r.output, JSON.stringify(r));
  assert.equal(r.output.lang, 'en'); assert.equal(r.output.results.length, 2);
  const a = r.output.results[0]; assert.equal(a.title, 'Hacker News'); assert.equal(a.url, 'https://en.wikipedia.org/wiki/Hacker_News'); assert.equal(a.extract.length, 100); assert.ok(a.extract.startsWith('Hacker News (sometimes abbreviated as HN)')); assert.match(a.thumbnail, /^https:\/\/upload\.wikimedia\.org\//);
  const b = r.output.results[1]; assert.equal(b.extract, 'only snippet here', 'summary 404 → snippet 去标签'); assert.equal(b.url, `${base}/en/wiki/No_Summary_Page`); assert.equal(b.thumbnail, undefined);
  assert.ok(seen.wikiPaths.some(x => x.startsWith('/en/w/api.php?') && x.includes('srsearch=Hacker%20News') && x.includes('srlimit=2')), seen.wikiPaths.join('\n'));
  assert.ok(seen.wikiPaths.includes('/en/api/rest_v1/page/summary/Hacker_News'));
  assert.ok(seen.wikiUA.length >= 3 && seen.wikiUA.every(ua => ua === 'cak-open-sources/0.1 (+https://github.com/theyuyan/cak)'), JSON.stringify(seen.wikiUA));
  const zh = await call(p, WIKI_SEARCH, { q: 'x' }); assert.equal(zh.output.lang, 'zh'); assert.ok(seen.wikiPaths.some(x => x.startsWith('/zh/w/api.php')));
  const hans = await call(p, WIKI_SEARCH, { q: 'x', lang: 'zh-hans' }); assert.equal(hans.output.lang, 'zh-hans');
  const empty = await call(p, WIKI_SEARCH, { q: 'nothing-here', lang: 'en' }); assert.deepEqual(empty.output.results, []);
  const badLang = await call(p, WIKI_SEARCH, { q: 'x', lang: 'en/../x' }); assert.equal(badLang.error.code, 'CAPABILITY_ERROR');
});

test('④ arxiv.search: 解析（id 抠版本、多作者、pdfUrl、分类主在前、summary ≤2000）、API 错误、节流', async () => {
  const p = mk(); seen.arxivTimes = []; seen.arxivQueries = [];
  const r = await call(p, ARXIV_SEARCH, { q: 'all:electron', limit: 2, sortBy: 'submittedDate' }); assert.ok(r.output, JSON.stringify(r)); assert.equal(r.output.q, 'all:electron'); assert.equal(r.output.results.length, 2);
  const [a, b] = r.output.results;
  assert.equal(a.id, 'hep-ex/0307015'); assert.equal(a.title, 'Multi-Electron Production at High Transverse Momenta in ep Collisions at HERA'); assert.deepEqual(a.authors, ['H1 Collaboration']); assert.equal(a.published, '2003-07-07T17:46:39.000Z'); assert.equal(a.pdfUrl, 'http://arxiv.org/pdf/hep-ex/0307015v1'); assert.equal(a.absUrl, 'http://arxiv.org/abs/hep-ex/0307015v1'); assert.deepEqual(a.categories, ['hep-ex']); assert.ok(a.summary.startsWith('Multi-electron production is studied'));
  assert.equal(b.id, '2401.01234'); assert.deepEqual(b.authors, ['Alice Author', 'Bob Builder', 'Carol Coder']); assert.deepEqual(b.categories, ['cs.AI', 'cs.MA']); assert.equal(b.pdfUrl, 'http://arxiv.org/pdf/2401.01234v2'); assert.equal(b.updated, '2024-02-01T00:00:00.000Z'); assert.equal(b.summary.length, 2000);
  assert.ok(seen.arxivQueries[0].includes('search_query=all%3Aelectron') && seen.arxivQueries[0].includes('max_results=2') && seen.arxivQueries[0].includes('sortBy=submittedDate'), seen.arxivQueries[0]);
  const bad = await call(p, ARXIV_SEARCH, { q: 'bad' }); assert.equal(bad.error.code, 'CAPABILITY_ERROR'); assert.match(bad.error.message, /incorrect id format/);
  // 节流：注入 100ms，三次连续调用（并发发起）两两间隔 ≥ 100ms
  seen.arxivTimes = []; await Promise.all([call(p, ARXIV_SEARCH, { q: 'a' }), call(p, ARXIV_SEARCH, { q: 'b' }), call(p, ARXIV_SEARCH, { q: 'c' })]);
  assert.equal(seen.arxivTimes.length, 3); for (let i = 1; i < 3; i++) assert.ok(seen.arxivTimes[i] - seen.arxivTimes[i - 1] >= 95, `gap ${seen.arxivTimes[i] - seen.arxivTimes[i - 1]}ms`);
});

test('⑤ 内网 URL 拒绝 / 非 2xx / 超时 → CAPABILITY_ERROR', async () => {
  const strict = new OpenSourcesProvider({ cacheTtlMs: 0 });
  for (const url of ['http://127.0.0.1:1/x', 'http://localhost/feed', 'http://10.0.0.1/rss', 'http://192.168.1.1/a', 'http://169.254.169.254/latest', 'http://[::1]/x']) { const r = await call(strict, FEED_READ, { url }); assert.equal(r.error?.code, 'CAPABILITY_ERROR', url); assert.match(r.error.message, /private|loopback/); assert.equal(r.error.retryable, false); }
  const semi = new OpenSourcesProvider({ cacheTtlMs: 0, allowPrivate: false, fetchImpl: (u, o) => fetch(String(u).replace('http://example.invalid', base), o) });
  const red = await call(semi, FEED_READ, { url: 'http://example.invalid/to-private' }); assert.match(red.error.message, /private/, '重定向到内网也拒');
  const p = mk();
  const e5 = await call(p, FEED_READ, { url: `${base}/500` }); assert.equal(e5.error.code, 'CAPABILITY_ERROR'); assert.equal(e5.error.retryable, true); assert.match(e5.error.message, /500/);
  const e4 = await call(p, FEED_READ, { url: `${base}/404` }); assert.equal(e4.error.retryable, false);
  const hn5 = await call(mk({ hnUrl: `${base}/500` }), HN_TOP, {}); assert.equal(hn5.error.code, 'CAPABILITY_ERROR');
  const w5 = await call(mk({ wikiUrl: `${base}/500?x={lang}` }), WIKI_SEARCH, { q: 'x' }); assert.equal(w5.error.code, 'CAPABILITY_ERROR');
  const ax = await call(mk({ arxivUrl: `${base}/404` }), ARXIV_SEARCH, { q: 'x' }); assert.equal(ax.error.code, 'CAPABILITY_ERROR'); assert.equal(ax.error.retryable, false);
  const to = await call(mk({ timeoutMs: 200 }), FEED_READ, { url: `${base}/slow` }); assert.equal(to.error.code, 'CAPABILITY_ERROR'); assert.match(to.error.message, /timeout/); assert.equal(to.error.retryable, true);
  const dl = await mk({ timeoutMs: 5000 }).execute({ id: 'i', revision: 0, contract: FEED_READ, args: { url: `${base}/slow` }, handle: { id: 'h', contract: FEED_READ, caveats: [], delegable: true }, principal: [], digest: 'x', idempotencyKey: 'i' }, { principal: [], trace: { traceId: 't', spanId: 's' }, deadlineAtMs: Date.now() + 400 });
  assert.match(dl.error.message, /timeout/, 'ctx.deadlineAtMs 也约束超时');
});

test('⑥ 可选联网冒烟（OPEN_SOURCES_LIVE=1）', { skip: process.env.OPEN_SOURCES_LIVE !== '1' }, async () => {
  const p = new OpenSourcesProvider({ cacheTtlMs: 0, timeoutMs: 20000 }); const results = {};
  const f = await call(p, FEED_READ, { url: 'https://hnrss.org/frontpage', limit: 3 }); results.feed = f.error ? f.error : { kind: f.output.kind, n: f.output.items.length, first: f.output.items[0]?.title };
  const h = await call(p, HN_TOP, { limit: 3 }); results.hn = h.error ? h.error : { n: h.output.items.length, first: h.output.items[0]?.title };
  const w = await call(p, WIKI_SEARCH, { q: 'Hacker News', lang: 'en', limit: 1 }); results.wiki = w.error ? w.error : { n: w.output.results.length, first: w.output.results[0]?.title, extract: w.output.results[0]?.extract?.slice(0, 60) };
  const x = await call(p, ARXIV_SEARCH, { q: 'all:agent', limit: 2 }); results.arxiv = x.error ? x.error : { n: x.output.results.length, first: x.output.results[0]?.id };
  console.log('LIVE:', JSON.stringify(results, null, 1));
  for (const [k, v] of Object.entries(results)) assert.ok(!v.code, `${k}: ${v.message}`);
  assert.ok(results.feed.n > 0 && results.hn.n > 0 && results.wiki.n > 0 && results.arxiv.n > 0);
});

test.after(() => srv.close());
