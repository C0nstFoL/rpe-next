import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AgentCredentialVault, installAgentCredentials } from '../desktop/agent-credentials.mjs';
import { AgentCredentials } from '../src/platform/agent-credentials.mjs';

async function fixture(context, { platform = process.platform } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rpen-credentials-')); context.after(() => rm(root, { recursive: true, force: true }));
  const secret = randomBytes(32), safeStorage = { isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async text => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secret, iv), body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]); },
    decryptStringAsync: async bytes => { const decipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return { result: Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'), shouldReEncrypt: false }; } };
  const file = join(root, 'agent-credentials.json'), options = { safeStorage, platform, writeJson: (path, value) => writeFile(path, JSON.stringify(value)) };
  return { file, options, vault: new AgentCredentialVault(file, options) };
}

test('桌面凭据独立加密保存、重启读取、多服务隔离、覆盖和清除；并发写入不丢失', async context => {
  const { file, options, vault } = await fixture(context); assert.equal(await vault.read('deepseek'), '');
  await Promise.all([vault.write('deepseek', 'test-private-alpha'), vault.write('other', 'test-private-beta')]); await vault.flush();
  const text = await readFile(file, 'utf8'); assert.ok(!text.includes('test-private-alpha')); assert.ok(!text.includes('test-private-beta'));
  const restarted = new AgentCredentialVault(file, options); assert.equal(await restarted.read('deepseek'), 'test-private-alpha'); assert.equal(await restarted.read('other'), 'test-private-beta');
  await restarted.write('deepseek', 'test-replacement'); assert.equal(await vault.read('deepseek'), 'test-replacement');
  await restarted.write('deepseek', ''); assert.equal(await vault.read('deepseek'), ''); assert.equal(await vault.read('other'), 'test-private-beta');
  await assert.rejects(vault.write('../escape', 'test'), /标识|格式/); await assert.rejects(vault.write('deepseek', 'test\ninvalid'), /格式/);
});

for (const platform of ['win32', 'darwin', 'linux']) test(`系统加密不可用时拒绝保存，删除不要求解密，失败后可恢复且密钥轮换会重新加密（${platform}）`, async context => {
  const { file, options, vault } = await fixture(context, { platform }); await vault.write('deepseek', 'test-key');
  options.safeStorage.isAsyncEncryptionAvailable = async () => false;
  await assert.rejects(vault.write('other', 'test'), /加密/); await assert.rejects(vault.flush(), /加密/);
  await vault.write('deepseek', ''); await vault.flush(); assert.equal(await vault.read('deepseek'), '');
  options.safeStorage.isAsyncEncryptionAvailable = async () => true; const backend = options.safeStorage.getSelectedStorageBackend; options.safeStorage.getSelectedStorageBackend = () => 'basic_text';
  const linux = new AgentCredentialVault(file, { ...options, platform: 'linux' }); await assert.rejects(linux.write('deepseek', 'test'), /加密/);
  options.safeStorage.getSelectedStorageBackend = backend;
  await vault.write('deepseek', 'test-key'); const before = await readFile(file, 'utf8'), decrypt = options.safeStorage.decryptStringAsync;
  options.safeStorage.decryptStringAsync = async bytes => ({ ...await decrypt(bytes), shouldReEncrypt: true });
  assert.equal(await vault.read('deepseek'), 'test-key'); assert.notEqual(await readFile(file, 'utf8'), before);
});

test('凭据IPC只接受当前主窗口和主框架，网页平台无桌面桥时不提供任意磁盘操作', async context => {
  const { vault } = await fixture(context), handlers = new Map(), webContents = { mainFrame: { url: 'rpe://app/' } }, event = { sender: webContents, senderFrame: webContents.mainFrame };
  installAgentCredentials({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, vault, origin: 'rpe://app', window: () => ({ webContents }) });
  const handler = handlers.get('rpen-agent-credentials');
  assert.equal((await handler({ sender: {}, senderFrame: {} }, { action: 'read', provider: 'deepseek' })).ok, false);
  assert.equal((await handler({ ...event, senderFrame: { url: 'rpe://app/' } }, { action: 'read', provider: 'deepseek' })).ok, false);
  assert.equal((await handler(event, { action: 'write', provider: 'deepseek', key: 'test-private' })).ok, true);
  assert.equal((await handler(event, { action: 'read', provider: 'deepseek' })).result, 'test-private');
  assert.equal((await handler(event, { action: 'file', provider: 'deepseek' })).ok, false);
  const bridge = { version: 1, read: provider => handler(event, { action: 'read', provider }), write: (provider, key) => handler(event, { action: 'write', provider, key }) };
  const credentials = new AgentCredentials({ bridge }); assert.equal(await credentials.read('deepseek'), 'test-private'); await credentials.write('deepseek', ''); assert.equal(await credentials.read('deepseek'), '');
  const unavailable = new AgentCredentials({ bridge: null, database: null }); await assert.rejects(unavailable.write('deepseek', 'test'), /浏览器/); await unavailable.write('deepseek', '');
});
