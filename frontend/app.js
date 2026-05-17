/**
 * BTC Up/Down Market — Frontend Application
 *
 * Users connect their own wallet (MetaMask / GenLayer Wallet).
 * Reads go through backend proxy. Writes are signed by user's wallet.
 */
import { createClient } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import { TransactionStatus } from 'genlayer-js/types';

// ─── Configuration ──────────────────────────────────────────────────
let CONFIG = {
  backendUrl: "https://genlayerpredict.onrender.com",
  contractAddress: "0x59273820Cb0B52FcaBbAEF518fBd8e8af30da93b",
};

const STUDIO_CHAIN_ID = "0xF22F"; // 61999
const STUDIO_RPC = "https://studio.genlayer.com/api";
const EXPLORER_URL = "https://explorer-studio.genlayer.com";

// ─── Safe GEN → Wei conversion (avoids float precision bugs) ────────
function parseGenToWei(value) {
  const str = String(value).trim();
  const [whole, frac = ""] = str.split(".");
  const fracPadded = (frac + "0".repeat(18)).slice(0, 18);
  return BigInt(whole || "0") * (10n ** 18n) + BigInt(fracPadded);
}

let pollInterval = null;
let userAccount = null;
let selectedRoundId = null; // null = current round
let localBet = null; // { roundId, direction, amount } — tracks pending bet before finalization
let currentRoundId = 0;

// Safe DOM helper
const $ = (id) => document.getElementById(id);

// ─── Formatters ───────────────────────────────────────────
function formatWeiToGen(value) {
  try { return (BigInt(value) / 10n ** 18n).toString(); }
  catch { return "0"; }
}

function renderHistoryStatus(status) {
  const map = {
    PENDING: `<span class="text-yellow-400 animate-pulse">⏳ PENDING</span>`,
    CLAIM:   `<span class="text-green-400 font-semibold">💰 CLAIM</span>`,
    CLAIMED: `<span class="text-gray-500">✅ CLAIMED</span>`,
    LOST:    `<span class="text-red-400">❌ LOST</span>`,
  };
  return map[status] || `<span class="text-gray-400">${status}</span>`;
}

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
    _backendErrorCount = 0; // reset on success
    _backendPaused = false;
    return data;
  } catch (e) {
    _backendErrorCount++;
    if (_backendErrorCount >= 3) {
      _backendPaused = true;
      setTimeout(() => { _backendPaused = false; _backendErrorCount = 0; }, 60000); // thử lại sau 1 phút
      addLog("⚠️ Backend unreachable — pausing polls for 60s");
    }
    throw e;
  }
}

async function readContract(functionName, args = []) {
  return apiCall("/api/call", {
    method: "POST",
    body: JSON.stringify({ method: functionName, args, type: "read" }),
  });
}

// ─── GenLayer Client ─────────────────────────────────────────────────

let _glClient = null;

function getGenLayerClient() {
  if (!_glClient) {
    _glClient = createClient({
      chain: studionet,
      account: userAccount,
    });
  }
  if (_glClient._account !== userAccount) {
    _glClient = createClient({
      chain: studionet,
      account: userAccount,
    });
  }
  return _glClient;
}

// ─── Wallet Write ────────────────────────────────────────────────────

async function writeContract(functionName, args = [], valueWei = "0x0") {
  if (!getProvider()) throw new Error("No wallet detected");
  if (!userAccount) throw new Error("Wallet not connected");

  const client = getGenLayerClient();
  await client.connect("studionet");

  const valueBigInt = typeof valueWei === "string" ? BigInt(valueWei) : BigInt(valueWei);

  const txHash = await client.writeContract({
    address: CONFIG.contractAddress,
    functionName: functionName,
    args: args,
    value: valueBigInt,
  });

  addLog(`TX sent: ${functionName}() → ${txHash.slice(0, 14)}...`);
  return txHash;
}

// ─── Chain Management ────────────────────────────────────────────────

async function ensureStudioChain() {
  const currentChainId = await getProvider().request({ method: "eth_chainId" });
  if (currentChainId === STUDIO_CHAIN_ID) return;

  try {
    await getProvider().request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: STUDIO_CHAIN_ID }],
    });
  } catch (switchError) {
    if (switchError.code === 4902) {
      await getProvider().request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: STUDIO_CHAIN_ID,
          chainName: "GenLayer Studio",
          rpcUrls: [STUDIO_RPC],
          nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
          blockExplorerUrls: ["https://explorer-studio.genlayer.com"],
        }],
      });
    } else {
      throw switchError;
    }
  }
}

