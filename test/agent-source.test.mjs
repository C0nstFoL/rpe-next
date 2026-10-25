import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentSourceIndex, isAgentSourcePath } from '../src/core/agent-source.mjs';
import { AgentSourceReader } from '../src/platform/agent-source.mjs';
import { createAgentSourceBundle } from '../desktop/agent-source.mjs';
import { AgentCommands } from '../src/core/agent-commands.mjs';
import { createAgentEditorCommands } from '../src/application/agent-editor.mjs';

const bundle = files => ({ format: 'rpen-agent-source', version: 1, editorVersion: 'test', files });

test('源码收集仅包含程序源码、公开协议和内置模组，不接触本地凭据、谱面或排除的文档', async context => {
  const root = await mkdtemp(join(tmpdir(), 'rpen-agent-source-'));
  context.after(async () => { assert.ok(root.startsWith(join(tmpdir(), 'rpen-agent-source-'))); await rm(root, { recursive: true, force: true }); });
  const files = { 'package.json': '{"version":"test"}', 'src/core/example.mjs': 'export const value = 1;', 'desktop/main.cjs': 'module.exports = 1;', 'assets/mods/test/main.mjs': 'export default {};', 'protocols/AI-AGENT-PROTOCOL.zh-CN.md': '# Public protocol', '.local-tools/deepseek-test-key.txt': 'private-key-fixture', 'protocols/DESKTOP-STORAGE.zh-CN.md': 'local document', 'chart.json': 'private chart', 'src/core/private.json': 'not source', 'OFFICIAL-IMPORT.zh-CN.md': 'local document' };
  for (const [path, text] of Object.entries(files)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text); }
  const result = await createAgentSourceBundle(root), paths = result.files.map(entry => entry.path);
  assert.deepEqual(paths, ['assets/mods/test/main.mjs', 'desktop/main.cjs', 'package.json', 'protocols/AI-AGENT-PROTOCOL.zh-CN.md', 'src/core/example.mjs']);
  assert.ok(!JSON.stringify(result).includes('private-key-fixture')); assert.ok(paths.every(isAgentSourcePath));
  const actual = await createAgentSourceBundle(fileURLToPath(new URL('../', import.meta.url)));
  for (const path of ['src/core/curve-trajectory.mjs', 'src/ui/app.mjs', 'desktop/main.cjs', 'styles.css', 'schemas/mod-api-v1.d.ts']) assert.ok(actual.files.some(entry => entry.path === path), path);
});

test('源码支持文件分页、字面搜索、准确行号及超长行无遗漏续读，不执行源文本', async () => {
  const source = 'First [.*] token\n' + 'x'.repeat(20000) + '\nlast TOKEN', index = new AgentSourceIndex(bundle([{ path: 'src/core/example.mjs', text: source }, { path: 'styles.css', text: 'token' }]));
  const listed = await index.query({ action: 'list', query: 'example', limit: 1 }); assert.equal(listed.files[0].path, 'src/core/example.mjs'); assert.equal(listed.total, 1);
  const matches = await index.query({ action: 'search', query: 'TOKEN', limit: 1 }); assert.equal(matches.total, 3); assert.equal(matches.matches[0].line, 1); assert.equal(matches.nextOffset, 1);
  const literal = await index.query({ action: 'search', query: '[.*]' }); assert.equal(literal.total, 1); assert.equal(literal.matches[0].column, 7);
  const exact = await index.query({ action: 'search', query: 'TOKEN', caseSensitive: true }); assert.equal(exact.total, 1); assert.equal(exact.matches[0].line, 3);
  const first = await index.query({ action: 'read', path: 'src/core/example.mjs', startLine: 2, lineCount: 1 }); assert.equal(first.lines[0].text.length, 16000); assert.deepEqual(first.next, { startLine: 2, startColumn: 16001 });
  const rest = await index.query({ action: 'read', path: 'src/core/example.mjs', ...first.next }); assert.equal(first.lines[0].text + rest.lines[0].text, 'x'.repeat(20000)); assert.equal(rest.lines[1].line, 3); assert.equal(rest.next, null);
});

test('源码拒绝路径逃逸与非源码内容，停止后不继续请求，失败可重试且成功后复用索引', async () => {
  for (const path of ['../package.json', '/src/core/a.mjs', 'C:/secret', 'src/core/../private.mjs', 'src/core/%2e%2e/key', '.local-tools/key.txt', 'protocols/DESKTOP-STORAGE.zh-CN.md']) assert.equal(isAgentSourcePath(path), false);
  assert.throws(() => new AgentSourceIndex(bundle([{ path: '.local-tools/key.txt', text: 'secret' }])), /无效文件/);
  const index = new AgentSourceIndex(bundle([{ path: 'styles.css', text: 'data' }]));
  await assert.rejects(index.query({ action: 'read', path: '../styles.css' }), /相对路径/);
  await assert.rejects(index.query({ action: 'read', path: 'src/core/missing.mjs' }), /索引/);
  let requests = 0; const reader = new AgentSourceReader(async (url, { signal }) => { assert.ok(url.endsWith('/assets/agent-source.json')); requests++; return requests === 1 ? { ok: false } : { ok: true, json: async () => bundle([{ path: 'styles.css', text: 'token' }]) }; });
  await assert.rejects(reader.query({}), /索引不可用/); await reader.query({}); await reader.query({ action: 'search', query: 'token' }); assert.equal(requests, 2);
  const controller = new AbortController(); controller.abort(); await assert.rejects(reader.query({}, controller.signal), { name: 'AbortError' }); assert.equal(requests, 2);
});

test('源码工具在三种权限下均只读免审批，不依赖谱面文件、不暴露任意文件读取', async () => {
  const commands = new AgentCommands(), source = new AgentSourceIndex(bundle([{ path: 'src/core/example.mjs', text: 'const source = 1;' }]));
  createAgentEditorCommands(commands, {}, { source });
  for (const permission of ['ask', 'dangerous', 'full']) {
    const result = await commands.execute('editor_source', { action: 'read', path: 'src/core/example.mjs' }, { permission, approve: () => assert.fail('源码查询不应审批') });
    assert.equal(result.result.lines[0].line, 1); assert.equal(result.result.lines[0].text, 'const source = 1;');
  }
  await assert.rejects(commands.execute('editor_source', { action: 'read', path: '.local-tools/deepseek-test-key.txt' }), /索引/);
});
