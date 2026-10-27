import test from 'node:test';
import assert from 'node:assert/strict';
import { collaborationConnectSources } from '../src/core/collaboration-policy.mjs';

test('自定义AI接口允许HTTPS和本机HTTP，不开放任意HTTP源', () => {
  const sources = collaborationConnectSources().split(' ');
  assert.ok(!sources.includes('http:') && !sources.includes('*'));
  assert.ok(sources.includes('https:'));
  assert.ok(sources.includes('http://127.0.0.1:*'));
});

test('固定服务器白名单仅接收明确源地址，并限制在素材接口路径', () => {
  assert.ok(collaborationConnectSources('https://media.example.com,http://192.168.1.2:4182').includes('http://192.168.1.2:4182/collab/media/'));
  for (const value of ['https://*.example.com', 'https://user:pass@example.com', 'https://example.com/other', 'file:///tmp', 'https://example.com/?token=secret']) assert.throws(() => collaborationConnectSources(value));
});