// ─── UI Updaters ────────────────────────────────────────────────────

function updateRoundUI(data) {
  if (!data) return;

  const roundId = Number(data.round_id || 0);
  const status = data.status || "IDLE";
  const startPrice = Number(data.start_price || 0);
  const endPrice = Number(data.end_price || 0);
  const upCount = Number(data.up_count || 0);
  const downCount = Number(data.down_count || 0);
  const winner = data.winner || "NONE";
  const roundStart = Number(data.round_start_time || 0);
  const bettingSec = Number(data.betting_seconds || 300);
  const lockSec = Number(data.lock_seconds || 300);
  const upPool = data.up_pool || "0";
  const downPool = data.down_pool || "0";
  const totalRounds = Number(data.total_rounds || 0);

  // Round ID
  const rid = $("round-id"); if (rid) rid.textContent = `#${roundId || 0}`;

  // Status badge
  const badge = $("round-status-badge");
  if (badge) {
    badge.textContent = status;
    const colors = { OPEN: "#4ade80", LOCKED: "#facc15", RESOLVED: "#60a5fa", IDLE: "#9ca3af" };
    badge.style.color = colors[status] || "#9ca3af";
  }

  // Prices — span already in HTML, just set text (no $ prefix in JS)
  const op = $("open-price"); if (op) op.textContent = startPrice > 0 ? `$${startPrice.toLocaleString()}` : "$—";
  const cp = $("close-price"); if (cp) cp.textContent = endPrice > 0 ? `$${endPrice.toLocaleString()}` : "$—";

  // Arrow
  const arrow = $("price-arrow");
  if (arrow) {
    if (status === "RESOLVED") {
      if (endPrice > startPrice) { arrow.textContent = "▲"; arrow.style.color = "#4ade80"; }
      else if (endPrice < startPrice) { arrow.textContent = "▼"; arrow.style.color = "#f87171"; }
      else { arrow.textContent = "="; arrow.style.color = "#9ca3af"; }
    } else { arrow.textContent = "→"; arrow.style.color = "#9ca3af"; }
  }

  // Vote counts
  const uc = $("up-count"); if (uc) uc.textContent = upCount;
  const dc = $("down-count"); if (dc) dc.textContent = downCount;

  // Pools
  try {
    const upPoolGen = (BigInt(upPool) / BigInt(1e18)).toString();
    const downPoolGen = (BigInt(downPool) / BigInt(1e18)).toString();
    const pu = $("pool-up"); if (pu) pu.textContent = upPoolGen + " GEN";
    const pd = $("pool-down"); if (pd) pd.textContent = downPoolGen + " GEN";
  } catch(e) {}

  // Timer
  updateTimer(status, roundStart, bettingSec, lockSec, roundId);

  // Round selector
  renderRoundSelector(totalRounds, roundId);

  // Winner banner
  const banner = $("winner-banner");
  const winnerText = $("winner-text");
  const winnerIcon = $("winner-icon");
  if (banner && winnerText && winnerIcon) {
    if (status === "RESOLVED") {
      banner.classList.remove("hidden");
      if (winner === "UP") { winnerIcon.textContent = "🟢"; winnerText.textContent = "UP Wins! Price went up."; }
      else if (winner === "DOWN") { winnerIcon.textContent = "🔴"; winnerText.textContent = "DOWN Wins! Price went down."; }
      else { winnerIcon.textContent = "⚪"; winnerText.textContent = "DRAW — Price unchanged."; }
    } else { banner.classList.add("hidden"); }
  }

  // Disable/enable bet controls
  const now = Math.floor(Date.now() / 1000);
  const remaining = Math.max(0, roundStart + bettingSec - now);
  const hasLocalBet = localBet && localBet.roundId === roundId;
  const canBet = status === "OPEN" && remaining > 0 && !hasLocalBet;
  const bu = $("btn-up"); if (bu) bu.disabled = !canBet;
  const bd = $("btn-down"); if (bd) bd.disabled = !canBet;
  const ba = $("bet-amount"); if (ba) ba.disabled = !canBet;

  // Reset localBet if round changed
  if (roundId !== currentRoundId) {
    currentRoundId = roundId;
    localBet = null;
  }
}

