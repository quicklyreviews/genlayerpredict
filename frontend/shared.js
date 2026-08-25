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
  BTC:  { name: "Bitcoin",   color: "#f7931a", tv: "BINANCE:BTCUSDT",  cg: "bitcoin" },
  ETH:  { name: "Ethereum",  color: "#627eea", tv: "BINANCE:ETHUSDT",  cg: "ethereum" },
  SOL:  { name: "Solana",    color: "#14f195", tv: "BINANCE:SOLUSDT",  cg: "solana" },
  XRP:  { name: "XRP",       color: "#23292f", tv: "BINANCE:XRPUSDT",  cg: "ripple" },
  BNB:  { name: "BNB",       color: "#f3ba2f", tv: "BINANCE:BNBUSDT",  cg: "binancecoin" },
  LINK: { name: "Chainlink", color: "#2a5ada", tv: "BINANCE:LINKUSDT", cg: "chainlink" },
  DOGE: { name: "Dogecoin",  color: "#c2a633", tv: "BINANCE:DOGEUSDT", cg: "dogecoin" },
  SHIB: { name: "Shiba Inu", color: "#f00500", tv: "BINANCE:SHIBUSDT", cg: "shiba-inu" },
  PEPE: { name: "Pepe",      color: "#3d8130", tv: "BINANCE:PEPEUSDT", cg: "pepe" },
};

/**
 * Real coin artwork layered over a coloured monogram.
 *
 * No inline onload/onerror handlers: the page runs under a CSP that blocks them,
 * which silently defeated the first version — every icon fell back to a monogram
 * even though the images were downloading fine. Instead the <img> simply sits on
 * top of the monogram. The icons are opaque discs, so a loaded one hides the
 * letters by covering them, and an icon that 404s renders nothing at all and lets
 * the monogram show through. Pure CSS, no scripting, nothing to be blocked.
 */
const LOGO_SOURCES = {
  // The icon set predates these two, so they come from CoinGecko instead.
  SHIB: "https://coin-images.coingecko.com/coins/images/11939/small/shiba.png",
  PEPE: "https://coin-images.coingecko.com/coins/images/29850/small/pepe-token.jpeg",
};

export function coinLogo(symbol, size = 34) {
  const meta = ASSET_META[symbol] || {};
  const color = meta.color || "#4b5162";
  const src = LOGO_SOURCES[symbol]
    || `https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/svg/color/${symbol.toLowerCase()}.svg`;
  return `<span class="coin" style="background:${color};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.32)}px">
    <span class="coin__text">${symbol.slice(0, 4)}</span>
    <img class="coin__img" src="${src}" alt="" width="${size}" height="${size}"/>
  </span>`;
}

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

