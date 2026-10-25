import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function smokeAgent(contents, { userData, phase = 'save' }) {
  if (phase.startsWith('upgrade')) return (await import('./smoke-agent-upgrade.mjs')).smokeAgentUpgrade(contents, { userData, restart: phase === 'upgrade-restart' });
  const key = 'rpen-credential-test-only-not-a-real-api-key';
  const result = await contents.executeJavaScript(`(async () => {
    const check = (value, message) => { if (!value) throw Error(message); };
    const until = async condition => { const end = performance.now() + 15000; while (!await condition()) { if (performance.now() > end) throw Error('Agent test startup timeout'); await new Promise(resolve => setTimeout(resolve, 30)); } };
    await until(() => window.rpenMods?.editor);
    const editor = window.rpenMods.editor; await editor.agent.ready; document.querySelector('#new').click(); await editor.agent.ready; editor.agent.open();
    const open = async () => { document.querySelector('#ai-panel .agent-heading button').click(); await until(() => document.querySelector('#ai-config[open]')); return document.querySelector('#ai-config'); };
    const apply = async dialog => { dialog.querySelector('button[type=submit]').click(); await until(() => !dialog.open || Boolean(dialog.querySelector('.agent-error').textContent)); check(!dialog.open, dialog.querySelector('.agent-error').textContent); };
    const { AgentCredentials } = await import('/src/platform/agent-credentials.mjs'), { localPreferences } = await import('/src/platform/local-preferences.mjs');
    const credentials = new AgentCredentials(), fixture = ${JSON.stringify(key)}, checks = [];
    let dialog = await open();
    check(Boolean(dialog.querySelector('[aria-label="每任务最大模型请求轮数"]')) && !dialog.querySelector('[aria-label="每任务工具循环上限"]'), 'Model round setting name mismatch');
    check(dialog.querySelector('[aria-label="记住 API Key"]').checked, 'Remember key default missing');
    if (${JSON.stringify(phase)} === 'save') {
      check(dialog.querySelector('input[type=password]').value === '', 'Fresh profile unexpectedly has credentials');
      dialog.querySelector('input[type=password]').value = fixture; dialog.querySelector('[aria-label="每任务最大模型请求轮数"]').value = '32'; await apply(dialog);
      check(await credentials.read('deepseek') === fixture, 'Credential save failed');
      checks.push('desktop key stored with native encryption and model-round setting uses clear name');
    } else {
      check(dialog.querySelector('input[type=password]').value === fixture, 'Desktop restart did not restore API key');
      check(dialog.querySelector('[aria-label="每任务最大模型请求轮数"]').value === '32', 'Desktop restart did not restore model-round setting');
      checks.push('full application restart restores saved API key and model-round setting');
      dialog.querySelector('[aria-label="记住 API Key"]').checked = false; await apply(dialog); check(await credentials.read('deepseek') === '', 'Disabling remember did not erase saved key');
      dialog = await open(); check(dialog.querySelector('input[type=password]').value === fixture, 'Session-only key lost before restart');
      dialog.querySelector('[aria-label="记住 API Key"]').checked = true; await apply(dialog); check(await credentials.read('deepseek') === fixture, 'Re-enable remember failed');
      dialog = await open(); [...dialog.querySelectorAll('button')].find(button => button.textContent === '清除已保存的 Key').click();
      await until(() => ![...dialog.querySelectorAll('button')].find(button => button.textContent === '清除已保存的 Key').disabled);
      check(await credentials.read('deepseek') === '' && dialog.querySelector('input[type=password]').value === '', 'Clear key failed'); dialog.querySelector('.agent-heading button').click();
      dialog = await open(); check(dialog.querySelector('input[type=password]').value === '', 'Cleared key remains in memory');
      dialog.querySelector('input[type=password]').value = 'unsaved-test-value'; dialog.querySelector('.agent-heading button').click(); dialog = await open(); check(dialog.querySelector('input[type=password]').value === '', 'Closing configuration saved unsubmitted key');
      dialog.querySelector('.agent-heading button').click(); checks.push('disable remember deletes stored key but retains session value; clear removes both saved and session values; cancel preserves saved state');
    }
    check(!localPreferences.getItem('rpe-next-agent-v1').includes(fixture) && !JSON.stringify(localStorage).includes(fixture), 'Credential leaked to normal preferences');
    const inspected = await editor.agent.commands.execute('ui_inspect', {}, { permission: 'full' }); check(!JSON.stringify(inspected).includes(fixture), 'Credential leaked through editor tools');
    check(typeof require === 'undefined' && Boolean(window.rpenAgentCredentials), 'Sandbox or credential bridge missing');
    await window.rpenFlushPreferences?.(); return { phase: ${JSON.stringify(phase)}, checks, noNode: typeof require === 'undefined', keyExcludedFromPreferences: true };
  })()`);
  const raw = await readFile(resolve(userData, 'agent-credentials.json'), 'utf8');
  if (raw.includes(key)) throw Error('Desktop credential file contains plaintext API key');
  const record = JSON.parse(raw);
  if (phase === 'save' && !record.providers.deepseek || phase !== 'save' && record.providers.deepseek) throw Error('Desktop credential file save/clear state incorrect');
  return { ...result, encryptedAtRest: true };
}