function updateTimer(status, roundStart, bettingSec, lockSec, roundId) {
  const fill  = $("timer-fill");
  const text  = $("timer-text");
  const sub   = $("timer-sub");
  const label = $("phase-label");
  if (!text) return;
  const now = Math.floor(Date.now() / 1000);
  const bettingEnd = roundStart + bettingSec;
  const lockEnd    = roundStart + bettingSec + lockSec;
  const rid = roundId || 0;

  if (status === "OPEN") {
    const elapsed   = now - roundStart;
    const remaining = Math.max(0, bettingEnd - now);
    if (remaining > 0) {
      const pct = Math.min(100, (elapsed / bettingSec) * 100);
      if (fill)  { fill.style.width = pct + "%"; fill.style.background = "#4ade80"; }
      if (label) { label.textContent = `Round #${rid} · Betting Open`; label.style.color = "#4ade80"; }
      text.textContent = formatTime(remaining);
      if (sub) sub.textContent = "Place your UP/DOWN prediction";
    } else {
      if (fill)  { fill.style.width = "100%"; fill.style.background = "#f59e0b"; }
      if (label) { label.textContent = `Round #${rid} · Waiting lock...`; label.style.color = "#f59e0b"; }
      text.textContent = "Waiting lock...";
      if (sub) sub.textContent = "On-chain status is still OPEN. Backend must lock this round.";
    }
  } else if (status === "LOCKED") {
    const elapsed   = now - bettingEnd;
    const remaining = Math.max(0, lockEnd - now);
    if (remaining > 0) {
      const pct = Math.min(100, (elapsed / lockSec) * 100);
      if (fill)  { fill.style.width = pct + "%"; fill.style.background = "#facc15"; }
      if (label) { label.textContent = `Round #${rid} · Locked`; label.style.color = "#facc15"; }
      text.textContent = formatTime(remaining);
      if (sub) sub.textContent = "BTC price moving — oracle resolves after timer";
    } else {
      if (fill)  { fill.style.width = "100%"; fill.style.background = "#f59e0b"; }
      if (label) { label.textContent = `Round #${rid} · Resolving...`; label.style.color = "#f59e0b"; }
      text.textContent = "Resolving...";
      if (sub) sub.textContent = "⏳ GenLayer validators fetching final BTC price";
    }
  } else if (status === "RESOLVED") {
    if (fill)  { fill.style.width = "100%"; fill.style.background = "#4ade80"; }
    if (label) { label.textContent = `Round #${rid} · Resolved`; label.style.color = "#4ade80"; }
    text.textContent = "Resolved";
    if (sub) sub.textContent = roundStart === 0 ? "✅ Round finished" : "✅ Next round starting soon";
  } else {
    if (fill)  { fill.style.width = "0%"; fill.style.background = "#fff"; }
    if (label) { label.textContent = "Waiting for round..."; label.style.color = "#9ca3af"; }
    text.textContent = "—";
    if (sub) sub.textContent = "Round will start automatically";
  }
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function updateMyBetUI(data) {
  const el = $("my-bet-info");
  if (!el) return;
  if (!data || !data.vote) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  const side = $("my-bet-side"); if (side) side.textContent = data.vote;
  try {
    const amt = (BigInt(data.amount) / BigInt(1e18)).toString();
    const ma = $("my-bet-amount"); if (ma) ma.textContent = amt;
  } catch(e) {
    const ma = $("my-bet-amount"); if (ma) ma.textContent = "0";
  }
}

// ─── Activity Log ───────────────────────────────────────────────────

function addLog(msg) {
  const log = $("activity-log");
  if (!log) { console.log("[LOG]", msg); return; }
  const empty = log.querySelector(".log-empty");
  if (empty) empty.remove();

  const entry = document.createElement("div");
  entry.className = "log-entry";
  const now = new Date().toLocaleTimeString();
  entry.innerHTML = `<span class="log-time">${now}</span>${msg}`;
  log.prepend(entry);

  while (log.children.length > 50) log.lastChild.remove();
}

// ─── Actions ────────────────────────────────────────────────────────

async function placeBet(direction) {
  const feedback = $("vote-feedback");
  const betInput = $("bet-amount");
  try {
    const amountGen = parseFloat(betInput?.value) || 1;
    if (amountGen <= 0) throw new Error("Bet amount must be > 0");
    const amountWei = parseGenToWei(amountGen);
    
    const roundIdNow = Number($("round-id").textContent.replace("#", "") || 0);
    const entryPrice = document.getElementById("current-btc-price")?.textContent || "";
    if (entryPrice) {
      try {
        const metas = JSON.parse(localStorage.getItem("bet_meta") || "{}");
        metas[roundIdNow] = entryPrice;
        localStorage.setItem("bet_meta", JSON.stringify(metas));
      } catch(e) {}
    }
    const amountWeiHex = "0x" + amountWei.toString(16);

    if (feedback) { feedback.textContent = "Confirm in wallet..."; feedback.className = "vote-feedback"; }

    const fn = direction === "UP" ? "bet_up" : "bet_down";
    const txHash = await writeContract(fn, [], amountWeiHex);

    // Cập nhật UI: đang chờ confirm
    if (feedback) {
      feedback.textContent = "Waiting for confirmation...";
      feedback.className = "vote-feedback";
    }

    try {
      const client = getGenLayerClient();
      await client.waitForTransactionReceipt({
        hash: txHash,
        status: TransactionStatus.ACCEPTED,
        interval: 3000,
        retries: 40,
      });
      addLog(`✅ TX accepted: ${fn}`);
    } catch (waitErr) {
      console.warn("TX wait timeout:", waitErr.message);
      addLog(`⚠️ TX confirmation timeout — sẽ retry qua polling`);
    }

    // Set localBet immediately to block re-betting
    localBet = { roundId: roundIdNow, direction, amount: amountGen };

    // Disable buttons immediately
    const bu = $("btn-up"); if (bu) bu.disabled = true;
    const bd = $("btn-down"); if (bd) bd.disabled = true;
    const ba = $("bet-amount"); if (ba) ba.disabled = true;

    if (feedback) { 
      const shortTx = txHash.slice(0, 10) + "...";
      const explorerLink = `<a href="${EXPLORER_URL}/tx/${txHash}" target="_blank" class="underline text-green-300 hover:text-green-100">${shortTx}</a>`;
      feedback.innerHTML = `✅ Voted ${direction} ${amountGen} GEN! TX: ${explorerLink}`; 
      feedback.className = "vote-feedback success"; 
    }
    const logShortTx = txHash.slice(0, 10) + "...";
    const logLink = `<a href="${EXPLORER_URL}/tx/${txHash}" target="_blank" class="underline hover:text-white">${logShortTx}</a>`;
    addLog(`Voted ${direction} — TX: ${logLink}`);

    // Retry history polling until bet appears on-chain (up to 3 min)
    // startHistoryRetry also renders the optimistic row immediately
    startHistoryRetry(roundIdNow, direction, amountGen, entryPrice);

    await pollRound();
  } catch (err) {
    if (feedback) { feedback.textContent = `❌ ${err.message}`; feedback.className = "vote-feedback error"; }
    addLog(`Vote failed: ${err.message}`);
  }
}

// ─── Round Selector ──────────────────────────────────────────────────

function renderRoundSelector(totalRounds, currentRoundId) {
  const container = $("round-selector");
  if (!container) return;
  let html = '<span class="text-xs text-gray-500 mr-2 whitespace-nowrap">Rounds:</span>';
  for (let r = totalRounds; r >= 1; r--) {
    const active = (selectedRoundId === r || (selectedRoundId === null && r === currentRoundId));
    const cls = active
      ? "px-3 py-1 text-xs rounded-full bg-white text-black font-semibold cursor-pointer whitespace-nowrap"
      : "px-3 py-1 text-xs rounded-full bg-[#1a1a1a] text-gray-400 hover:bg-[#2a2a2a] cursor-pointer whitespace-nowrap";
    html += `<span class="${cls}" onclick="selectRound(${r})">#${r}</span>`;
  }
  // "Live" button for current round
  const liveActive = (selectedRoundId === null);
  const liveCls = liveActive
    ? "px-3 py-1 text-xs rounded-full bg-green-600 text-white font-semibold cursor-pointer whitespace-nowrap"
    : "px-3 py-1 text-xs rounded-full bg-[#1a1a1a] text-gray-400 hover:bg-[#2a2a2a] cursor-pointer whitespace-nowrap";
  html = `<span class="${liveCls}" onclick="selectRound(null)">● LIVE</span>` + html;
  container.innerHTML = html;
}

function selectRound(roundId) {
  selectedRoundId = roundId;
  if (roundId !== null) {
    fetchParticipants(roundId);
  } else {
    const panel = $("participants-panel");
    if (panel) panel.classList.add("hidden");
  }
  // Re-render round selector
  pollRound();
}

async function fetchParticipants(roundId) {
  const panel = $("participants-panel");
  const list = $("participants-list");
  if (!panel || !list) return;
  try {
    const raw = await readContract("get_round_participants", [roundId]);
    const parts = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parts || parts.length === 0) {
      list.innerHTML = '<span class="text-gray-600">No participants</span>';
    } else {
      list.innerHTML = parts.map((addr, i) => {
        const short = addr.slice(0, 6) + "…" + addr.slice(-4);
        return `<div class="flex items-center gap-2">
          <span class="text-gray-600 w-4">${i + 1}.</span>
          <span class="font-mono text-gray-300">${short}</span>
        </div>`;
      }).join("");
    }
    panel.classList.remove("hidden");
  } catch (e) {
    panel.classList.add("hidden");
  }
}