export async function readPredict(fn, args = [], { fresh = false } = {}) {
  return api("/api/predict/call", {
    method: "POST",
    body: JSON.stringify({ method: fn, args, type: "read", fresh }),
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

// ─── Polling ────────────────────────────────────────────────────────

/**
 * setInterval that stops while the tab is hidden, and fires once immediately on
 * return so the page is never stale when you look at it.
 *
 * This is a budget decision as much as a UX one: the node allows 5000 RPC requests
 * per day in total and the round keeper already needs most of them. A forgotten
 * background tab polling every 12s would burn the entire remainder on its own.
 */
export function pollWhileVisible(fn, intervalMs) {
  let timer = null;
  const tick = () => { if (!document.hidden) fn(); };
  const start = () => {
    if (timer) return;
    timer = setInterval(tick, intervalMs);
  };
  const stop = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { stop(); }
    else { fn(); start(); }
  });
  start();
  return () => { stop(); };
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
      <button id="hdr-vault" class="vault-chip hidden" title="Your play balance — click to deposit or withdraw">
        <span class="vault-chip__label">Play balance</span>
        <span id="hdr-vault-amount" class="vault-chip__amount">—</span>
      </button>
      <span id="hdr-balance" class="balance hidden" title="GEN in your wallet"></span>
      <button id="hdr-connect" class="btn btn--primary btn--sm">Connect Wallet</button>
    </div>`;

  const btn = $("hdr-connect");
  btn.addEventListener("click", async () => {
    if (wallet.account) return;
    btn.disabled = true;
    await connectWallet();
    btn.disabled = false;
  });

  $("hdr-vault").addEventListener("click", () => {
    if (vaultState.error && !vaultState.loaded) return refreshVaultChip({ fresh: true });
    openVaultModal();
  });

  const sync = async () => {
    if (wallet.account) {
      btn.textContent = shortAddr(wallet.account);
      btn.classList.remove("btn--primary");
      btn.classList.add("btn--ghost");
      // Fired together, not chained: the wallet call goes to the browser extension
      // and the play balance to our backend, and one being slow must not hold up
      // the other.
      getBalance().then((bal) => {
        const b = $("hdr-balance");
        if (bal !== null && b) {
          b.textContent = `${genFromWei(bal, 2)} GEN wallet`;
          b.classList.remove("hidden");
        }
      });
      refreshVaultChip();
    } else {
      btn.textContent = "Connect Wallet";
      btn.classList.add("btn--primary");
      btn.classList.remove("btn--ghost");
      $("hdr-balance")?.classList.add("hidden");
      $("hdr-vault")?.classList.add("hidden");
    }
  };
  onWalletChange(sync);
  sync();
  pollWhileVisible(sync, 30000);
}

// ─── Vault (play balance) ───────────────────────────────────────────

export const vaultState = { balance: 0n, atRisk: 0n, loaded: false, error: null };
const vaultListeners = [];

export function onVaultChange(fn) { vaultListeners.push(fn); }

/**
 * Loads the play balance on its own, never behind anything else.
 *
 * It used to run after the wallet balance in the same await chain, so a slow or
 * unresponsive wallet provider stopped it loading at all — and because the chip
 * stayed hidden until a value arrived, the failure looked like the feature simply
 * did not exist. It now shows itself immediately in a loading state and reports a
 * failure instead of vanishing.
 *
 * Pass { fresh: true } straight after a deposit, bet or withdrawal: reads are
 * cached for 30s, and without it the user would be shown the balance from just
 * before their own transaction landed.
 */
export async function refreshVaultChip({ fresh = false } = {}) {
  const chip = $("hdr-vault");
  const amt = $("hdr-vault-amount");
  if (!wallet.account || !CONFIG.predictAddress) {
    chip?.classList.add("hidden");
    return;
  }
  if (chip && amt) {
    chip.classList.remove("hidden");
    if (vaultState.balance === 0n && !vaultState.loaded) amt.textContent = "…";
    chip.classList.add("vault-chip--loading");
  }
  try {
    const acct = await readPredict("get_account", [wallet.account.toLowerCase()], { fresh });
    vaultState.balance = BigInt(acct.balance || "0");
    vaultState.atRisk = BigInt(acct.at_risk || "0");
    vaultState.loaded = true;
    vaultState.error = null;
    if (chip && amt) {
      amt.textContent = `${genFromWei(vaultState.balance, 2)} GEN`;
      chip.classList.toggle("vault-chip--empty", vaultState.balance === 0n);
      chip.title = `Play balance ${genFromWei(vaultState.balance, 4)} GEN` +
        (vaultState.atRisk > 0n ? ` · ${genFromWei(vaultState.atRisk, 4)} GEN riding on open rounds` : "") +
        " — click to deposit or withdraw";
    }
    vaultListeners.forEach((fn) => { try { fn(vaultState); } catch (e) { console.error(e); } });
  } catch (e) {
    vaultState.error = e.message || "unavailable";
    // Keep a known balance on screen rather than blanking it; only say "retry"
    // when there has never been one to show.
    if (chip && amt && !vaultState.loaded) {
      amt.textContent = "retry";
      chip.title = `Could not load your play balance: ${vaultState.error}. Click to retry.`;
    }
  } finally {
    chip?.classList.remove("vault-chip--loading");
  }
}

/** Deposit / withdraw dialog. Funding is a prerequisite for playing, so this is
 *  reachable from every page rather than buried on one. */
export function openVaultModal(mode = "deposit") {
  document.getElementById("vault-modal")?.remove();
  const walletGen = () => getBalance().then((b) => (b === null ? "0" : genFromWei(b, 4)));

  const host = document.createElement("div");
  host.id = "vault-modal";
  host.className = "modal";
  host.innerHTML = `
    <div class="modal__backdrop" data-close></div>
    <div class="modal__panel">
      <div class="modal__head">
        <h2>Play balance</h2>
        <button class="modal__x" data-close aria-label="Close">✕</button>
      </div>
      <p class="modal__intro">
        Bets are staked from this balance, and winnings land back in it the moment a
        round settles — no claiming. Top it up once and play as many rounds as you like.
      </p>
      <div class="modal__tabs">
        <button class="modal__tab${mode === "deposit" ? " is-active" : ""}" data-mode="deposit">Deposit</button>
        <button class="modal__tab${mode === "withdraw" ? " is-active" : ""}" data-mode="withdraw">Withdraw</button>
      </div>
      <div class="modal__body">
        <div class="stat-row">
          <span>In your play balance</span><b id="vm-balance" class="mono">${genFromWei(vaultState.balance, 4)} GEN</b>
        </div>
        <div class="stat-row">
          <span>Riding on open rounds</span><b id="vm-atrisk" class="mono">${genFromWei(vaultState.atRisk, 4)} GEN</b>
        </div>
        <div class="stat-row">
          <span id="vm-src-label">In your wallet</span><b id="vm-wallet" class="mono">…</b>
        </div>
        <div class="field" style="margin-top:14px">
          <label class="field__label" for="vm-amount">Amount</label>
          <div class="input-wrap">
            <input id="vm-amount" type="number" min="0" step="0.1" value="5" inputmode="decimal"/>
            <span class="input-wrap__suffix">GEN</span>
          </div>
          <div class="quick">
            <button data-amt="1">1</button><button data-amt="5">5</button>
            <button data-amt="10">10</button><button data-amt="max">Max</button>
          </div>
        </div>
        <p id="vm-error" class="modal__error"></p>
        <button id="vm-submit" class="btn btn--primary btn--block" style="margin-top:12px"></button>
        <p class="modal__note">
          Deposits and withdrawals are on-chain and need about a minute to confirm.
        </p>
      </div>
    </div>`;
  document.body.appendChild(host);

  let current = mode;
  const amount = () => $("vm-amount").value;
  const setMode = (m) => {
    current = m;
    host.querySelectorAll("[data-mode]").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.mode === m)
    );
    $("vm-submit").textContent = m === "deposit" ? "Deposit to play balance" : "Withdraw to wallet";
    $("vm-src-label").textContent = m === "deposit" ? "In your wallet" : "Available to withdraw";
    $("vm-wallet").textContent = "…";
    if (m === "deposit") walletGen().then((v) => ($("vm-wallet").textContent = `${v} GEN`));
    else $("vm-wallet").textContent = `${genFromWei(vaultState.balance, 4)} GEN`;
  };

  host.querySelectorAll("[data-close]").forEach((n) => n.addEventListener("click", () => host.remove()));
  host.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  host.querySelectorAll("[data-amt]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (b.dataset.amt !== "max") { $("vm-amount").value = b.dataset.amt; return; }
      if (current === "withdraw") {
        $("vm-amount").value = genFromWei(vaultState.balance, 6).replace(/,/g, "");
      } else {
        const bal = await getBalance();
        // Leave a little for gas, or the deposit itself cannot be sent.
        $("vm-amount").value = Math.max(0, Number(bal || 0n) / 1e18 - 0.05).toFixed(4);
      }
    })
  );

  $("vm-submit").addEventListener("click", async () => {
    const err = $("vm-error");
    const btn = $("vm-submit");
    err.textContent = "";
    const amt = Number(amount());
    if (!isFinite(amt) || amt <= 0) { err.textContent = "Enter an amount greater than zero."; return; }
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "Confirm in wallet…";
    try {
      const wei = parseGenToWei(amount());
      const hash = current === "deposit"
        ? await write(CONFIG.predictAddress, "deposit", [], wei)
        : await write(CONFIG.predictAddress, "withdraw", [wei]);
      btn.textContent = "Waiting for consensus…";
      toast(`${current === "deposit" ? "Deposit" : "Withdrawal"} sent — <a href="${txLink(hash)}" target="_blank">view tx</a>`,
            "pending", { html: true, timeout: 10000 });
      await waitAccepted(hash);
      toast(`${current === "deposit" ? "Deposited" : "Withdrew"} ${amount()} GEN`, "success");
      await refreshVaultChip({ fresh: true });
      host.remove();
    } catch (e) {
      err.textContent = e.message || "Transaction failed";
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  setMode(mode);
}
