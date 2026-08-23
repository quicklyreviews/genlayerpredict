/**
 * GenPredict home — the market list.
 *
 * Everything on this page comes from a single get_home() call. The Studio RPC
 * allows only ~30 requests/minute across every client, so fetching per-market
 * would break the page as markets are added.
 */
import {
  CONFIG, ASSET_META, $, loadConfig, readPredict, mountHeader, wallet, onWalletChange,
  autoReconnect, genFromWei, fmtCountdown, fmtHorizon, fmtUsd, fmtMultiplier, impliedPct,
  write, waitAccepted, toast, txLink, CONSENSUS_BUFFER_SECONDS,
} from './shared.js';

let markets = [];
let filterHorizon = "all";
let filterAsset = "all";
let myBets = [];

// ─── Rendering ──────────────────────────────────────────────────────

function coinBadge(symbol) {
  const meta = ASSET_META[symbol] || { color: "#555" };
  return `<span class="coin" style="background:${meta.color}">${symbol.slice(0, 3)}</span>`;
}

/** A round is only bettable while there is enough time left for a transaction to
 *  reach consensus — otherwise the user pays gas for a bet that cannot land. */
function bettableSeconds(round) {
  if (!round || round.status !== "OPEN") return -1;
  return round.lock_ts - Math.floor(Date.now() / 1000) - CONSENSUS_BUFFER_SECONDS;
}

/**
 * Decide which round the card is about, so the badge and the numbers below it can
 * never disagree. While betting is open that is the next round; once it closes the
 * card switches to the live round, whose pool is the money actually at stake.
 */
function featuredRound(m) {
  const next = m.next_round;
  const live = m.live_round;
  if (next && bettableSeconds(next) > 0) {
    return { round: next, phase: "open", left: bettableSeconds(next) };
  }
  if (live && live.status === "LOCKED") {
    return { round: live, phase: "live", left: Math.max(0, live.close_ts - Math.floor(Date.now() / 1000)) };
  }
  if (next) return { round: next, phase: "locking", left: 0 };
  return { round: null, phase: "starting", left: 0 };
}

function phasePill(f) {
  if (f.phase === "open") return `<span class="pill pill--open">Open ${fmtCountdown(f.left)}</span>`;
  if (f.phase === "live") return `<span class="pill pill--live"><span class="dot-live"></span>Live ${fmtCountdown(f.left)}</span>`;
  if (f.phase === "locking") return `<span class="pill pill--closing">Locking</span>`;
  return `<span class="pill pill--resolved">Starting</span>`;
}

function marketCard(m) {
  const f = featuredRound(m);
  const round = f.round;
  const pct = round ? impliedPct(round.up_pool, round.down_pool) : null;
  const meta = ASSET_META[m.symbol] || { name: m.symbol };

  const bar = pct === null
    ? `<div class="bar bar--empty"></div>`
    : `<div class="bar"><div class="bar__fill" style="width:${pct}%"></div></div>`;

  const probBlock = pct === null
    ? `<div class="prob">
         <span class="prob__side">${f.phase === "open" ? "First bet wins the pool" : "No bets this round"}</span>
         <span class="prob__pct" style="color:var(--text-muted)">—</span></div>${bar}`
    : `<div class="prob">
         <span class="prob__side prob__side--up">▲ UP</span>
         <span class="prob__pct" style="color:${pct >= 50 ? 'var(--up)' : 'var(--down)'}">${pct}%</span>
       </div>${bar}`;

  // A live card must not imply betting has stopped for good: the next round already
  // exists, it has simply passed its cutoff, and a fresh window opens the moment that
  // round locks. Say when that is rather than leaving the card looking inert.
  let footer;
  if (f.phase === "live" && m.next_round) {
    const reopensIn = Math.max(0, m.next_round.lock_ts - Math.floor(Date.now() / 1000));
    footer = `<div class="mcard__stats"><span>Betting reopens in ~${fmtCountdown(reopensIn)}</span></div>`;
  } else {
    footer = `<div class="mcard__stats">
         <span>Pool <b>${genFromWei(round ? round.total_pool : "0", 2)} GEN</b></span>
         <span>Bets <b>${round ? round.up_count + round.down_count : 0}</b></span>
         <span>Payout <b>${fmtMultiplier(Math.max(round?.up_multiplier_x100 || 0, round?.down_multiplier_x100 || 0))}</b></span>
       </div>`;
  }

  return `
    <a class="mcard" href="market.html?m=${encodeURIComponent(m.key)}">
      <div class="mcard__top">
        ${coinBadge(m.symbol)}
        <div>
          <div class="mcard__title">${meta.name || m.symbol} up or down?</div>
          <div class="mcard__meta">${fmtHorizon(m.horizon_seconds)} horizon · ${m.symbol}${round ? ` · round #${round.id}` : ""}</div>
        </div>
        <div class="mcard__phase">${phasePill(f)}</div>
      </div>
      ${probBlock}
      ${f.phase === "live" && round.lock_price
        ? `<div class="mcard__stats"><span>Locked at <b>${fmtUsd(round.lock_price)}</b></span>
             <span>Pool <b>${genFromWei(round.total_pool, 2)} GEN</b></span></div>`
        : ""}
      ${footer}
    </a>`;
}

function applyFilters() {
  return markets.filter((m) => {
    if (filterAsset !== "all" && m.symbol !== filterAsset) return false;
    if (filterHorizon !== "all" && String(m.horizon_seconds) !== filterHorizon) return false;
    return m.enabled === 1;
  });
}

function renderChips() {
  const horizons = [...new Set(markets.map((m) => m.horizon_seconds))].sort((a, b) => a - b);
  const hHost = $("horizon-chips");
  hHost.innerHTML = [
    `<button class="chip${filterHorizon === "all" ? " is-active" : ""}" data-h="all">All horizons <span class="chip__count">${markets.length}</span></button>`,
    ...horizons.map((h) => {
      const n = markets.filter((m) => m.horizon_seconds === h).length;
      return `<button class="chip${filterHorizon === String(h) ? " is-active" : ""}" data-h="${h}">${fmtHorizon(h)} <span class="chip__count">${n}</span></button>`;
    }),
  ].join("");
  hHost.querySelectorAll("[data-h]").forEach((b) =>
    b.addEventListener("click", () => { filterHorizon = b.dataset.h; renderChips(); renderGrid(); })
  );

  const assets = [...new Set(markets.map((m) => m.symbol))];
  const aHost = $("asset-chips");
  aHost.innerHTML = [
    `<button class="chip${filterAsset === "all" ? " is-active" : ""}" data-a="all">All coins</button>`,
    ...assets.map((s) => {
      const n = markets.filter((m) => m.symbol === s).length;
      const color = (ASSET_META[s] || {}).color || "#555";
      return `<button class="chip${filterAsset === s ? " is-active" : ""}" data-a="${s}">
        <span class="chip__dot" style="background:${color}"></span>${s} <span class="chip__count">${n}</span></button>`;
    }),
  ].join("");
  aHost.querySelectorAll("[data-a]").forEach((b) =>
    b.addEventListener("click", () => { filterAsset = b.dataset.a; renderChips(); renderGrid(); })
  );
}

function renderGrid() {
  const list = applyFilters();
  const grid = $("market-grid");
  if (list.length === 0) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">No markets match this filter.</div>`;
  } else {
    // Markets a user can still bet on come first, soonest deadline at the top —
    // sorting purely by lock time would bury them under rounds already locked.
    list.sort((a, b) => {
      const fa = featuredRound(a), fb = featuredRound(b);
      const openA = fa.phase === "open" ? 0 : 1;
      const openB = fb.phase === "open" ? 0 : 1;
      if (openA !== openB) return openA - openB;
      return fa.left - fb.left;
    });
    grid.innerHTML = list.map(marketCard).join("");
  }
  $("list-note").textContent = `${list.length} market${list.length === 1 ? "" : "s"}`;
}

