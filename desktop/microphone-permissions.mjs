import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export class MicrophonePermissions {
  constructor(configPath, { window, origin, systemPreferences, shell, platform = process.platform }) {
    Object.assign(this, { configPath, window, origin, systemPreferences, shell, platform });
    this.consent = false;
  }
  async initialize() {
    this.consent = await readFile(this.configPath, 'utf8').then(value => JSON.parse(value) === true).catch(() => false);
    return this;
  }
  status() {
    let system = 'unknown';
    if (['win32', 'darwin'].includes(this.platform)) {
      try { system = this.systemPreferences.getMediaAccessStatus('microphone'); } catch {}
    }
    const blocked = ['denied', 'restricted'].includes(system);
    return { consent: this.consent, system, blocked, granted: this.consent && !blocked, platform: this.platform, canOpenSettings: ['win32', 'darwin'].includes(this.platform) };
  }
  async request(approve = false) {
    if (!this.consent && approve === true) {
      const temporary = this.configPath + '.' + randomUUID();
      try { await writeFile(temporary, 'true', { flag: 'wx' }); await rename(temporary, this.configPath); this.consent = true; }
      finally { await rm(temporary, { force: true }); }
    }
    const status = this.status();
    if (status.consent && !status.blocked && this.platform === 'darwin' && status.system !== 'granted') {
      this.requesting ??= this.systemPreferences.askForMediaAccess('microphone').finally(() => { this.requesting = null; });
      const granted = await this.requesting;
      return { ...this.status(), granted, blocked: !granted };
    }
    return status;
  }
  async openSettings() {
    const url = this.platform === 'win32' ? 'ms-settings:privacy-microphone' : this.platform === 'darwin' ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone' : null;
    if (!url) return false;
    await this.shell.openExternal(url); return true;
  }
  trusted(webContents, details = {}) {
    return webContents === this.window()?.webContents && webContents?.getURL().startsWith(this.origin + '/') && details.isMainFrame !== false && (!details.requestingUrl || details.requestingUrl.startsWith(this.origin + '/'));
  }
  install(session) {
    session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details = {}) => {
      if (!this.trusted(webContents, details)) return false;
      return permission !== 'media' || this.status().granted && details.mediaType === 'audio';
    });
    session.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
      if (!this.trusted(webContents, details)) { callback(false); return; }
      if (permission !== 'media') { callback(true); return; }
      callback(this.status().granted && Boolean(details.mediaTypes?.length) && details.mediaTypes.every(type => type === 'audio'));
    });
  }
}
