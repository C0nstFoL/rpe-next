import test from 'node:test';
import assert from 'node:assert/strict';
import { ResourceCache } from '../src/core/resource-cache.mjs';

test('资源缓存按总字节及数量淘汰最久未用项，替换和清空准确释放资源', () => {
  const disposed = [], cache = new ResourceCache({ maxBytes: 10, maxEntries: 2, dispose: value => disposed.push(value) });
  cache.set('first', 1, 4); cache.set('second', 2, 4); cache.get('first'); cache.set('third', 3, 4); assert.equal(cache.has('second'), false); assert.deepEqual(disposed, [2]); assert.equal(cache.bytes, 8);
  cache.set('first', 1, 5); assert.equal(cache.bytes, 9); assert.deepEqual(disposed, [2]); cache.set('fourth', 4, 6); assert.equal(cache.bytes, 6); assert.deepEqual(disposed, [2, 3, 1]);
  cache.clear(); assert.equal(cache.size, 0); assert.equal(cache.bytes, 0); assert.deepEqual(disposed, [2, 3, 1, 4]); assert.throws(() => cache.set('bad', 0, NaN), /无效/);
});

test('保留正在使用的资源；超限时淘汰其他项，取消保留后可正常回收', () => {
  let active = 'large'; const disposed = [], cache = new ResourceCache({ maxBytes: 5, maxEntries: 1, retain: value => value === active, dispose: value => disposed.push(value) });
  cache.set('active', 'large', 10); cache.set('other', 'small', 2); assert.equal(cache.peek('active'), 'large'); assert.equal(cache.has('other'), false); assert.deepEqual(disposed, ['small']);
  active = null; cache.trim(); assert.equal(cache.size, 0); assert.deepEqual(disposed, ['small', 'large']);
});
