// node --test test.mjs：只读白名单 + 真查询（SQLite）
import { test } from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import { createRequire } from 'node:module';
import { checkReadOnly, SqlQueryProvider } from './dist/provider.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const file = new URL('./demo.sqlite', import.meta.url).pathname;
test('demo db', () => { const db = new DatabaseSync(file); db.exec("create table if not exists people(id integer primary key, name text, city text); delete from people; insert into people(name,city) values ('Ada','London'),('Linus','Helsinki'),('Yuyan','Hefei')"); db.close(); });
test('read-only whitelist', () => {
  for (const ok of ["select 1", "with x as (select 1) select * from x", "explain select 1", "select count(*) from people where name like '%delete%'", "select \"update\" from people", "pragma table_info(people)"]) assert.equal(checkReadOnly(ok), undefined, ok);
  for (const bad of ["delete from people", "select 1; drop table people", "with x as (insert into people(name) values (1) returning *) select * from x", "select * into outfile '/tmp/x' from people", "select id into t2 from people", "explain delete from people", "pragma journal_mode=wal", "attach database 'x' as y", "update people set name='a'"]) assert.notEqual(checkReadOnly(bad), undefined, bad);
});
test('query, params, truncation, unknown alias, write rejected at execute', async () => {
  const p = new SqlQueryProvider({ connections: { demo: { driver: 'sqlite', file } } });
  const call = args => p.execute({ id: 'i', revision: 0, contract: { name: 'sql.query', version: '1.0.0', schemaDigest: 'x' }, args, handle: { id: 'h', contract: {}, caveats: [], delegable: true }, principal: [], digest: 'x', idempotencyKey: 'i' }, { principal: [], trace: { traceId: 't', spanId: 's' } });
  const r = await call({ db: 'demo', sql: 'select name, city from people where id > ? order by id', params: [1], maxRows: 1 });
  assert.deepEqual(r.output, { columns: ['name', 'city'], rows: [['Linus', 'Helsinki']], rowCount: 1, truncated: true });
  const all = await call({ db: 'demo', sql: 'select count(*) as n from people' }); assert.deepEqual(all.output.rows, [[3]]);
  assert.match((await call({ db: 'nope', sql: 'select 1' })).error.message, /unknown db alias/);
  assert.match((await call({ db: 'demo', sql: 'delete from people' })).error.message, /rejected/);
  const still = new DatabaseSync(file, { readOnly: true }); assert.equal(still.prepare('select count(*) n from people').get().n, 3); still.close();
});
