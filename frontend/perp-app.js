/**
 * GenPerp — Frontend Application
 *
 * Trading (open_position / close_position / fund_vault) is always signed
 * directly by the user's own wallet via genlayer-js — never routed through
 * the backend. The backend is a read-only proxy + keeper (price refresh,
 * liquidations, funding), see scripts/backend-proxy.js.
 */
import { createClient } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import { TransactionStatus } from 'genlayer-js/types';

// ─── Configuration ──────────────────────────────────────────────────
let CONFIG = {
  backendUrl: "http://localhost:3005",
  contractAddress: "",
};

const STUDIO_CHAIN_ID = "0xF22F"; // 61999
const STUDIO_RPC = "https://studio.genlayer.com/api";
const EXPLORER_URL = "https://explorer-studio.genlayer.com";

// Public tickers used ONLY for the header display price (fast, no wallet/gas).
// The price that actually executes a trade is fetched fresh on-chain by the
// contract itself via GenLayer's Equivalence Principle — this is indicative only.
const ASSETS = {
  BTC:  { name: "Bitcoin",   color: "#f7931a" },
  ETH:  { name: "Ethereum",  color: "#627eea" },
  SOL:  { name: "Solana",    color: "#14f195" },
  BNB:  { name: "BNB",       color: "#f3ba2f" },
  LINK: { name: "Chainlink", color: "#2a5ada" },
  DOGE: { name: "Dogecoin",  color: "#c2a633" },
  SHIB: { name: "Shiba Inu", color: "#f00500" },
  PEPE: { name: "Pepe",      color: "#3d8130" },
};
const tvSymbol = (s) => `BINANCE:${s}USDT`;

/** Real coin artwork over a coloured monogram. No inline handlers — the page's CSP
 *  blocks them; the opaque icon simply covers the letters, and one that fails to
 *  load renders nothing so the monogram shows through. */
const LOGO_SOURCES = {
  SHIB: "https://coin-images.coingecko.com/coins/images/11939/small/shiba.png",
  PEPE: "https://coin-images.coingecko.com/coins/images/29850/small/pepe-token.jpeg",
};
function coinLogo(symbol, size = 20) {
  const color = (ASSETS[symbol] || {}).color || "#4b5162";
  const src = LOGO_SOURCES[symbol]
    || `https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/svg/color/${symbol.toLowerCase()}.svg`;
  return `<span class="coin" style="background:${color};width:${size}px;height:${size}px;font-size:${Math.round(size*0.32)}px">
    <span class="coin__text">${symbol.slice(0,4)}</span>
    <img class="coin__img" src="${src}" alt="" width="${size}" height="${size}"/>
  </span>`;
}

const $ = (id) => document.getElementById(id);

