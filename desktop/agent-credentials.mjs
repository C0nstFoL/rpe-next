import { readFile } from 'node:fs/promises';

const validProvider = value => typeof value === 'string' && /^[a-z][a-z0-9_.-]{0,63}$/.test(value);

export class AgentCredentialVault {
  constructor(file, { safeStorage, writeJson, platform = process.platform }) { Object.assign(this, { file, safeStorage, writeJson, platform }); this.queue = Promise.resolve(); }
  run(operation) { const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result; }
  async record() {
    let value; try { value = JSON.parse(await readFile(this.file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return { version: 1, providers: {} }; throw error; }
    if (value?.version !== 1 || !value.providers || typeof value.providers !== 'object' || Array.isArray(value.providers) || Object.keys(value.providers).length > 64 || Object.entries(value.providers).some(([provider, key]) => !validProvider(provider) || typeof key !== 'string' || key.length > 8192)) throw Error('本机API凭据文件格式无效');
    return value;
  }
  async available() {
    if (!await this.safeStorage.isAsyncEncryptionAvailable() || this.platform === 'linux' && this.safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw Error('系统暂时无法加密保存API Key，可关闭“记住API Key”后仅本次使用');
  }
  read(provider) {
    if (!validProvider(provider)) return Promise.reject(Error('AI服务标识无效'));
    return this.run(async () => {
      const record = await this.record(); if (!Object.hasOwn(record.providers, provider)) return '';
      await this.available();
      const decoded = await this.safeStorage.decryptStringAsync(Buffer.from(record.providers[provider], 'base64'));
      if (typeof decoded.result !== 'string') throw Error('API Key解密失败');
      if (decoded.shouldReEncrypt) { record.providers = { ...record.providers, [provider]: (await this.safeStorage.encryptStringAsync(decoded.result)).toString('base64') }; await this.writeJson(this.file, record); }
      return decoded.result;
    });
  }
  write(provider, key) {
    if (!validProvider(provider) || typeof key !== 'string' || key.length > 1000 || /[\r\n]/.test(key)) return Promise.reject(Error('AI服务或API Key格式无效'));
    const operation = this.run(async () => {
      const record = await this.record();
      if (!key) { if (!Object.hasOwn(record.providers, provider)) return; record.providers = { ...record.providers }; delete record.providers[provider]; }
      else { await this.available(); record.providers = { ...record.providers, [provider]: (await this.safeStorage.encryptStringAsync(key)).toString('base64') }; }
      await this.writeJson(this.file, record);
    });
    this.lastWrite = operation; return operation;
  }
  async flush() { await this.queue; await this.lastWrite; }
}

export function installAgentCredentials({ ipcMain, vault, origin, window: getWindow }) {
  ipcMain.handle('rpen-agent-credentials', async (event, { action, provider, key } = {}) => {
    try {
      if (event.sender !== getWindow()?.webContents || event.senderFrame !== event.sender.mainFrame || !event.senderFrame.url.startsWith(origin + '/')) throw Error('无权限');
      if (action === 'read') return { ok: true, result: await vault.read(provider) };
      if (action !== 'write') throw Error('不支持的凭据操作');
      await vault.write(provider, key); return { ok: true, result: true };
    } catch (error) { return { ok: false, message: error.message }; }
  });
}
