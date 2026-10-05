export type LockAppState = 'active' | 'inactive' | 'background' | 'unknown';
export type AppLockState = {
  loaded: boolean; enabled: boolean | null; locked: boolean; authenticating: boolean;
  saving: boolean; opened: boolean; coverPresented: boolean; appState: LockAppState; error: string | null;
};
export type AppLockAdapter = {
  read(): Promise<string | null>; write(value: string): Promise<void>;
  authenticate(): Promise<boolean>;
};
const ON = 'enabled-v1', OFF = 'disabled-v1';

/** Device-wide UI policy, independent of account credentials and SQLite data.
 * Backgrounding invalidates authentication; an OS authentication prompt's
 * inactive transition conceals the screen without invalidating its own proof.
 */
export class AppLockController {
  private revision = 0;
  private busy = false;
  private listeners = new Set<() => void>();
  private value: AppLockState;
  private adapter: AppLockAdapter;
  constructor(adapter: AppLockAdapter, appState: LockAppState = 'active') {
    this.adapter = adapter;
    this.value = { loaded: false, enabled: null, locked: true, authenticating: false,
      saving: false, opened: false, coverPresented: appState === 'active', appState, error: null };
  }
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<AppLockState>) {
    this.value = { ...this.value, ...patch };
    const visible = this.value.loaded && this.value.appState === 'active' && (this.value.enabled === false || this.value.enabled === true && !this.value.locked);
    // Keep an existing lock modal underneath an OS authentication prompt.
    // Dismissing it on that prompt's inactive event can expose a native editor.
    if (this.value.appState === 'active') this.value = { ...this.value, coverPresented: !visible };
    if (visible) {
      this.value = { ...this.value, opened: true };
    }
    for (const listener of this.listeners) listener();
  }
  lifecycle(appState: LockAppState) {
    if (appState !== 'active' && (appState !== 'inactive' || !this.value.authenticating)) {
      this.revision++;
      this.update({ appState, locked: true });
    } else this.update({ appState });
  }
  private async readPolicy() {
    this.update({ loaded: false, enabled: null, locked: true, error: null });
    try {
      const raw = await this.adapter.read();
      if (raw !== null && raw !== ON && raw !== OFF) throw new Error('Invalid lock setting');
      const enabled = raw === ON;
      this.update({ loaded: true, enabled, locked: enabled, error: null });
    } catch {
      this.update({ loaded: false, enabled: null, locked: true,
        error: 'Could not read the lock setting. Unlock this device and retry. Your saved data has been kept.' });
    }
  }
  async load() {
    if (this.busy) return;
    this.busy = true;
    try { await this.readPolicy(); } finally { this.busy = false; }
  }
  private async proof() {
    const revision = this.revision;
    this.update({ authenticating: true, error: null });
    try {
      const success = await this.adapter.authenticate();
      if (!success || revision !== this.revision || this.value.appState === 'background' || this.value.appState === 'unknown') {
        this.update({ error: success ? 'Unlock again after returning to Everclose.' : 'Authentication was cancelled or unsuccessful.' });
        return null;
      }
      return revision;
    } catch {
      this.update({ error: 'Device authentication is unavailable. Try again using Face ID, Touch ID or your device passcode.' });
      return null;
    } finally { this.update({ authenticating: false }); }
  }
  async unlock() {
    if (this.busy || !this.value.loaded || !this.value.enabled || this.value.appState !== 'active') return false;
    if (!this.value.locked) return true;
    this.busy = true;
    try {
      const proof = await this.proof();
      if (proof === null || proof !== this.revision || this.value.appState !== 'active' && this.value.appState !== 'inactive') return false;
      this.update({ locked: false, error: null });
      return true;
    } finally { this.busy = false; }
  }
  async changeEnabled(enabled: boolean) {
    if (this.busy || !this.value.loaded || this.value.appState !== 'active'
      || this.value.enabled && this.value.locked) return false;
    if (this.value.enabled === enabled) return true;
    this.busy = true;
    try {
      const revision = await this.proof();
      if (revision === null || revision !== this.revision || this.value.appState !== 'active' && this.value.appState !== 'inactive') return false;
      return await this.savePolicy(enabled, revision);
    } finally { this.busy = false; }
  }
  async repair() {
    if (this.busy || this.value.loaded || this.value.appState !== 'active') return false;
    this.busy = true;
    try {
      const revision = await this.proof();
      if (revision === null || revision !== this.revision || this.value.appState !== 'active' && this.value.appState !== 'inactive') return false;
      return await this.savePolicy(true, revision);
    } finally { this.busy = false; }
  }
  private async savePolicy(enabled: boolean, revision: number) {
    this.update({ saving: true });
    try {
      await this.adapter.write(enabled ? ON : OFF);
      this.update({ loaded: true, enabled, locked: enabled && revision !== this.revision, error: null });
      return true;
    } catch {
      // A lost write reply may follow a commit. Reload the actual policy and
      // require another unlock if enabled; never guess that protection is off.
      await this.readPolicy();
      this.update({ error: this.value.error ?? 'Could not confirm the lock change. The saved setting was reloaded.' });
      return false;
    } finally { this.update({ saving: false }); }
  }
  lockNow() { this.revision++; this.update({ locked: true, error: null }); }
}
