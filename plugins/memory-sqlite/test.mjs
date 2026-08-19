import { test } from 'node:test'; import assert from 'node:assert/strict';
import { MemorySqliteProvider, SEARCH, WRITE } from './dist/provider.js';
const p = new MemorySqliteProvider(':memory:');
const call = (contract, args) => p.execute({ id: 'i', revision: 0, contract, args, handle: { id: 'h', contract, caveats: [], delegable: true }, principal: [], digest: 'x', idempotencyKey: 'i' }, { principal: [], trace: { traceId: 't', spanId: 's' } });
test('write (idempotent) → search ranks by relevance; namespaces isolate; empty query = recent', async () => {
  const w1 = await call(WRITE, { content: 'CAK 是一个 agent 内核，用 TypeScript 写', tags: ['cak', 'kernel'] }); assert.ok(w1.output.id);
  const w2 = await call(WRITE, { content: 'CAK 是一个 agent 内核，用 TypeScript 写', tags: ['cak', 'kernel'] }); assert.equal(w2.output.id, w1.output.id);
  await call(WRITE, { content: 'apples are red and sweet' }); await call(WRITE, { content: 'secret in other ns', namespace: 'other' });
  const s = await call(SEARCH, { query: 'agent kernel', limit: 5 }); assert.equal(s.output.items.length, 1); assert.match(s.output.items[0].content, /CAK/); assert.equal(s.output.items[0].cacheKey, w1.output.id);
  assert.equal((await call(SEARCH, { query: 'TypeScript', limit: 5 })).output.items.length, 1);
  assert.equal((await call(SEARCH, { query: 'secret' })).output.items.length, 0);
  assert.equal((await call(SEARCH, { query: 'secret', namespace: 'other' })).output.items.length, 1);
  assert.equal((await call(SEARCH, { query: '', limit: 10 })).output.items.length, 2);
  assert.equal((await call(SEARCH, { query: 'zzz-nothing' })).output.items.length, 0);
});
