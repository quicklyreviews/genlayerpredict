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
  toast, CONSENSUS_BUFFER_SECONDS, coinLogo, pollWhileVisible, refreshVaultChip,
  vaultState, openVaultModal, write, waitAccepted, txLink,
} from './shared.js';
import { loadSession, refreshSessionGas } from './session.js';
import * as results from './results.js';

let markets = [];
let filterHorizon = "all";
let filterAsset = "all";
let myBets = [];

// ─── Rendering ──────────────────────────────────────────────────────

/** A round with no stake on it never locks — the keeper leaves it alone so idle
 *  markets cost nothing — so it stays bettable indefinitely, and the first bet
 *  restarts the window. Returns Infinity for that case. */
function isDormant(round) {
  return round && round.status === "OPEN"
    && BigInt(round.up_pool || "0") + BigInt(round.down_pool || "0") === 0n;
}

/** Seconds left in which a bet can still realistically be included. GenLayer needs
 *  about a minute of consensus, so we stop accepting well before the lock rather
 *  than letting someone pay gas for a bet that cannot land. */
function bettableSeconds(round) {
  if (!round || round.status !== "OPEN") return -1;
  if (isDormant(round)) return Infinity;
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
  if (next && isDormant(next) && !(live && live.status === "LOCKED")) {
    return { round: next, phase: "waiting", left: 0 };
  }
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
  if (f.phase === "waiting") return `<span class="pill pill--open">Open</span>`;
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
         <span class="prob__side">${f.phase === "waiting" ? "Your bet starts the clock" : f.phase === "open" ? "First bet wins the pool" : "No bets this round"}</span>
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
        ${coinLogo(m.symbol)}
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
      const rank = (p) => (p === "open" ? 0 : p === "waiting" ? 1 : 2);
      const openA = rank(fa.phase);
      const openB = rank(fb.phase);
      if (openA !== openB) return openA - openB;
      return fa.left - fb.left;
    });
    grid.innerHTML = list.map(marketCard).join("");
  }
  $("list-note").textContent = `${list.length} market${list.length === 1 ? "" : "s"}`;
}


// ─── Coin search ────────────────────────────────────────────────────

/**
 * Searches the full CoinGecko top-1000 snapshot, not just the markets that exist.
 *
 * The list is a static file loaded on first focus rather than on page load: it is
 * ~175KB and most visits never search, so paying for it up front would slow every
 * load for a feature few use. Fetching it live from CoinGecko instead was not an
 * option — their free endpoint drops CORS headers when it rate-limits, so the
 * search box would break exactly when the site is busy.
 */
let coinList = null;
let coinListState = "idle";

async function loadCoinList() {
  if (coinList || coinListState === "loading") return coinList;
  coinListState = "loading";
  try {
    const res = await fetch("coins.json");
    const data = await res.json();
    coinList = data.coins || [];
    coinListState = "ready";
  } catch (e) {
    coinListState = "error";
  }
  return coinList;
}

/** Ranked so an exact ticker beats a substring — typing "SOL" should not bury
 *  Solana under every coin with "sol" somewhere in its name. */
function searchCoins(query, limit = 12) {
  if (!coinList) return [];
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored = [];
  for (const c of coinList) {
    const sym = c.symbol.toLowerCase();
    const name = (c.name || "").toLowerCase();
    let score = -1;
    if (sym === q) score = 0;
    else if (name === q) score = 1;
    else if (sym.startsWith(q)) score = 2;
    else if (name.startsWith(q)) score = 3;
    else if (sym.includes(q)) score = 4;
    else if (name.includes(q)) score = 5;
    if (score >= 0) scored.push({ c, score });
  }
  scored.sort((a, b) => a.score - b.score || (a.c.rank ?? 9e9) - (b.c.rank ?? 9e9));
  return scored.slice(0, limit).map((x) => x.c);
}

function marketsFor(symbol) {
  return markets.filter((m) => m.symbol === symbol && m.enabled === 1);
}

