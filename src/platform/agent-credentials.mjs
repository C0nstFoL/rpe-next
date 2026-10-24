const validate = provider => { if (typeof provider !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(provider)) throw Error('AI服务标识无效'); };

export class AgentCredentials {
  constructor({ bridge = globalThis.rpenAgentCredentials, database = globalThis.indexedDB } = {}) { this.bridge = bridge?.version === 1 ? bridge : null; this.database = database; }
  async open() {
    if (!this.database) throw Error('浏览器无法保存API Key，可关闭“记住API Key”后仅本次使用');
    return new Promise((resolve, reject) => {
      const request = this.database.open('rpe-next-agent-credentials', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('keys');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(Error('浏览器未能打开API凭据存储'));
      request.onblocked = () => reject(Error('API凭据存储被其他页面占用'));
    });
  }
  async read(provider) {
    validate(provider);
    if (this.bridge) { const response = await this.bridge.read(provider); if (!response.ok) throw Error(response.message); return response.result || ''; }
    const database = await this.open();
    try { return await new Promise((resolve, reject) => { const transaction = database.transaction('keys', 'readonly'), request = transaction.objectStore('keys').get(provider); request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : ''); transaction.onerror = () => reject(Error('API Key读取失败')); transaction.onabort = () => reject(Error('API Key读取已取消')); }); }
    finally { database.close(); }
  }
  async write(provider, key) {
    validate(provider); if (typeof key !== 'string' || key.length > 1000 || /[\r\n]/.test(key)) throw Error('API Key格式无效');
    if (this.bridge) { const response = await this.bridge.write(provider, key); if (!response.ok) throw Error(response.message); return; }
    if (!key && !this.database) return;
    const database = await this.open();
    try { await new Promise((resolve, reject) => { const transaction = database.transaction('keys', 'readwrite'), store = transaction.objectStore('keys'); if (key) store.put(key, provider); else store.delete(provider); transaction.oncomplete = resolve; transaction.onerror = () => reject(Error('API Key保存失败')); transaction.onabort = () => reject(Error('API Key保存已取消')); }); }
    finally { database.close(); }
  }
}
