import { AgentSourceIndex } from '../core/agent-source.mjs';
import { checkAgentSignal } from '../core/agent-commands.mjs';
import { assetUrl } from '../core/asset-url.mjs';

export class AgentSourceReader {
  constructor(request = (url, options) => fetch(url, options)) { this.request = request; }
  async query(args, signal) {
    checkAgentSignal(signal);
    if (!this.index) {
      const response = await this.request(assetUrl('agent-source.json'), { signal });
      if (!response.ok) throw Error('当前构建的源码索引不可用，请重新构建或更新编辑器');
      const bundle = await response.json(); checkAgentSignal(signal); this.index = new AgentSourceIndex(bundle);
    }
    return this.index.query(args, signal);
  }
}