async function claimWinnings(roundId) {
  if (!userAccount) return;
  try {
    addLog(`Claiming winnings for round #${roundId}...`);
    await writeContract("claim", [roundId]);
    addLog(`✅ Claim TX sent for round #${roundId}`);
    setTimeout(() => { pollRound(); fetchUserHistory(); }, 5000);
  } catch (e) {
    addLog(`❌ Claim failed: ${e.message}`);
  }
}

// ─── Polling ────────────────────────────────────────────────────────

async function pollRound() {
  try {
    const liveData = await readContract("get_round");
    let displayData = liveData;

    if (selectedRoundId !== null && selectedRoundId !== Number(liveData.round_id || 0)) {
      const res = await readContract("get_round_result", [selectedRoundId]);
      if (res && typeof res === "string" && res !== "") {
        const pastData = JSON.parse(res);
        displayData = {
          round_id: pastData.round_id,
          status: "RESOLVED",
          start_price: pastData.start_price,
          end_price: pastData.end_price,
          winner: pastData.winner,
          round_start_time: 0,
          betting_seconds: 0,
          lock_seconds: 0,
          up_pool: pastData.up_pool,
          down_pool: pastData.down_pool,
          up_count: pastData.up_count,
          down_count: pastData.down_count,
          total_rounds: liveData.total_rounds
        };
      } else {
        displayData = {
          round_id: selectedRoundId,
          status: "IDLE",
          start_price: 0,
          end_price: 0,
          winner: "NONE",
          round_start_time: 0,
          betting_seconds: 0,
          lock_seconds: 0,
          up_pool: "0",
          down_pool: "0",
          up_count: 0,
          down_count: 0,
          total_rounds: liveData.total_rounds
        };
      }
    }

    updateRoundUI(displayData);
  } catch (err) {
    console.warn("Poll error:", err.message);
  }

  // Poll user's bet info if connected
  if (userAccount) {
    // Bug #1 fix: separate try-catch so fetchUserHistory always runs
    try {
      const myBet = await readContract("get_my_bet", [userAccount]);
      updateMyBetUI(myBet);
      if (myBet.vote) {
        const payout = await readContract("get_payout", [userAccount]);
        const mp = $("my-bet-payout");
        if (mp) mp.textContent = payout !== "0" ? (BigInt(payout) / BigInt(1e18)).toString() + " GEN" : "—";
      }
    } catch (e) {
      console.warn("get_my_bet error:", e.message);
    }

    // fetchUserHistory ALWAYS runs, independent try-catch
    try {
      await fetchUserHistory();
    } catch (e) {
      console.warn("fetchUserHistory error:", e.message);
    }
  }
}