function parseGenToWei(value) {
  const str = String(value).trim();
  const [whole, frac = ""] = str.split(".");
  const fracPadded = (frac + "0".repeat(18)).slice(0, 18);
  return BigInt(whole || "0") * (10n ** 18n) + BigInt(fracPadded);
}
function formatWeiToGen(value, decimals = 4) {
  try {
    const n = Number(BigInt(value)) / 1e18;
    return n.toLocaleString(undefined, { maximumFractionDigits: decimals });
  } catch { return "0"; }
}
function fmtUsd(v) {
  const n = parseFloat(v);
  if (!isFinite(n) || n === 0) return "$—";
  return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// ─── State ──────────────────────────────────────────────────────────
let userAccount = null;
let selectedSymbol = "BTC";
let markets = {};      // symbol -> market config (from contract)
let vaultStatus = {};
let pollInterval = null;
let tickerInterval = null;

// ─── Backend API (reads only) ────────────────────────────────────────
let _backendErrorCount = 0;
let _backendPaused = false;

async function apiCall(endpoint, options = {}) {
  if (_backendPaused) throw new Error("Backend paused due to errors");
  try {
    const res = await fetch(`${CONFIG.backendUrl}${endpoint}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    _backendErrorCount = 0; _backendPaused = false;
    return data;
  } catch (e) {
    _backendErrorCount++;
    if (_backendErrorCount >= 3) {
      _backendPaused = true;
      setTimeout(() => { _backendPaused = false; _backendErrorCount = 0; }, 60000);
      addLog("⚠️ Backend unreachable — pausing polls for 60s");
    }
    throw e;
  }
}
async function readContract(functionName, args = []) {
  return apiCall("/api/call", { method: "POST", body: JSON.stringify({ method: functionName, args, type: "read" }) });
}

// ─── GenLayer Client (wallet-signed writes) ─────────────────────────
let _glClient = null, _glClientAccount = null, _glClientProvider = null;
function getGenLayerClient() {
  const provider = getProvider();
  if (!_glClient || _glClientAccount !== userAccount || _glClientProvider !== provider) {
    _glClient = createClient({ chain: studionet, account: userAccount, provider });
    _glClientAccount = userAccount; _glClientProvider = provider;
  }
  return _glClient;
}

async function writeContract(functionName, args = [], valueWei = "0x0") {
  if (!getProvider()) throw new Error("No wallet detected");
  if (!userAccount) throw new Error("Wallet not connected");
  await ensureStudioChain();
  const client = getGenLayerClient();
  const valueBigInt = typeof valueWei === "string" ? BigInt(valueWei) : BigInt(valueWei);
  const txHash = await client.writeContract({ address: CONFIG.contractAddress, functionName, args, value: valueBigInt });
  addLog(`TX sent: ${functionName}() → ${txHash.slice(0, 14)}...`);
  return txHash;
}

async function ensureStudioChain() {
  const currentChainId = await getProvider().request({ method: "eth_chainId" });
  if (currentChainId === STUDIO_CHAIN_ID) return;
  try {
    await getProvider().request({ method: "wallet_switchEthereumChain", params: [{ chainId: STUDIO_CHAIN_ID }] });
  } catch (switchError) {
    if (switchError.code === 4902) {
      await getProvider().request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: STUDIO_CHAIN_ID, chainName: "GenLayer Studio", rpcUrls: [STUDIO_RPC],
          nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 }, blockExplorerUrls: [EXPLORER_URL] }],
      });
    } else throw switchError;
  }
}

function getProvider() {
  if (window.ethereum) return window.ethereum;
  if (window.okxwallet) return window.okxwallet;
  return null;
}

// ─── Activity log ───────────────────────────────────────────────────
function addLog(msg) {
  const log = $("activity-log");
  if (!log) { console.log("[LOG]", msg); return; }
  const empty = log.querySelector(".log-empty");
  if (empty) empty.remove();
  const entry = document.createElement("div");
  entry.className = "log-entry border-b border-[#1a1a1a] pb-1";
  entry.innerHTML = `<span class="text-gray-600 mr-2">${new Date().toLocaleTimeString()}</span>${msg}`;
  log.prepend(entry);
  while (log.children.length > 50) log.lastChild.remove();
}

// ─── Markets ────────────────────────────────────────────────────────
async function loadMarkets() {
  try {
    const raw = await readContract("get_all_markets");
    markets = typeof raw === "string" ? JSON.parse(raw) : raw;
    renderMarketTabs();
    updateTradePreview();
  } catch (e) {
    console.warn("loadMarkets error:", e.message);
  }
}

function renderMarketTabs() {
  const el = $("market-tabs");
  if (!el) return;
  const symbols = Object.keys(markets);
  if (symbols.length === 0) { el.innerHTML = '<span class="text-gray-600 text-sm">No markets configured</span>'; return; }
  if (!symbols.includes(selectedSymbol)) selectedSymbol = symbols[0];
  el.innerHTML = symbols.map(sym => {
    const m = markets[sym];
    const cls = sym === selectedSymbol ? "tab-market active" : "tab-market";
    const disabled = m.enabled ? "" : " (paused)";
    return `<div class="${cls}" onclick="selectMarket('${sym}')" style="display:inline-flex;align-items:center;gap:7px">
      ${coinLogo(sym)}<span>${sym}${disabled}</span>
      <span class="text-gray-500">· up to ${m.max_leverage}x</span></div>`;
  }).join("");
}

function selectMarket(symbol) {
  selectedSymbol = symbol;
  renderMarketTabs();
  const m = markets[symbol];
  if (m) {
    const slider = $("leverage-slider");
    if (slider) { slider.max = m.max_leverage; if (Number(slider.value) > m.max_leverage) slider.value = m.max_leverage; }
    onLeverageChange();
    const hint = $("min-margin-hint");
    if (hint) hint.textContent = `Min margin: ${formatWeiToGen(m.min_margin)} GEN · fee ${(m.taker_fee_bps / 100).toFixed(2)}% · maintenance ${(m.maintenance_margin_bps / 100).toFixed(2)}%`;
  }
  const title = $("chart-title"); if (title) title.textContent = `${symbol}/USDT`;
  loadTradingView();
  fetchTickerPrice();
  fetchFundingInfo();
}

function onLeverageChange() {
  const slider = $("leverage-slider");
  const label = $("leverage-value");
  if (slider && label) label.textContent = slider.value + "x";
  updateTradePreview();
}

function updateTradePreview() {
  const m = markets[selectedSymbol];
  const marginInput = $("margin-amount");
  const slider = $("leverage-slider");
  if (!m || !marginInput || !slider) return;
  const marginGen = parseFloat(marginInput.value) || 0;
  const lev = Number(slider.value);
  const feeBps = m.taker_fee_bps;
  const fee = marginGen * (feeBps / 10000);
  const netMargin = marginGen - fee;
  const notional = netMargin * lev;
  $("preview-notional").textContent = notional.toFixed(4) + " GEN";
  $("preview-fee").textContent = fee.toFixed(6) + " GEN";
  $("preview-maxlev").textContent = m.max_leverage + "x";

  // Liquidation price estimate needs the live mark price — use cached ticker if available
  const markPrice = parseFloat(($("mark-price").dataset.raw) || "0");
  if (markPrice > 0) {
    const mmRatio = m.maintenance_margin_bps / 10000;
    const adverse = (1 - mmRatio) / lev;
    const longLiq = markPrice * (1 - adverse);
    const shortLiq = markPrice * (1 + adverse);
    $("preview-liq").textContent = `${fmtUsd(longLiq)} (L) / ${fmtUsd(shortLiq)} (S)`;
  } else {
    $("preview-liq").textContent = "—";
  }
}

// ─── Ticker (indicative display price) ───────────────────────────────
//
// Binance rather than CoinGecko: CoinGecko's free endpoint drops its CORS headers
// on a rate-limited response, so from a browser the failure surfaces as a wall of
// CORS errors and the ticker silently stops updating. Binance answers reliably
// cross-origin. The price that actually executes a trade is fetched on-chain by
// the contract regardless — this is display only.
async function fetchTickerPrice() {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${selectedSymbol}USDT`);
    const d = await r.json();
    const price = parseFloat(d?.price);
    if (isFinite(price) && price > 0) {
      const el = $("mark-price");
      if (el) { el.textContent = fmtUsd(price); el.dataset.raw = price; }
      updateTradePreview();
    }
  } catch (e) { /* silent — indicative only */ }
}

async function fetchFundingInfo() {
  try {
    const info = await readContract("get_funding_info", [selectedSymbol]);
    const badge = $("funding-badge");
    if (badge) {
      const rateBps = Number(info.last_rate_bps || 0);
      const pct = (rateBps / 100).toFixed(3);
      const sign = rateBps > 0 ? "longs pay" : rateBps < 0 ? "shorts pay" : "flat";
      badge.textContent = `funding ${pct}% (${sign})`;
    }
  } catch (e) { /* ignore */ }
}

function loadTradingView() {
  const iframe = $("tradingview-chart");
  if (!iframe) return;
  const symbol = tvSymbol(selectedSymbol);
  iframe.src = `https://www.tradingview.com/widgetembed/?frameElementId=tradingview-chart&symbol=${symbol}&interval=1&hidesidetoolbar=1&symboledit=0&saveimage=0&toolbarbg=f1f3f6&studies=[]&theme=dark&style=1&timezone=Etc/UTC&studies_overrides={}&overrides={}&enabled_features=[]&disabled_features=[]&locale=en&utm_source=localhost&utm_medium=widget&utm_campaign=chart&utm_term=${symbol}`;
}

// ─── Vault status ───────────────────────────────────────────────────
async function loadVaultStatus() {
  try {
    vaultStatus = await readContract("get_vault_status");
    $("vault-balance").textContent = formatWeiToGen(vaultStatus.vault_balance) + " GEN";
    $("vault-free").textContent = formatWeiToGen(vaultStatus.free_balance) + " GEN";
    $("vault-positions").textContent = vaultStatus.total_positions ?? "0";
    const badge = $("vault-badge");
    if (badge) badge.textContent = `Vault ${formatWeiToGen(vaultStatus.free_balance, 1)} GEN free`;

    const oi = await readContract("get_open_interest", [selectedSymbol]);
    $("vault-oi").textContent = `${formatWeiToGen(oi.long, 2)} / ${formatWeiToGen(oi.short, 2)}`;
  } catch (e) { console.warn("vault status error:", e.message); }
}

// ─── Trading actions ──────────────────────────────────────────────
async function openPosition(direction) {
  const feedback = $("trade-feedback");
  const btnL = $("btn-long"), btnS = $("btn-short");
  try {
    const marginGen = parseFloat($("margin-amount").value) || 0;
    if (marginGen <= 0) throw new Error("Margin must be > 0");
    const leverage = Number($("leverage-slider").value);
    const marginWei = parseGenToWei(marginGen);
    const marginWeiHex = "0x" + marginWei.toString(16);

    btnL.disabled = true; btnS.disabled = true;
    if (feedback) { feedback.textContent = "Confirm in wallet..."; feedback.className = "text-xs text-center text-gray-400"; }

    const txHash = await writeContract("open_position", [selectedSymbol, direction, leverage], marginWeiHex);

    if (feedback) feedback.textContent = "Waiting for confirmation...";
    try {
      await getGenLayerClient().waitForTransactionReceipt({ hash: txHash, status: TransactionStatus.ACCEPTED, interval: 3000, retries: 60 });
    } catch (e) { console.warn("wait timeout:", e.message); }

    const shortTx = txHash.slice(0, 10) + "...";
    const link = `<a href="${EXPLORER_URL}/tx/${txHash}" target="_blank" class="underline text-green-300 hover:text-green-100">${shortTx}</a>`;
    if (feedback) { feedback.innerHTML = `✅ ${direction} ${selectedSymbol} ${leverage}x opened! TX: ${link}`; feedback.className = "text-xs text-center text-green-400"; }
    addLog(`Opened ${direction} ${selectedSymbol} ${leverage}x, margin ${marginGen} GEN — TX: ${link}`);

    setTimeout(() => { fetchUserPositions(); loadVaultStatus(); }, 4000);
  } catch (err) {
    if (feedback) { feedback.textContent = `❌ ${err.message}`; feedback.className = "text-xs text-center text-red-400"; }
    addLog(`Open position failed: ${err.message}`);
  } finally {
    btnL.disabled = false; btnS.disabled = false;
  }
}

async function closePosition(positionId) {
  try {
    addLog(`Closing position #${positionId}...`);
    const txHash = await writeContract("close_position", [positionId]);
    addLog(`✅ close_position(#${positionId}) TX: ${txHash.slice(0, 10)}...`);
    setTimeout(() => { fetchUserPositions(); loadVaultStatus(); }, 4000);
  } catch (e) {
    addLog(`❌ Close failed: ${e.message}`);
  }
}

async function fundVault() {
  if (!userAccount) { alert("Connect wallet first!"); return; }
  const amtStr = prompt("How many GEN to deposit into the vault (backs trader payouts)?", "10");
  if (!amtStr) return;
  const amtGen = parseFloat(amtStr);
  if (isNaN(amtGen) || amtGen <= 0) return;
  try {
    const amtWei = parseGenToWei(amtGen);
    const txHash = await writeContract("fund_vault", [], "0x" + amtWei.toString(16));
    addLog(`💰 fund_vault(${amtGen} GEN) TX: ${txHash.slice(0, 10)}...`);
    setTimeout(loadVaultStatus, 4000);
  } catch (e) {
    addLog(`❌ Fund vault failed: ${e.message}`);
  }
}

// ─── Positions table ──────────────────────────────────────────────
async function fetchUserPositions() {
  if (!userAccount) return;
  const tbody = $("positions-body");
  const stats = $("positions-stats");
  try {
    const raw = await readContract("get_user_positions", [userAccount.toLowerCase()]);
    const positions = (typeof raw === "string" ? JSON.parse(raw) : raw) || [];
    if (positions.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" class="px-4 py-8 text-center text-gray-600">No positions yet</td></tr>`;
      if (stats) stats.textContent = "";
      return;
    }
    const open = positions.filter(p => p.status === "OPEN");
    const estimates = await Promise.all(open.map(p => readContract("estimate_position", [p.id]).catch(() => null)));
    const estByfId = {};
    open.forEach((p, i) => { estByfId[p.id] = estimates[i]; });

    const rows = [...positions].reverse().map(p => {
      const est = p.status === "OPEN" ? estByfId[p.id] : null;
      const dirBadge = p.direction === "LONG"
        ? `<span class="text-green-400">▲ LONG</span>` : `<span class="text-red-400">▼ SHORT</span>`;
      let pnlCell = "—";
      if (est && !est.error) {
        const pnl = Number(est.unrealized_pnl);
        const pnlGen = (pnl / 1e18).toFixed(4);
        const roi = est.roi_pct;
        const cls = pnl >= 0 ? "text-green-400" : "text-red-400";
        pnlCell = `<span class="${cls}">${pnl >= 0 ? "+" : ""}${pnlGen} GEN (${roi}%)</span>`;
      } else if (p.status !== "OPEN") {
        const pnl = Number(p.realized_pnl || 0) / 1e18;
        const cls = pnl >= 0 ? "text-green-400" : "text-red-400";
        pnlCell = `<span class="${cls}">${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} GEN (realized)</span>`;
      }
      const statusBadge = p.status === "OPEN"
        ? '<span class="text-yellow-400">OPEN</span>'
        : p.status === "LIQUIDATED"
        ? '<span class="text-red-500">LIQUIDATED</span>'
        : '<span class="text-gray-500">CLOSED</span>';
      const action = p.status === "OPEN"
        ? `<button class="px-2 py-1 text-xs bg-white text-black rounded font-semibold hover:bg-gray-200" onclick="closePosition(${p.id})">Close</button>`
        : `<span class="text-gray-700">—</span>`;
      return `<tr class="hover:bg-white/5 transition-colors">
        <td class="px-4 py-3 mono">#${p.id}</td>
        <td class="px-4 py-3">${p.symbol}</td>
        <td class="px-4 py-3 text-center">${dirBadge}</td>
        <td class="px-4 py-3 text-center mono">${p.leverage}x</td>
        <td class="px-4 py-3 text-center mono">${formatWeiToGen(p.margin)}</td>
        <td class="px-4 py-3 text-center mono">${fmtUsd(p.entry_price)}</td>
        <td class="px-4 py-3 text-center mono text-gray-500">${fmtUsd(p.liq_price_estimate)}</td>
        <td class="px-4 py-3 text-center">${pnlCell}</td>
        <td class="px-4 py-3 text-center">${statusBadge}</td>
        <td class="px-4 py-3 text-right">${action}</td>
      </tr>`;
    }).join("");
    tbody.innerHTML = rows;
    if (stats) stats.textContent = `${positions.length} position${positions.length > 1 ? "s" : ""} · ${open.length} open`;
  } catch (e) {
    console.warn("fetchUserPositions error:", e.message);
  }
}

// ─── Wallet ─────────────────────────────────────────────────────────
const WALLET_CACHE_KEY = "genperp_last_wallet";
function cacheWallet(a) { try { localStorage.setItem(WALLET_CACHE_KEY, a.toLowerCase()); } catch (e) {} }
function getCachedWallet() { try { return localStorage.getItem(WALLET_CACHE_KEY); } catch (e) { return null; } }

async function waitForProvider(maxMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (window.ethereum || window.okxwallet) break;
    await new Promise(r => setTimeout(r, 100));
  }
  return getProvider();
}

