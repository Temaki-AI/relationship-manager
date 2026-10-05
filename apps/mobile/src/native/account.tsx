import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';

import {
  accountScope, base64Url, DEVICE_CALLBACK_URL, DEVICE_TOKEN_PREFIX, deviceIdentity,
  isDeviceState, isPkceVerifier, nativeAccountOrigin, parseDeviceCallback, readNativeAccount,
  type NativeAccount,
} from '../../../../packages/domain/src/devices';
import { selectNotificationAccount } from './notifications';
import { clearPrivateAccountCaches } from './private-account-cache';

const ACCOUNT_KEY = 'everclose.active-account';
const PENDING_KEY = 'everclose.pending-sign-in';
const storageOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
type PendingSignIn = { origin: string; state: string; verifier: string; token: string; code?: string; startedAt: number };
type AccountContextValue = {
  account: NativeAccount | null; loading: boolean; startupError: string | null; pending: boolean;
  reload: () => Promise<void>; signIn: (origin: string) => Promise<void>;
  finishCallback: (url: string) => Promise<void>; resume: () => Promise<void>; disconnect: () => Promise<boolean>;
};
const AccountContext = createContext<AccountContextValue | null>(null);
let exchangeInFlight: Promise<NativeAccount> | null = null;

async function readStoredAccount() {
  if (Platform.OS === 'web') return { account: null, pending: false };
  const raw = await SecureStore.getItemAsync(ACCOUNT_KEY, storageOptions);
  return {
    account: raw ? readNativeAccount(JSON.parse(raw), __DEV__) : null,
    pending: Boolean(await SecureStore.getItemAsync(PENDING_KEY, storageOptions)),
  };
}

async function timedFetch(url: string, options: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function pendingSignIn(): Promise<PendingSignIn | null> {
  const raw = await SecureStore.getItemAsync(PENDING_KEY, storageOptions);
  if (!raw) return null;
  const value = JSON.parse(raw) as PendingSignIn;
  if (!isDeviceState(value.state) || !isPkceVerifier(value.verifier) || !Number.isFinite(value.startedAt)
    || Date.now() - value.startedAt > 30 * 60_000 || typeof value.token !== 'string' || !value.token.startsWith(DEVICE_TOKEN_PREFIX)) {
    throw new Error('The pending sign-in expired. Start sign-in again.');
  }
  value.origin = nativeAccountOrigin(value.origin, __DEV__);
  return value;
}

async function exchange(pending: PendingSignIn): Promise<NativeAccount> {
  if (!pending.code) throw new Error('Start sign-in again to return from the browser.');
  const response = await timedFetch(`${pending.origin}/api/auth/device/exchange`, {
    method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: pending.code, verifier: pending.verifier, state: pending.state, token: pending.token }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Unable to finish phone sign-in.');
  const identity = deviceIdentity(body.identity);
  const account = readNativeAccount({ ...identity, origin: pending.origin, token: pending.token }, __DEV__);
  const previous = await SecureStore.getItemAsync(ACCOUNT_KEY, storageOptions);
  if (previous) {
    const old = readNativeAccount(JSON.parse(previous), __DEV__);
    if (accountScope(old) !== accountScope(account)) await clearPrivateAccountCaches(accountScope(old));
  }
  await selectNotificationAccount(null);
  await SecureStore.setItemAsync(ACCOUNT_KEY, JSON.stringify(account), storageOptions);
  await SecureStore.deleteItemAsync(PENDING_KEY, storageOptions);
  return account;
}

async function finishPending(url?: string): Promise<NativeAccount> {
  const pending = await pendingSignIn();
  if (!pending) throw new Error('Start sign-in from this phone before opening the callback.');
  if (url) pending.code = parseDeviceCallback(url, pending.state);
  if (exchangeInFlight) return exchangeInFlight;
  exchangeInFlight = (async () => {
    await SecureStore.setItemAsync(PENDING_KEY, JSON.stringify(pending), storageOptions);
    return exchange(pending);
  })();
  try { return await exchangeInFlight; } finally { exchangeInFlight = null; }
}

export function NativeAccountProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<NativeAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function reload() {
    setLoading(true);
    try {
      const value = await readStoredAccount();
      setAccount(value.account); setPending(value.pending);
      setStartupError(null);
    } catch { setStartupError('Unable to unlock the account saved on this phone. Unlock your device and try again.'); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    let active = true;
    void readStoredAccount().then((value) => {
      if (!active) return;
      setAccount(value.account); setPending(value.pending); setStartupError(null); setLoading(false);
    }, () => {
      if (!active) return;
      setStartupError('Unable to unlock the account saved on this phone. Unlock your device and try again.'); setLoading(false);
    });
    return () => { active = false; };
  }, []);
  async function finishCallback(url: string) { setAccount(await finishPending(url)); setPending(false); }
  async function resume() { setAccount(await finishPending()); setPending(false); }
  async function signIn(server: string) {
    if (Platform.OS === 'web') throw new Error('Use the hosted web app to sign in from a browser.');
    const origin = nativeAccountOrigin(server, __DEV__);
    const [stateBytes, verifierBytes, tokenBytes] = await Promise.all([
      Crypto.getRandomBytesAsync(32), Crypto.getRandomBytesAsync(32), Crypto.getRandomBytesAsync(32),
    ]);
    const hex = (bytes: Uint8Array) => Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    const state = hex(stateBytes), verifier = hex(verifierBytes);
    const challenge = (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier,
      { encoding: Crypto.CryptoEncoding.BASE64 })).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
    const next: PendingSignIn = { origin, verifier, state, token: `${DEVICE_TOKEN_PREFIX}${base64Url(tokenBytes)}`, startedAt: Date.now() };
    await SecureStore.setItemAsync(PENDING_KEY, JSON.stringify(next), storageOptions);
    setPending(true);
    const url = new URL('/connect-device', origin);
    url.searchParams.set('challenge', challenge); url.searchParams.set('state', state);
    url.searchParams.set('deviceName', Platform.OS === 'ios' ? 'Everclose on iPhone' : 'Everclose on Android');
    const result = await WebBrowser.openAuthSessionAsync(url.href, DEVICE_CALLBACK_URL);
    if (result.type === 'success') await finishCallback(result.url);
  }
  async function disconnect() {
    if (account) await clearPrivateAccountCaches(accountScope(account));
    let revoked = !account;
    if (account) {
      try {
        const response = await timedFetch(`${account.origin}/api/v1/devices/session`, {
          method: 'DELETE', credentials: 'omit', headers: { Authorization: `Bearer ${account.token}` },
        });
        revoked = response.ok || response.status === 401;
      } catch { /* Local disconnect remains available without a network. */ }
    }
    await selectNotificationAccount(null);
    await SecureStore.deleteItemAsync(ACCOUNT_KEY, storageOptions);
    await SecureStore.deleteItemAsync(PENDING_KEY, storageOptions);
    setAccount(null); setPending(false);
    return revoked;
  }
  return <AccountContext.Provider value={{ account, loading, startupError, pending, reload, signIn, finishCallback, resume, disconnect }}>{children}</AccountContext.Provider>;
}

export function useNativeAccount() {
  const value = useContext(AccountContext);
  if (!value) throw new Error('Native account provider is unavailable.');
  return value;
}

export async function accountDatabaseName(account: NativeAccount | null) {
  if (!account) return 'bonds-mobile.db';
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, accountScope(account));
  return `everclose-${digest}.db`;
}
