import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from '../src/core/vendor/acorn.mjs';
import { EDITOR_PACKAGE_SOURCES, SERVER_PACKAGE_SOURCES } from '../tools/package-sources.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const included = (sources, file) => sources.some(path => file === path || file.startsWith(path + '/'));

async function dependencies(sources, entry, files = new Map()) {
  if (files.has(entry)) return files;
  assert.ok(included(sources, entry), 'Missing packaged dependency: ' + entry);
  const source = await readFile(join(root, entry), 'utf8'); files.set(entry, source);
  if (!entry.endsWith('.mjs')) return files;
  for (const statement of parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body) {
    const specifier = statement.source?.value; if (typeof specifier !== 'string' || !specifier.startsWith('.')) continue;
    const target = relative(root, resolve(root, dirname(entry), specifier)).replaceAll('\\', '/'); assert.ok(!target.startsWith('../') && !isAbsolute(target));
    await dependencies(sources, target, files);
  }
  return files;
}

test('桌面和正式发布共用源文件清单，两类包均包含翻译引擎及语言文件', async () => {
  for (const sources of [EDITOR_PACKAGE_SOURCES, SERVER_PACKAGE_SOURCES]) {
    for (const file of ['src/i18n.mjs', 'src/core/i18n-core.mjs', 'src/locales/zh-CN.mjs', 'src/locales/en-US.mjs']) assert.ok(included(sources, file), file);
    assert.ok(sources.every(path => !/\.local-tools|node_modules|DESKTOP-STORAGE|OFFICIAL-IMPORT/.test(path)));
  }
  for (const [file, key] of [['tools/build-desktop.mjs', 'EDITOR_PACKAGE_SOURCES'], ['tools/build-collaboration-server.mjs', 'SERVER_PACKAGE_SOURCES'], ['tools/build-release.mjs', 'SERVER_PACKAGE_SOURCES']]) {
    const source = await readFile(join(root, file), 'utf8'); assert.ok(source.includes("from './package-sources.mjs'")); assert.ok(source.includes(key));
  }
});

test('正式发布编辑器和服务端的静态导入依赖闭合，独立目录可解析谱面并切换语言', async context => {
  const scratch = await mkdtemp(join(tmpdir(), 'rpen-package-source-')); context.after(() => rm(scratch, { recursive: true, force: true }));
  for (const [kind, sources, entry] of [['editor', EDITOR_PACKAGE_SOURCES, 'src/ui/app.mjs'], ['server', SERVER_PACKAGE_SOURCES, 'collaboration-server/server.mjs']]) {
    const files = await dependencies(sources, entry), destination = join(scratch, kind);
    assert.ok(files.has('src/locales/en-US.mjs')); assert.ok(files.has('src/i18n.mjs'));
    for (const [path, source] of files) { await mkdir(dirname(join(destination, path)), { recursive: true }); await writeFile(join(destination, path), source); }
    const script = `import {setLocale,t} from './src/i18n.mjs'; import {createChart,serializeChart,parseChart} from './src/core/chart.mjs'; setLocale('en-GB'); if(t('settings.language')!=='Interface language')throw Error('locale fallback'); const chart=parseChart(serializeChart(createChart())); if(chart.judgeLineList.length!==1)throw Error('chart'); console.log('ok');`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: destination, windowsHide: true, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'ok');
  }
});