async function updateWalletBalance() {
  if (!userAccount) return;
  try {
    const provider = getProvider();
    const balanceWei = await provider.request({ method: "eth_getBalance", params: [userAccount, "latest"] });
    const el = $("wallet-balance");
    if (el) { el.textContent = `${formatWeiToGen(BigInt(balanceWei), 2)} GEN`; el.classList.remove("hidden"); }
  } catch (e) { console.warn("balance fetch failed:", e); }
}

async function connectWallet() {
  if (!CONFIG.contractAddress) { openConfig(); return; }
  const label = $("connection-label"), btn = $("btn-connect");
  const provider = getProvider();
  if (!provider) { addLog("❌ No wallet detected. Install MetaMask or OKX Wallet."); return; }
  try {
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    userAccount = accounts[0];
    cacheWallet(userAccount);
    await ensureStudioChain();
    if (label) { label.textContent = userAccount.slice(0, 8) + "..."; label.classList.remove("hidden"); }
    if (btn) btn.textContent = "Connected";
    addLog(`Connected: ${userAccount.slice(0, 10)}...`);
    updateWalletBalance();
    fetchUserPositions();

    provider.on("accountsChanged", (accs) => {
      if (accs.length === 0) { disconnectWallet(); }
      else { userAccount = accs[0]; cacheWallet(userAccount); if (label) label.textContent = userAccount.slice(0, 8) + "..."; fetchUserPositions(); }
    });
    provider.on("chainChanged", () => connectWallet());

    startPolling();
  } catch (e) {
    if (label) label.textContent = "Rejected";
    if (btn) btn.textContent = "Connect";
    addLog(`Connection failed: ${e.message}`);
  }
}

