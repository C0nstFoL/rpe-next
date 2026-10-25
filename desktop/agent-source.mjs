import { readFile, readdir, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { AGENT_SOURCE_ROOTS, AGENT_SOURCE_FILES, isAgentSourcePath } from '../src/core/agent-source.mjs';

export async function createAgentSourceBundle(directory) {
  const root = await realpath(directory), files = [];
  const read = async path => {
    if (!isAgentSourcePath(path)) return;
    const filename = await realpath(resolve(root, path)); if (!filename.startsWith(root + sep)) throw Error('源码文件超出程序目录');
    files.push({ path, text: await readFile(filename, 'utf8') });
  };
  const walk = async path => {
    let entries; try { entries = await readdir(resolve(root, path), { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const child = path + '/' + entry.name;
      if (entry.isDirectory()) await walk(child); else if (entry.isFile()) await read(child);
    }
  };
  for (const path of AGENT_SOURCE_ROOTS) await walk(path);
  for (const path of AGENT_SOURCE_FILES) try { await read(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const metadata = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  return { format: 'rpen-agent-source', version: 1, editorVersion: metadata.version, files: files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0) };
}
