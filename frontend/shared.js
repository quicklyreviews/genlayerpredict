/**
 * Shared foundation for every GenPredict page: config, wallet, formatting, toasts.
 *
 * Reads go through the backend proxy (which caches them — the Studio RPC only
 * allows ~30 requests/minute across all clients). Writes are always signed by the
 * user's own wallet and never touch the backend.
 */
import { createClient } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import { TransactionStatus } from 'genlayer-js/types';

export const CONFIG = {
  backendUrl: "http://localhost:3005",
  predictAddress: "",
  perpAddress: "",
};

export const STUDIO_CHAIN_ID = "0xF22F"; // 61999
export const STUDIO_RPC = "https://studio.genlayer.com/api";
export const EXPLORER_URL = "https://explorer-studio.genlayer.com";

/** GenLayer needs roughly a minute to reach consensus on a transaction. Bets sent
 *  inside this window before lock are unlikely to land, so the UI stops accepting
 *  them rather than letting someone lose a round to latency. */
export const CONSENSUS_BUFFER_SECONDS = 45;

export const ASSET_META = {
  BTC: { name: "Bitcoin", color: "#f7931a", tv: "BINANCE:BTCUSDT", cg: "bitcoin" },
  ETH: { name: "Ethereum", color: "#627eea", tv: "BINANCE:ETHUSDT", cg: "ethereum" },
  SOL: { name: "Solana", color: "#14f195", tv: "BINANCE:SOLUSDT", cg: "solana" },
  XRP: { name: "XRP", color: "#23292f", tv: "BINANCE:XRPUSDT", cg: "ripple" },
  BNB: { name: "BNB", color: "#f3ba2f", tv: "BINANCE:BNBUSDT", cg: "binancecoin" },
  DOGE: { name: "Dogecoin", color: "#c2a633", tv: "BINANCE:DOGEUSDT", cg: "dogecoin" },
};

export const $ = (id) => document.getElementById(id);
export const el = (sel, root = document) => root.querySelector(sel);

// ─── Numbers ────────────────────────────────────────────────────────

export function parseGenToWei(value) {
  const str = String(value).trim();
  const [whole, frac = ""] = str.split(".");
  const fracPadded = (frac + "0".repeat(18)).slice(0, 18);
  return BigInt(whole || "0") * (10n ** 18n) + BigInt(fracPadded);
}

export function genFromWei(wei, decimals = 3) {
  try {
    const n = Number(BigInt(wei)) / 1e18;
    if (n === 0) return "0";
    if (n < 0.001) return n.toExponential(1);
    return n.toLocaleString(undefined, { maximumFractionDigits: decimals });
  } catch { return "0"; }
}