function disconnectWallet() {
  userAccount = null;
  const label = $("connection-label"); if (label) { label.textContent = "Disconnected"; label.classList.add("hidden"); }
  const bal = $("wallet-balance"); if (bal) bal.classList.add("hidden");
  const btn = $("btn-connect"); if (btn) btn.textContent = "Connect";
  addLog("Wallet disconnected");
}

// ─── Config modal ───────────────────────────────────────────────────
function openConfig() {
  $("input-rpc").value = CONFIG.backendUrl;
  $("input-contract").value = CONFIG.contractAddress;
  $("config-modal").classList.remove("hidden");
}
function closeConfig() { $("config-modal").classList.add("hidden"); }
function saveConfig() {
  CONFIG.backendUrl = $("input-rpc").value.trim();
  CONFIG.contractAddress = $("input-contract").value.trim();
  localStorage.setItem("backend_url", CONFIG.backendUrl);
  localStorage.setItem("contract_address", CONFIG.contractAddress);
  closeConfig();
  loadMarkets(); loadVaultStatus();
  connectWallet();
}

// ─── Polling ────────────────────────────────────────────────────────
// The GenLayer Studio RPC caps requests at ~30/minute, shared across every browser
// tab and the keeper. Market configs only change on an admin call, so refreshing
// them every tick wastes most of that budget — reload them occasionally instead.
let _pollTick = 0;
const MARKETS_EVERY_N_POLLS = 10;