// ─── History retry after bet ────────────────────────────────────
let _historyRetryTimer = null;
function startHistoryRetry(roundId, direction, amountGen, entryPrice) {
  if (_historyRetryTimer) clearInterval(_historyRetryTimer);
  let attempts = 0;
  const MAX = 36; // 36 x 5s = 3 minutes

  // Show optimistic row immediately
  const tbody = document.getElementById("history-body");
  if (tbody) {
    const emptyRow = tbody.querySelector("td[colspan='7']") || tbody.querySelector("td[colspan='8']");
    if (emptyRow) emptyRow.parentElement.remove();
    const existing = document.getElementById("optimistic-row");
    if (!existing) {
      const voteBadge = direction === "UP" ? '<span class="text-green-400">↑ UP</span>' : '<span class="text-red-400">↓ DOWN</span>';
      tbody.insertAdjacentHTML('afterbegin', `<tr id="optimistic-row" class="hover:bg-white/5 transition-colors opacity-70">
        <td class="px-4 py-3 font-mono">#${roundId}</td>
        <td class="px-4 py-3 text-center">${voteBadge}</td>
        <td class="px-4 py-3 text-white text-center">${amountGen} GEN</td>
        <td class="px-4 py-3 text-center font-mono">${entryPrice || "..."}</td>
        <td class="px-4 py-3 text-center font-mono text-gray-500">...</td>
        <td class="px-4 py-3 text-center"><span class="text-gray-400">OPEN</span></td>
        <td class="px-4 py-3 text-center"><span class="text-yellow-400 animate-pulse">⏳ CONFIRMING</span></td>
        <td class="px-4 py-3 text-right"><span class="text-gray-600">—</span></td>
      </tr>`);
    }
    const statsEl = document.getElementById("history-stats");
    if (statsEl && !statsEl.textContent) statsEl.textContent = "1 bet · pending";
  }

  _historyRetryTimer = setInterval(async () => {
    attempts++;
    try {
      // Fast check if the specific bet is on-chain
      const betOnChain = await readContract("get_user_bet_for_round", [roundId, userAccount.toLowerCase()]);
      
      if (betOnChain && betOnChain !== "") {
        console.log("ONCHAIN BET CONFIRMED:", betOnChain);
        clearInterval(_historyRetryTimer);
        _historyRetryTimer = null;
        
        // Fetch full history to get all details right
        const raw = await readContract("get_user_history", [userAccount.toLowerCase()]);
        const history = typeof raw === "string" ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
        
        const opt = document.getElementById("optimistic-row");
        if (opt) opt.remove();
        
        renderUserHistory(history);
        addLog("✅ Bet confirmed on-chain!");
        return;
      }
    } catch (e) { /* silent */ }
    
    if (attempts >= MAX) {
      clearInterval(_historyRetryTimer);
      _historyRetryTimer = null;
      // Update optimistic row to PENDING state
      const opt = document.getElementById("optimistic-row");
      if (opt) {
        const statusCell = opt.querySelector("td:nth-child(6)");
        if (statusCell) statusCell.innerHTML = '<span class="text-yellow-400">⏳ PENDING</span>';
      }
    }
  }, 5000);
}