function renderSearch(query) {
  const host = $("search-results");
  const clear = $("search-clear");
  if (!query.trim()) {
    host.classList.add("hidden");
    clear.classList.add("hidden");
    $("market-grid").classList.remove("hidden");
    document.querySelector(".filters").classList.remove("hidden");
    return;
  }
  clear.classList.remove("hidden");
  host.classList.remove("hidden");
  // Hide the browse view while searching so there is one answer on screen, not two.
  $("market-grid").classList.add("hidden");
  document.querySelector(".filters").classList.add("hidden");

  if (coinListState === "loading") {
    host.innerHTML = `<div class="sresults"><div class="search-note">Loading coin list…</div></div>`;
    return;
  }
  if (coinListState === "error") {
    host.innerHTML = `<div class="sresults"><div class="search-note">
      Could not load the coin list. Run <code>npm run coins</code> to regenerate
      <code>frontend/coins.json</code>.</div></div>`;
    return;
  }

  const hits = searchCoins(query);
  if (hits.length === 0) {
    host.innerHTML = `<div class="sresults"><div class="search-note">
      Nothing matching “${query}” in the top 1,000 by market cap.</div></div>`;
    return;
  }

  host.innerHTML = `<div class="sresults">${hits.map((c) => {
    const mine = marketsFor(c.symbol);
    const right = mine.length
      ? mine.map((m) => `<span class="sresult__tag sresult__tag--live">${fmtHorizon(m.horizon_seconds)}</span>`).join("")
      : c.tradeable === false
      ? `<span class="sresult__tag">Not on Binance</span>`
      : `<span class="sresult__tag">No market yet</span>`;
    const href = mine.length ? `market.html?m=${encodeURIComponent(mine[0].key)}` : null;
    const inner = `
      ${coinLogo(c.symbol, 30)}
      <div>
        <div class="sresult__name">${c.name}</div>
        <div class="sresult__meta">${c.symbol}${c.rank ? ` · rank #${c.rank}` : ""}</div>
      </div>
      <div class="sresult__right">${right}</div>`;
    return href
      ? `<a class="sresult" href="${href}">${inner}</a>`
      : `<div class="sresult" style="cursor:default">${inner}</div>`;
  }).join("")}
  ${hits.some((c) => marketsFor(c.symbol).length === 0)
    ? `<div class="search-note">Coins without a market are not being run yet — the owner
       lists one with <code>add_market</code>. Only assets quoted on Binance can be
       settled, since that is the contract's primary price source.</div>` : ""}
  </div>`;
}

function initSearch() {
  const input = $("coin-search");
  if (!input) return;
  const run = () => renderSearch(input.value);
  input.addEventListener("focus", async () => { await loadCoinList(); run(); }, { once: false });
  input.addEventListener("input", async () => {
    if (!coinList) { renderSearch(input.value); await loadCoinList(); }
    run();
  });
  $("search-clear").addEventListener("click", () => { input.value = ""; run(); input.focus(); });
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") { input.value = ""; run(); } });
}

// ─── Recent settlements ─────────────────────────────────────────────

/**
 * Your recent results — wins, losses and refunds alike.
 *
 * This used to list only the rounds that paid, on the reasoning that a loss has
 * nothing to show. But a results table that silently omits losses is not a record
 * of what happened, it is a highlight reel: a player who lost three rounds saw an
 * empty table and no explanation. Every settled round appears, and the ones still
 * owing money carry the button to collect it.
 */
function renderSettled() {
  const section = $("claims-section");
  const settled = myBets
    .filter((b) => ["CLAIMABLE", "REFUNDABLE", "COLLECTED", "LOST"].includes(b.state))
    .slice(0, 8);
  if (!wallet.account || settled.length === 0) {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");
  const waiting = settled.filter((b) => b.state === "CLAIMABLE" || b.state === "REFUNDABLE").length;
  $("claims-note").textContent = waiting
    ? `${waiting} waiting to be collected`
    : "Everything settled has been collected";

  $("claims-body").innerHTML = settled.map((b) => {
    const lost = b.state === "LOST";
    const outcome = b.settlement === "VOID"
      ? '<span class="pill pill--draw">Refunded</span>'
      : lost
      ? `<span class="pill pill--resolved">Lost</span>`
      : `<span class="pill pill--open">Won</span>`;
    const amount = lost
      ? `<span class="mono" style="color:var(--down)">−${genFromWei(b.amount)} GEN</span>`
      : `<span class="mono" style="color:var(--up)">+${genFromWei(b.payout)} GEN</span>`;
    const action = lost
      ? `<span style="color:var(--text-muted)">${b.winner} took it</span>`
      : b.state === "COLLECTED"
      ? '<span class="pill pill--resolved">Collected</span>'
      : `<button class="btn btn--primary btn--sm" data-collect="${b.market}|${b.round_id}">Collect</button>`;
    return `
    <tr>
      <td><a href="market.html?m=${encodeURIComponent(b.market)}" style="color:var(--text)">${b.market}</a></td>
      <td class="mono">#${b.round_id}</td>
      <td class="t-center" style="color:var(--${b.side === "UP" ? "up" : "down"})">${b.side === "UP" ? "▲" : "▼"} ${b.side}</td>
      <td class="t-center mono">${genFromWei(b.amount)} GEN</td>
      <td class="t-center">${outcome}</td>
      <td class="t-right">${amount}</td>
      <td class="t-right">${action}</td>
    </tr>`;
  }).join("");

  $("claims-body").querySelectorAll("[data-collect]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const [market, rid] = btn.dataset.collect.split("|");
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Confirm…";
      try {
        const hash = await write(CONFIG.predictAddress, "claim", [market, Number(rid)]);
        toast(`Collecting — <a href="${txLink(hash)}" target="_blank">view tx</a>`, "pending", { html: true });
        await waitAccepted(hash);
        toast("Collected into your play balance", "success");
        await Promise.all([refreshBets(), refreshVaultChip({ fresh: true }), results.refresh({ fresh: true })]);
      } catch (e) {
        toast(e.message || "Could not collect", "error");
        btn.disabled = false;
        btn.textContent = label;
      }
    })
  );
}

/** Funding is a prerequisite for playing, so say so before the user picks a market
 *  rather than letting them discover it at the moment they try to bet. */
function renderFundPrompt() {
  const host = $("fund-prompt");
  if (!host) return;
  if (!wallet.account || vaultState.balance > 0n) {
    host.classList.add("hidden");
    return;
  }
  host.classList.remove("hidden");
  host.innerHTML = `
    <p><b>Add funds to start playing.</b> Bets are staked from your play balance,
    and winnings go back into it as soon as you collect them.</p>
    <button class="btn btn--primary btn--sm" id="fund-now">Deposit GEN</button>`;
  $("fund-now").addEventListener("click", () => openVaultModal("deposit"));
}

async function refreshBets() {
  if (!wallet.account) { myBets = []; renderSettled(); renderFundPrompt(); return; }
  try {
    const raw = await readPredict("get_user_portfolio", [wallet.account.toLowerCase()]);
    myBets = typeof raw === "string" ? JSON.parse(raw) : raw || [];
  } catch (e) {
    myBets = [];
  }
  renderSettled();
  renderFundPrompt();
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
  initSearch();
  await autoReconnect();
  if (loadSession()) refreshSessionGas();
  await results.primeSeen();
  await results.refresh();
  await refreshBets();

  onWalletChange(async () => {
    await refreshVaultChip();
    await results.primeSeen();
    await results.refresh();
    await refreshBets();
  });

  // Countdowns are pure arithmetic on timestamps we already hold, so they tick
  // locally every second at no network cost. Anything that needs the chain is
  // polled far more slowly and pauses entirely while the tab is hidden — the node
  // allows 5000 requests a day in total and the round keeper needs most of them.
  setInterval(renderGrid, 1000);
  pollWhileVisible(refreshMarkets, 30000);
  pollWhileVisible(refreshBets, 60000);
  // Results are the thing a player is waiting for, so check a little more often.
  pollWhileVisible(() => results.refresh(), 30000);
})();