function startPolling() {
  if (pollInterval) clearInterval(pollInterval);
  if (tickerInterval) clearInterval(tickerInterval);
  loadMarkets(); loadVaultStatus(); fetchFundingInfo();
  pollInterval = setInterval(() => {
    _pollTick++;
    if (_pollTick % MARKETS_EVERY_N_POLLS === 0) loadMarkets();
    loadVaultStatus();
    fetchFundingInfo();
    if (userAccount) { fetchUserPositions(); updateWalletBalance(); }
  }, 12000);
  tickerInterval = setInterval(fetchTickerPrice, 15000);
}

// ─── Init ───────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  try {
    const r = await fetch(CONFIG.backendUrl + "/api/config");
    const d = await r.json();
    if (d.contractAddress) CONFIG.contractAddress = d.contractAddress;
  } catch (e) { console.warn("Failed to load config from backend, using default."); }

  localStorage.removeItem("backend_url");
  localStorage.removeItem("contract_address");

  renderMarketTabs();
  loadTradingView();
  fetchTickerPrice();
  startPolling();

  const cached = getCachedWallet();
  const initProvider = await waitForProvider();
  if (cached && initProvider) {
    initProvider.request({ method: "eth_accounts" }).then(async (accounts) => {
      if (accounts && accounts.find(a => a.toLowerCase() === cached)) {
        addLog("↻ Auto-reconnecting cached wallet...");
        await connectWallet();
      }
    }).catch(() => {});
  }

  $("margin-amount").addEventListener("input", updateTradePreview);
});

// ─── Exports for inline HTML handlers ────────────────────────────────
window.connectWallet = connectWallet;
window.disconnectWallet = disconnectWallet;
window.selectMarket = selectMarket;
window.onLeverageChange = onLeverageChange;
window.openPosition = openPosition;
window.closePosition = closePosition;
window.fundVault = fundVault;
window.openConfig = openConfig;
window.closeConfig = closeConfig;
window.saveConfig = saveConfig;