// ─── Wallet Cache ──────────────────────────────────────────
const WALLET_CACHE_KEY = "genlayer_last_wallet";

function cacheWallet(address) {
  try { localStorage.setItem(WALLET_CACHE_KEY, address.toLowerCase()); } catch(e) {}
}

function getCachedWallet() {
  try { return localStorage.getItem(WALLET_CACHE_KEY); } catch(e) { return null; }
}

function clearWalletCache() {
  try { localStorage.removeItem(WALLET_CACHE_KEY); } catch(e) {}
}

async function fetchUserHistory() {
  if (!userAccount) return;
  try {
    const raw = await readContract("get_user_history", [userAccount.toLowerCase()]);
    const history = typeof raw === "string" ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
    
    const opt = document.getElementById("optimistic-row");
    if ((!history || history.length === 0) && opt) {
      return; // Do not overwrite optimistic row if on-chain history is still empty
    }
    
    // If optimistic row is present and history doesn't have it yet, we preserve it
    if (opt && history.length > 0) {
      const optHtml = opt.outerHTML;
      opt.remove();
      renderUserHistory(history);
      const tbody = document.getElementById("history-body");
      if (tbody && !history.some(h => String(h.round_id) === String($("round-id").textContent.replace("#", "")))) {
        tbody.insertAdjacentHTML('afterbegin', optHtml);
      }
    } else {
      renderUserHistory(history);
    }
  } catch (e) {
    console.warn("History fetch error:", e.message);
  }
}

