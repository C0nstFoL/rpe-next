import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MicrophonePermissions } from '../desktop/microphone-permissions.mjs';

async function fixture(context, { platform = 'win32', system = 'granted', consent } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rpen-microphone-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'microphone.json'), opened = [];
  if (consent !== undefined) await writeFile(config, JSON.stringify(consent));
  const webContents = { getURL: () => 'rpe://app/?mods=off' }, handlers = {};
  const dependencies = { window: () => ({ webContents }), origin: 'rpe://app', systemPreferences: { getMediaAccessStatus: () => system }, shell: { openExternal: async url => opened.push(url) }, platform };
  const permissions = await new MicrophonePermissions(config, dependencies).initialize();
  permissions.install({ setPermissionCheckHandler: value => { handlers.check = value; }, setPermissionRequestHandler: value => { handlers.request = value; } });
  const request = (details, source = webContents) => { let response; handlers.request(source, 'media', value => { response = value; }, details); return response; };
  return { permissions, config, dependencies, webContents, handlers, request, opened };
}

test('首次录音必须明确授权，浏览器权限回调同步完成且不弹原生窗口', async context => {
  const { permissions, webContents, handlers, request } = await fixture(context);
  assert.equal(permissions.status().granted, false);
  assert.equal(handlers.check(webContents, 'media', 'rpe://app/', { mediaType: 'audio' }), false);
  assert.equal(request({ isMainFrame: true, mediaTypes: ['audio'] }), false);
  assert.equal((await permissions.request()).consent, false);
});

test('编辑器授权独立保存，重启后继承，字符串不被当成授权', async context => {
  const { permissions, config, dependencies } = await fixture(context);
  assert.equal((await permissions.request(true)).granted, true);
  assert.equal(JSON.parse(await readFile(config, 'utf8')), true);
  assert.equal((await new MicrophonePermissions(config, dependencies).initialize()).status().consent, true);
  await writeFile(config, '"true"');
  assert.equal((await new MicrophonePermissions(config, dependencies).initialize()).status().consent, false);
});

test('系统拒绝不被编辑器允许覆盖，隐私设置地址固定且可重新检查', async context => {
  const { permissions, dependencies, opened, request } = await fixture(context, { system: 'denied' });
  const status = await permissions.request(true);
  assert.equal(status.consent, true); assert.equal(status.blocked, true); assert.equal(status.granted, false);
  assert.equal(request({ mediaTypes: ['audio'] }), false);
  await permissions.openSettings(); assert.deepEqual(opened, ['ms-settings:privacy-microphone']);
  dependencies.systemPreferences.getMediaAccessStatus = () => 'granted';
  assert.equal(permissions.status().granted, true); assert.equal(request({ mediaTypes: ['audio'] }), true);
});

test('授权仅覆盖受信任主页面的音频，不允许视频或外部子页面', async context => {
  const { permissions, webContents, handlers, request } = await fixture(context, { consent: true });
  assert.equal(permissions.status().granted, true);
  assert.equal(handlers.check(webContents, 'media', 'rpe://app/', { mediaType: 'audio' }), true);
  assert.equal(handlers.check(webContents, 'media', 'rpe://app/', { mediaType: 'video' }), false);
  assert.equal(handlers.check(webContents, 'media', 'rpe://app/', {}), false);
  for (const details of [{ mediaTypes: ['video'] }, { mediaTypes: ['audio', 'video'] }, { mediaTypes: [] }, { mediaTypes: ['audio'], isMainFrame: false }, { mediaTypes: ['audio'], requestingUrl: 'https://outside.test/' }]) assert.equal(request(details), false);
  assert.equal(request({ mediaTypes: ['audio'] }, null), false);
  assert.equal(request({ mediaTypes: ['audio'] }, { getURL: () => 'rpe://app/' }), false);
  assert.equal(request({ mediaTypes: ['audio'], requestingUrl: 'rpe://app/' }), true);
});

test('macOS 的系统首次请求只发起一次，被拒绝时返回系统阻止状态', async context => {
  const { permissions, dependencies } = await fixture(context, { platform: 'darwin', system: 'not-determined', consent: true });
  let calls = 0, finish;
  dependencies.systemPreferences.askForMediaAccess = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = permissions.request(), second = permissions.request();
  assert.equal(calls, 1); finish(false);
  for (const status of await Promise.all([first, second])) { assert.equal(status.granted, false); assert.equal(status.blocked, true); }
});

test('未提供系统权限接口的平台仍要求编辑器同意，且不打开猜测的设置地址', async context => {
  const { permissions, opened } = await fixture(context, { platform: 'linux' });
  assert.equal(permissions.status().system, 'unknown'); assert.equal(permissions.status().granted, false);
  assert.equal((await permissions.request(true)).granted, true);
  assert.equal(await permissions.openSettings(), false); assert.deepEqual(opened, []);
});