export function fmtUsd(v, decimals = 2) {
  const n = parseFloat(v);
  if (!isFinite(n) || n === 0) return "—";
  return "$" + n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function fmtMultiplier(x100) {
  const v = Number(x100 || 0) / 100;
  return v > 0 ? `${v.toFixed(2)}x` : "—";
}

/** Implied probability from the parimutuel pools — the number Polymarket puts front
 *  and centre. With an empty pool there is no market view yet, so return null and
 *  let the caller show a neutral state rather than a misleading 50%. */
export function impliedPct(upPool, downPool) {
  const up = Number(BigInt(upPool || "0"));
  const down = Number(BigInt(downPool || "0"));
  const total = up + down;
  if (total === 0) return null;
  return Math.round((up / total) * 100);
}

export function fmtCountdown(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function fmtHorizon(seconds) {
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

export function fmtClock(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ─── Backend reads ──────────────────────────────────────────────────

let _errorCount = 0;
let _paused = false;

async function api(endpoint, options = {}) {
  if (_paused) throw new Error("Backend paused after repeated errors");
  try {
    const res = await fetch(`${CONFIG.backendUrl}${endpoint}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    _errorCount = 0; _paused = false;
    return data;
  } catch (e) {
    _errorCount++;
    if (_errorCount >= 4) {
      _paused = true;
      toast("Backend unreachable — retrying in 60s", "error");
      setTimeout(() => { _paused = false; _errorCount = 0; }, 60000);
    }
    throw e;
  }
}

export async function readPredict(fn, args = []) {
  return api("/api/predict/call", {
    method: "POST",
    body: JSON.stringify({ method: fn, args, type: "read" }),
  });
}

export async function readPerp(fn, args = []) {
  return api("/api/call", {
    method: "POST",
    body: JSON.stringify({ method: fn, args, type: "read" }),
  });
}

export async function loadConfig() {
  try {
    const r = await fetch(CONFIG.backendUrl + "/api/config");
    const d = await r.json();
    if (d.predictAddress) CONFIG.predictAddress = d.predictAddress;
    if (d.contractAddress) CONFIG.perpAddress = d.contractAddress;
  } catch (e) {
    console.warn("Could not load config from backend");
  }
}

// ─── Wallet ─────────────────────────────────────────────────────────

export const wallet = {
  account: null,
  _client: null,
  _provider: null,
  _listeners: [],
};

export function getProvider() {
  if (window.ethereum) return window.ethereum;
  if (window.okxwallet) return window.okxwallet;
  return null;
}

function getClient() {
  const provider = getProvider();
  if (!wallet._client || wallet._provider !== provider) {
    wallet._client = createClient({ chain: studionet, account: wallet.account, provider });
    wallet._provider = provider;
  }
  return wallet._client;
}

export function onWalletChange(fn) {
  wallet._listeners.push(fn);
}

function emitWalletChange() {
  wallet._listeners.forEach((fn) => {
    try { fn(wallet.account); } catch (e) { console.error(e); }
  });
}

async function ensureStudioChain() {
  const provider = getProvider();
  const chainId = await provider.request({ method: "eth_chainId" });
  if (chainId === STUDIO_CHAIN_ID) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: STUDIO_CHAIN_ID }] });
  } catch (err) {
    if (err.code === 4902) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: STUDIO_CHAIN_ID,
          chainName: "GenLayer Studio",
          rpcUrls: [STUDIO_RPC],
          nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
          blockExplorerUrls: [EXPLORER_URL],
        }],
      });
    } else throw err;
  }
}

const WALLET_CACHE_KEY = "genpredict_wallet";

export async function connectWallet({ silent = false } = {}) {
  const provider = getProvider();
  if (!provider) {
    if (!silent) toast("No wallet found — install MetaMask or OKX Wallet", "error");
    return null;
  }
  try {
    const accounts = await provider.request({
      method: silent ? "eth_accounts" : "eth_requestAccounts",
    });
    if (!accounts || accounts.length === 0) return null;
    wallet.account = accounts[0];
    try { localStorage.setItem(WALLET_CACHE_KEY, wallet.account.toLowerCase()); } catch (e) {}
    if (!silent) await ensureStudioChain();

    provider.removeAllListeners?.("accountsChanged");
    provider.on("accountsChanged", (accs) => {
      wallet.account = accs && accs.length ? accs[0] : null;
      emitWalletChange();
    });
    provider.on("chainChanged", () => window.location.reload());

    emitWalletChange();
    return wallet.account;
  } catch (e) {
    if (!silent) toast(e.message || "Wallet connection rejected", "error");
    return null;
  }
}

export async function autoReconnect() {
  const cached = (() => { try { return localStorage.getItem(WALLET_CACHE_KEY); } catch (e) { return null; } })();
  if (!cached) return null;
  // MetaMask can inject after DOMContentLoaded; give it a moment before giving up.
  for (let i = 0; i < 20 && !getProvider(); i++) await new Promise((r) => setTimeout(r, 100));
  if (!getProvider()) return null;
  return connectWallet({ silent: true });
}

export async function getBalance() {
  if (!wallet.account) return null;
  try {
    const raw = await getProvider().request({
      method: "eth_getBalance", params: [wallet.account, "latest"],
    });
    return BigInt(raw);
  } catch (e) { return null; }
}

/** Sign and send a contract write from the user's own wallet. */
export async function write(address, functionName, args = [], valueWei = 0n) {
  if (!getProvider()) throw new Error("No wallet detected");
  if (!wallet.account) throw new Error("Wallet not connected");
  await ensureStudioChain();
  const client = getClient();
  return client.writeContract({
    address,
    functionName,
    args,
    value: typeof valueWei === "bigint" ? valueWei : BigInt(valueWei),
  });
}

export async function waitAccepted(hash, { retries = 60 } = {}) {
  const client = getClient();
  return client.waitForTransactionReceipt({
    hash, status: TransactionStatus.ACCEPTED, interval: 3000, retries,
  });
}

export function txLink(hash) {
  return `${EXPLORER_URL}/tx/${hash}`;
}

export function shortAddr(a) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "";
}

// ─── Toasts ─────────────────────────────────────────────────────────

export function toast(message, kind = "info", { timeout = 6000, html = false } = {}) {
  let host = $("toast-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "toast-host";
    document.body.appendChild(host);
  }
  const node = document.createElement("div");
  node.className = `toast toast--${kind}`;
  if (html) node.innerHTML = message; else node.textContent = message;
  host.appendChild(node);
  requestAnimationFrame(() => node.classList.add("toast--in"));
  const remove = () => {
    node.classList.remove("toast--in");
    setTimeout(() => node.remove(), 250);
  };
  if (timeout) setTimeout(remove, timeout);
  node.addEventListener("click", remove);
  return remove;
}

// ─── Header ─────────────────────────────────────────────────────────

/** Renders the shared header into [data-app-header] and keeps it in sync. */
export function mountHeader(activePage) {
  const host = document.querySelector("[data-app-header]");
  if (!host) return;
  host.innerHTML = `
    <a class="brand" href="index.html" aria-label="GenPredict home">
      <img src="https://assets.zksync.io/images/genlayer_white.svg" alt="" width="26" height="26"/>
      <span>GenPredict</span>
    </a>
    <nav class="nav" aria-label="Primary">
      <a href="index.html" class="nav__link${activePage === "home" ? " is-active" : ""}">Markets</a>
      <a href="portfolio.html" class="nav__link${activePage === "portfolio" ? " is-active" : ""}">Portfolio</a>
      <a href="perp.html" class="nav__link${activePage === "perp" ? " is-active" : ""}">Perps</a>
    </nav>
    <div class="header__right">
      <span id="hdr-balance" class="balance hidden"></span>
      <button id="hdr-connect" class="btn btn--primary btn--sm">Connect Wallet</button>
    </div>`;

  const btn = $("hdr-connect");
  btn.addEventListener("click", async () => {
    if (wallet.account) return;
    btn.disabled = true;
    await connectWallet();
    btn.disabled = false;
  });

  const sync = async () => {
    if (wallet.account) {
      btn.textContent = shortAddr(wallet.account);
      btn.classList.remove("btn--primary");
      btn.classList.add("btn--ghost");
      const bal = await getBalance();
      const b = $("hdr-balance");
      if (bal !== null && b) {
        b.textContent = `${genFromWei(bal, 2)} GEN`;
        b.classList.remove("hidden");
      }
    } else {
      btn.textContent = "Connect Wallet";
      btn.classList.add("btn--primary");
      btn.classList.remove("btn--ghost");
      $("hdr-balance")?.classList.add("hidden");
    }
  };
  onWalletChange(sync);
  sync();
  setInterval(sync, 30000);
}