// Bug #4 fix: retry wrapper for Render cold start
async function fetchUserHistoryWithRetry(maxRetries = 3, delayMs = 3000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await fetchUserHistory();
      return; // success
    } catch (e) {
      console.warn(`History fetch attempt ${i + 1}/${maxRetries} failed:`, e.message);
      if (i < maxRetries - 1) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  console.warn("All history fetch retries exhausted");
}

function renderUserHistory(history) {
  const tbody = document.getElementById("history-body");
  const stats = document.getElementById("history-stats");
  if (!tbody) return;

  if (!history || history.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="px-4 py-8 text-center text-gray-600">No bets yet for this wallet</td></tr>`;
    if (stats) stats.textContent = "";
    return;
  }
  
  let metas = {};
  try { metas = JSON.parse(localStorage.getItem("bet_meta") || "{}"); } catch(e) {}

  let wins = 0;
  const rows = [...history].reverse().map(h => {
    const amtGen = formatWeiToGen(h.amount);
    if (h.won) wins++;
    const voteBadge = h.vote === "UP"
      ? `<span class="text-green-400">↑ UP</span>`
      : `<span class="text-red-400">↓ DOWN</span>`;
    const winnerBadge = h.winner === "UP"
      ? `<span class="text-green-400">UP</span>`
      : h.winner === "DOWN"
      ? `<span class="text-red-400">DOWN</span>`
      : h.winner === "DRAW"
      ? `<span class="text-gray-400">DRAW</span>`
      : `<span class="text-gray-500">PENDING</span>`;
    const actionHtml = h.status === "CLAIM"
      ? `<button class="px-2 py-1 text-xs bg-green-600 hover:bg-green-500 text-white rounded font-semibold" onclick="claimWinnings(${h.round_id})">Claim</button>`
      : `<span class="text-gray-600">—</span>`;
      
    const entryPrice = metas[h.round_id] || "—";
    
    return `<tr class="hover:bg-white/5 transition-colors">
      <td class="px-4 py-3 font-mono">#${h.round_id}</td>
      <td class="px-4 py-3 text-center">${voteBadge}</td>
      <td class="px-4 py-3 text-white text-center">${amtGen} GEN</td>
      <td class="px-4 py-3 text-center font-mono">${entryPrice}</td>
      <td class="px-4 py-3 text-center font-mono text-gray-400">$${h.start_price} → $${h.end_price}</td>
      <td class="px-4 py-3 text-center">${winnerBadge}</td>
      <td class="px-4 py-3 text-center">${renderHistoryStatus(h.status)}</td>
      <td class="px-4 py-3 text-right">${actionHtml}</td>
    </tr>`;
  }).join("");

  tbody.innerHTML = rows;
  if (stats) stats.textContent = `${history.length} bet${history.length > 1 ? 's' : ''} · ${wins} win${wins !== 1 ? 's' : ''}`;
}

function startPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollRound();
  pollInterval = setInterval(() => {
    pollRound();
  }, 15000);
}

// Helper: detect wallet provider (MetaMask, OKX, etc.)
function getProvider() {
  if (window.ethereum) return window.ethereum;
  if (window.okxwallet) return window.okxwallet;
  return null;
}

async function connectWallet() {
  if (!CONFIG.contractAddress) {
    openConfig();
    return;
  }

  const dot = $("connection-status");
  const label = $("connection-label");
  const btn = $("btn-connect");

  const provider = getProvider();
  if (!provider) {
    if (dot) dot.className = "status-dot status-dot--disconnected";
    if (label) label.textContent = "No wallet found";
    addLog("❌ No wallet detected. Install MetaMask or OKX Wallet.");
    return;
  }

  try {
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    userAccount = accounts[0];
    cacheWallet(userAccount);

    await ensureStudioChain();

    if (dot) dot.className = "status-dot status-dot--connected";
    if (label) label.textContent = userAccount.slice(0, 8) + "...";
    if (btn) btn.textContent = "Connected";
    addLog(`Connected: ${userAccount.slice(0, 10)}...`);

    // Immediately load history for this wallet (with retry for Render cold start)
    fetchUserHistoryWithRetry();

    // Bug #3 fix: accountsChanged reloads history + caches new wallet
    provider.on("accountsChanged", (accs) => {
      if (accs.length === 0) {
        disconnectWallet();
        clearWalletCache();
      } else {
        userAccount = accs[0];
        cacheWallet(userAccount);
        const lbl = $("connection-label"); if (lbl) lbl.textContent = userAccount.slice(0, 8) + "...";
        addLog(`Account changed: ${userAccount.slice(0, 10)}...`);
        fetchUserHistoryWithRetry();
      }
    });

    provider.on("chainChanged", () => {
      addLog("Network changed — reconnecting...");
      connectWallet();
    });

    startPolling();
  } catch (e) {
    if (dot) dot.className = "status-dot status-dot--disconnected";
    if (label) label.textContent = "Rejected";
    if (btn) btn.textContent = "Connect";
    addLog(`Connection failed: ${e.message}`);
  }
}

function disconnectWallet() {
  userAccount = null;
  if (pollInterval) clearInterval(pollInterval);
  const dot = $("connection-status"); if (dot) dot.className = "status-dot status-dot--disconnected";
  const label = $("connection-label"); if (label) label.textContent = "Disconnected";
  const btn = $("btn-connect"); if (btn) btn.textContent = "Connect";
  addLog("Wallet disconnected");
}

// ─── Config Modal ───────────────────────────────────────────────────

function openConfig() {
  const ir = $("input-rpc"); if (ir) ir.value = CONFIG.backendUrl;
  const ic = $("input-contract"); if (ic) ic.value = CONFIG.contractAddress;
  const cm = $("config-modal"); if (cm) cm.classList.remove("hidden");
}

function closeConfig() {
  const cm = $("config-modal"); if (cm) cm.classList.add("hidden");
}

function saveConfig() {
  const ir = $("input-rpc"); if (ir) CONFIG.backendUrl = ir.value.trim();
  const ic = $("input-contract"); if (ic) CONFIG.contractAddress = ic.value.trim();
  localStorage.setItem("backend_url", CONFIG.backendUrl);
  localStorage.setItem("contract_address", CONFIG.contractAddress);
  closeConfig();
  connectWallet();
}

// ─── TradingView Widget ────────────────────────────────────────────

function loadTradingView() {
  const iframe = document.getElementById("tradingview-chart");
  if (!iframe) return;
  const url = `https://www.tradingview.com/widgetembed/?frameElementId=tradingview-chart&symbol=BINANCE:BTCUSDT&interval=1&hidesidetoolbar=1&symboledit=0&saveimage=0&toolbarbg=f1f3f6&studies=[]&theme=dark&style=1&timezone=Etc/UTC&studies_overrides={}&overrides={}&enabled_features=[]&disabled_features=[]&locale=en&utm_source=localhost&utm_medium=widget&utm_campaign=chart&utm_term=BINANCE:BTCUSDT`;
  iframe.src = url;
}

async function fetchBTCPrice() {
  try {
    const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT");
    const d = await r.json();
    const price = parseFloat(d.price);
    if (price) {
      const el = $("current-btc-price");
      if (el) el.textContent = `$${price.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    }
  } catch (e) {}
}

// ─── Init ───────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const r = await fetch(CONFIG.backendUrl + "/api/config");
    const d = await r.json();
    if (d.contractAddress) {
      CONFIG.contractAddress = d.contractAddress;
      console.log("Loaded contract address from backend:", CONFIG.contractAddress);
    }
  } catch (e) {
    console.warn("Failed to load config from backend, using default.");
  }

  loadTradingView();
  fetchBTCPrice();
  setInterval(fetchBTCPrice, 30000);
  startPolling();

  // Bug #2 fix: auto-reconnect uses connectWallet() for full event registration
  const cached = getCachedWallet();
  const initProvider = getProvider();
  if (cached && initProvider) {
    initProvider.request({ method: "eth_accounts" }).then(async (accounts) => {
      if (accounts && accounts.length > 0) {
        const matched = accounts.find(a => a.toLowerCase() === cached);
        if (matched) {
          addLog(`↻ Auto-reconnecting cached wallet...`);
          await connectWallet(); // full reconnect: events + dot + history + polling
        }
      }
    }).catch(() => {});
  }
});

// ─── Export to Window for HTML event listeners ───────────────────────
window.connectWallet = connectWallet;
window.disconnectWallet = disconnectWallet;
window.placeBet = placeBet;
window.claimBet = claimBet;
window.selectRound = selectRound;
window.openConfig = openConfig;
window.closeConfig = closeConfig;
window.saveConfig = saveConfig;