// ─── Claims ─────────────────────────────────────────────────────────

function renderClaims() {
  const section = $("claims-section");
  const claimable = myBets.filter((b) => (b.state === "CLAIMABLE" || b.state === "REFUNDABLE"));
  if (!wallet.account || claimable.length === 0) {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");
  $("claims-body").innerHTML = claimable.map((b) => `
    <tr>
      <td>${b.market}</td>
      <td class="mono">#${b.round_id}</td>
      <td class="t-center" style="color:var(--${b.side === "UP" ? "up" : "down"})">${b.side === "UP" ? "▲" : "▼"} ${b.side}</td>
      <td class="t-center mono">${genFromWei(b.amount)} GEN</td>
      <td class="t-center">${b.winner === "DRAW" ? '<span class="pill pill--draw">Draw</span>' : `<span style="color:var(--${b.winner === "UP" ? "up" : "down"})">${b.winner}</span>`}</td>
      <td class="t-right mono" style="color:var(--up)">+${genFromWei(b.payout)} GEN</td>
      <td class="t-right"><button class="btn btn--primary btn--sm" data-claim="${b.market}|${b.round_id}">Collect</button></td>
    </tr>`).join("");

  $("claims-body").querySelectorAll("[data-claim]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const [market, roundId] = btn.dataset.claim.split("|");
      btn.disabled = true;
      btn.textContent = "Signing…";
      try {
        const hash = await write(CONFIG.predictAddress, "claim", [market, Number(roundId)]);
        btn.textContent = "Confirming…";
        toast(`Collecting round #${roundId} — <a href="${txLink(hash)}" target="_blank">view tx</a>`, "pending", { html: true });
        await waitAccepted(hash);
        toast(`Collected round #${roundId}`, "success");
        await refreshBets();
      } catch (e) {
        toast(e.message || "Claim failed", "error");
        btn.disabled = false;
        btn.textContent = "Collect";
      }
    });
  });
}

async function refreshBets() {
  if (!wallet.account) { myBets = []; renderClaims(); return; }
  try {
    const raw = await readPredict("get_user_portfolio", [wallet.account.toLowerCase()]);
    myBets = typeof raw === "string" ? JSON.parse(raw) : raw || [];
  } catch (e) {
    myBets = [];
  }
  renderClaims();
}

// ─── Data ───────────────────────────────────────────────────────────

async function refreshMarkets() {
  try {
    const raw = await readPredict("get_home", []);
    markets = typeof raw === "string" ? JSON.parse(raw) : raw || [];
    renderChips();
    renderGrid();
  } catch (e) {
    $("market-grid").innerHTML =
      `<div class="empty" style="grid-column:1/-1">Could not reach the backend.<br/><small>${e.message}</small></div>`;
  }
}

// ─── Init ───────────────────────────────────────────────────────────

(async function init() {
  mountHeader("home");
  await loadConfig();
  await refreshMarkets();
  await autoReconnect();
  await refreshBets();

  onWalletChange(() => refreshBets());

  // Countdowns tick locally every second; contract state is only re-fetched
  // every 12s to stay well inside the RPC budget.
  setInterval(renderGrid, 1000);
  setInterval(refreshMarkets, 12000);
  setInterval(refreshBets, 30000);
})();
