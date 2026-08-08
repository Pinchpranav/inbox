// Ed25519 device identity + issued-token store, backed by Web Crypto +
// localStorage. Used by `GatewayBrowserDeviceAuthLifecycle` to sign the
// connect challenge and persist any device token the gateway issues.
//
// This is the docs' *recommended* auth path (clients.md): a persisted device
// identity signs the challenge-bound payload, and the gateway grants operator
// scopes. We store the issued device token so later reconnects can use it
// directly (no re-signing needed once paired).
//
// crypto.subtle (Ed25519) requires a secure context — localhost is one, so
// local dev works; deployed HTTPS works too. Over plain HTTP (non-loopback)
// we fall back to token-only (no device), which the gateway may reject or
// grant no scopes — acceptable trade-off for the single-user thin app.

import { GatewayBrowserDeviceAuthLifecycle, type GatewayBrowserDeviceAuthPlan } from "@openclaw/gateway-client/browser";

const IDENTITY_KEY = "openclaw-sidebar.device-identity-v1";
const TOKENS_KEY = "openclaw-sidebar.device-tokens-v1";

// ── base64url helpers ─────────────────────────────────────────────────────
function b64uEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}
function b64uDecode(str: string): Uint8Array {
  const norm = str.replaceAll("-", "+").replaceAll("_", "/");
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Ed25519 keypair (Web Crypto) ───────────────────────────────────────────
const ED25519_PKCS8_HEADER = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

interface StoredIdentity {
  version: 1;
  deviceId: string;
  publicKey: string; // base64url
  privateKey: string; // base64url (raw 32 bytes)
}

async function fingerprintHex(publicKeyBytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", publicKeyBytes as BufferSource);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function generateIdentity(): Promise<StoredIdentity> {
  const kp = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const rawPrivate = pkcs8.slice(16); // Ed25519 PKCS8 is 48 bytes; raw key at offset 16
  const deviceId = await fingerprintHex(rawPublic);
  return { version: 1, deviceId, publicKey: b64uEncode(rawPublic), privateKey: b64uEncode(rawPrivate) };
}

function makeSigner(privateKeyB64u: string) {
  return async (payload: string): Promise<string> => {
    const rawPriv = b64uDecode(privateKeyB64u);
    const pkcs8 = new Uint8Array(48);
    pkcs8.set(ED25519_PKCS8_HEADER);
    pkcs8.set(rawPriv, 16);
    const key = await crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, "Ed25519", false, ["sign"]);
    const data = new TextEncoder().encode(payload);
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key, data as BufferSource));
    return b64uEncode(sig);
  };
}

// ── Identity load/create (localStorage) ────────────────────────────────────
let cachedIdentity: StoredIdentity | null = null;

export async function loadOrCreateDeviceIdentity() {
  if (cachedIdentity) return cachedIdentity;
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<StoredIdentity>;
      if (p.version === 1 && p.deviceId && p.publicKey && p.privateKey) {
        cachedIdentity = p as StoredIdentity;
        return cachedIdentity;
      }
    }
  } catch {
    /* ignore corrupt entry */
  }
  cachedIdentity = await generateIdentity();
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(cachedIdentity));
  } catch {
    /* ignore storage errors */
  }
  return cachedIdentity;
}

// ── Issued device-token store (localStorage) ───────────────────────────────
type TokenRecord = { token: string; scopes: string[] };
interface TokenStoreMap {
  [clientId: string]: { [deviceId: string]: { [role: string]: TokenRecord } };
}

function readTokens(): TokenStoreMap {
  try {
    const raw = localStorage.getItem(TOKENS_KEY);
    return raw ? (JSON.parse(raw) as TokenStoreMap) : {};
  } catch {
    return {};
  }
}
function writeTokens(map: TokenStoreMap): void {
  try {
    localStorage.setItem(TOKENS_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

export const localStorageTokenStore = {
  async load({ clientId, deviceId, role }: { clientId: string; deviceId: string; role: string }) {
    const map = readTokens();
    const rec = map[clientId]?.[deviceId]?.[role];
    return rec ?? null;
  },
  async store({ clientId, deviceId, role, token, scopes }: { clientId: string; deviceId: string; role: string; token: string; scopes: string[] }) {
    const map = readTokens();
    map[clientId] ??= {};
    map[clientId][deviceId] ??= {};
    map[clientId][deviceId][role] = { token, scopes };
    writeTokens(map);
  },
  async clear({ clientId, deviceId, role }: { clientId: string; deviceId: string; role: string }) {
    const map = readTokens();
    delete map[clientId]?.[deviceId]?.[role];
    writeTokens(map);
  },
};

// ── Lifecycle ─────────────────────────────────────────────────────────────
export function createDeviceAuthLifecycle() {
  return new GatewayBrowserDeviceAuthLifecycle({
    loadIdentity: async () => {
      if (typeof crypto === "undefined" || !crypto.subtle) return null; // no secure context
      const id = await loadOrCreateDeviceIdentity();
      return { deviceId: id.deviceId, publicKey: id.publicKey, sign: makeSigner(id.privateKey) };
    },
    tokenStore: localStorageTokenStore,
  });
}

export type { GatewayBrowserDeviceAuthPlan };