/**
 * GenPredict market detail — round cards + the betting panel.
 *
 * The whole page is served by one get_market_detail() call plus one user call,
 * because the Studio RPC only allows ~30 requests/minute across all clients.
 */
import {
  CONFIG, ASSET_META, $, loadConfig, readPredict, mountHeader, wallet, onWalletChange,
  autoReconnect, connectWallet, parseGenToWei, genFromWei, fmtCountdown, fmtHorizon,
  fmtUsd, fmtMultiplier, impliedPct, fmtClock, write, waitAccepted, toast, txLink,
  getBalance, CONSENSUS_BUFFER_SECONDS,
} from './shared.js';

const marketKey = new URLSearchParams(location.search).get("m") || "BTC-5m";

let detail = null;
let myBets = [];
let selectedSide = null;
let stake = "1";
let submitting = false;

const now = () => Math.floor(Date.now() / 1000);

/** Seconds left in which a bet can still realistically be included. GenLayer needs
 *  about a minute of consensus, so we stop accepting well before the actual lock
 *  rather than letting people pay gas for a bet that cannot land. */
function bettableSeconds(round) {
  if (!round || round.status !== "OPEN") return -1;
  return round.lock_ts - now() - CONSENSUS_BUFFER_SECONDS;
}

// ─── Header / chart ─────────────────────────────────────────────────

function renderHeader() {
  const m = detail.market;
  const meta = ASSET_META[m.symbol] || { name: m.symbol, tv: "BINANCE:BTCUSDT" };
  document.title = `${meta.name} ${fmtHorizon(m.horizon_seconds)} — GenPredict`;
  $("mkt-title").textContent = `${meta.name} up or down?`;
  $("mkt-sub").textContent =
    `Every round locks a price, then settles ${fmtHorizon(m.horizon_seconds)} later. ` +
    `Winners split the pool after a ${(m.fee_bps / 100).toFixed(1)}% fee.`;
  $("chart-symbol").textContent = `${m.symbol}/USDT`;

  const tv = $("tv");
  if (!tv.dataset.loaded) {
    tv.src = `https://www.tradingview.com/widgetembed/?symbol=${meta.tv}&interval=1&theme=dark&style=1&hidesidetoolbar=1&symboledit=0&saveimage=0&timezone=Etc/UTC&locale=en`;
    tv.dataset.loaded = "1";
  }

  $("rules").innerHTML = `
    <dt>Question</dt>
    <dd>Will ${m.symbol} be higher ${fmtHorizon(m.horizon_seconds)} after the round locks?</dd>
    <dt>Resolution</dt>
    <dd>UP wins if the close price is above the lock price, DOWN if below.</dd>
    <dt>When a round is refunded</dt>
    <dd>If the price is exactly unchanged, or if one side attracted no bets at all, the round
        is void and every stake is returned in full with no fee — a bet with no counterparty
        should not cost you anything.</dd>
    <dt>Price source</dt>
    <dd>Fetched on-chain by GenLayer validators (Binance → CoinGecko → Coinbase) and agreed
        through the Equivalence Principle. There is no oracle and no admin price input.</dd>
    <dt>Payout</dt>
    <dd>Parimutuel: the entire pool minus a ${(m.fee_bps / 100).toFixed(1)}% fee is split across
        the winning side in proportion to stake. The multiplier keeps moving until betting closes.</dd>
    <dt>Minimum bet</dt>
    <dd>${genFromWei(m.min_bet)} GEN — one bet per round, per wallet.</dd>`;
}

async function refreshSpot() {
  const meta = ASSET_META[detail?.market?.symbol];
  if (!meta) return;
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${detail.market.symbol}USDT`);
    const d = await r.json();
    if (d.price) $("chart-price").textContent = fmtUsd(d.price);
  } catch (e) { /* indicative only */ }
}

// ─── Round cards ────────────────────────────────────────────────────

function priceDelta(lock, close) {
  const l = parseFloat(lock), c = parseFloat(close);
  if (!isFinite(l) || !isFinite(c) || l === 0) return { pct: 0, cls: "flat", text: "—" };
  const pct = ((c - l) / l) * 100;
  const cls = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const sign = pct > 0 ? "+" : "";
  return { pct, cls, text: `${sign}${pct.toFixed(3)}%` };
}

function poolRows(r) {
  const pct = impliedPct(r.up_pool, r.down_pool);
  const bar = pct === null
    ? `<div class="bar bar--empty"></div>`
    : `<div class="bar"><div class="bar__fill" style="width:${pct}%"></div></div>`;
  return `
    <div>
      <div class="pool-row" style="margin-bottom:5px">
        <span style="color:var(--up)">▲ ${fmtMultiplier(r.up_multiplier_x100)} · ${genFromWei(r.up_pool, 2)}</span>
        <span style="color:var(--down)">${genFromWei(r.down_pool, 2)} · ${fmtMultiplier(r.down_multiplier_x100)} ▼</span>
      </div>
      ${bar}
    </div>
    <div class="pool-row">
      <span>Prize pool</span><b>${genFromWei(r.total_pool, 3)} GEN</b>
    </div>`;
}

function nextCard(r) {
  const left = bettableSeconds(r);
  const untilLock = r.lock_ts - now();
  let cd, note = "";
  if (left > 0) {
    cd = `<div class="countdown${left < 60 ? " countdown--urgent" : ""}">
            <div class="countdown__value">${fmtCountdown(left)}</div>
            <div class="countdown__label">left to bet</div></div>`;
  } else if (untilLock > 0) {
    cd = `<div class="countdown countdown--locked">
            <div class="countdown__value">${fmtCountdown(Math.max(0, untilLock))}</div>
            <div class="countdown__label">betting closed</div></div>`;
    note = `<div class="notice notice--warn"><span>⏳</span><span>Betting is closed for this round — a
            transaction sent now would not reach consensus before the lock.</span></div>`;
  } else {
    cd = `<div class="countdown"><div class="countdown__value">—</div>
            <div class="countdown__label">locking now</div></div>`;
  }
  return `
    <div class="round round--next">
      <div class="round__head">
        <span class="pill pill--open">Next</span>
        <span class="round__id">#${r.id}</span>
      </div>
      <div class="round__body">
        ${cd}
        ${note}
        ${poolRows(r)}
        <div class="pool-row"><span>Locks at</span><b>${fmtClock(r.lock_ts)}</b></div>
      </div>
    </div>`;
}

function liveCard(r) {
  const toClose = r.close_ts - now();
  const spot = $("chart-price")?.textContent || "—";
  const d = priceDelta(r.lock_price, (spot || "").replace(/[$,]/g, ""));
  return `
    <div class="round round--live">
      <div class="round__head">
        <span class="pill pill--live"><span class="dot-live"></span>Live</span>
        <span class="round__id">#${r.id}</span>
      </div>
      <div class="round__body">
        <div class="countdown${toClose < 30 ? " countdown--urgent" : ""}">
          <div class="countdown__value">${fmtCountdown(Math.max(0, toClose))}</div>
          <div class="countdown__label">${toClose > 0 ? "until settlement" : "settling…"}</div>
        </div>
        <div class="pricebox">
          <div class="priceline"><span>Locked price</span><b>${fmtUsd(r.lock_price)}</b></div>
          <div class="priceline"><span>Now</span><b>${spot}</b></div>
          <div class="priceline"><span>Change</span><b class="delta delta--${d.cls}">${d.text}</b></div>
        </div>
        ${poolRows(r)}
      </div>
    </div>`;
}

function renderRounds() {
  const host = $("rounds");
  const parts = [];
  // Several rounds are usually mid-flight at once, because a new one opens the
  // moment the previous locks while the horizon is still running. Show them all —
  // the user may have a stake in each.
  const live = detail.live_rounds || (detail.live_round ? [detail.live_round] : []);
  live.filter((r) => r.status === "LOCKED").forEach((r) => parts.push(liveCard(r)));
  if (detail.next_round) parts.push(nextCard(detail.next_round));
  host.innerHTML = parts.length
    ? parts.join("")
    : `<div class="empty" style="grid-column:1/-1">Waiting for the keeper to open a round…</div>`;
  $("rounds-note").textContent = detail.next_round
    ? `Betting on #${detail.next_round.id}` : "";
}

// ─── History ────────────────────────────────────────────────────────

function renderHistory() {
  const rows = (detail.history || []).map((r) => {
    const d = priceDelta(r.lock_price, r.close_price);
    // A void round still has a price direction, but nobody was paid from it —
    // labelling it by its winner alone would misrepresent what happened.
    const winner = r.settlement === "VOID"
      ? `<span class="pill pill--draw" title="One side had no bets, or the price was unchanged — all stakes refunded">Refunded</span>`
      : `<span style="color:var(--${r.winner === "UP" ? "up" : "down"});font-weight:600">${r.winner === "UP" ? "▲" : "▼"} ${r.winner}</span>`;
    return `<tr>
      <td class="mono">#${r.id}</td>
      <td class="t-center mono">${fmtUsd(r.lock_price)}</td>
      <td class="t-center mono">${fmtUsd(r.close_price)}</td>
      <td class="t-center mono delta--${d.cls}">${d.text}</td>
      <td class="t-center">${winner}</td>
      <td class="t-right mono">${genFromWei(r.total_pool, 2)}</td>
      <td class="t-right mono" style="color:var(--text-dim)">${fmtMultiplier(r.up_multiplier_x100)} / ${fmtMultiplier(r.down_multiplier_x100)}</td>
    </tr>`;
  });
  $("history-body").innerHTML = rows.length
    ? rows.join("")
    : `<tr><td colspan="7" class="empty">No completed rounds yet</td></tr>`;
}

// ─── Bet panel ──────────────────────────────────────────────────────

/**
 * What this stake would return if the chosen side wins, given the pools as they
 * stand. Mirrors the contract, including the void rule: with the other side empty
 * the round refunds instead of paying out, so the honest projection is 1.00x rather
 * than the sub-1x number the raw parimutuel formula would produce.
 */
function estimatePayout(round, side, stakeGen) {
  const amount = Number(stakeGen);
  if (!round || !isFinite(amount) || amount <= 0) return null;
  const up = Number(BigInt(round.up_pool)) / 1e18;
  const down = Number(BigInt(round.down_pool)) / 1e18;
  const myUp = side === "UP" ? up + amount : up;
  const myDown = side === "DOWN" ? down + amount : down;
  const opposing = side === "UP" ? myDown : myUp;
  if (opposing <= 0) {
    return { payout: amount, multiplier: 1, wouldVoid: true };
  }
  const feeRate = detail.market.fee_bps / 10000;
  const total = myUp + myDown;
  const winnerPool = side === "UP" ? myUp : myDown;
  const distributable = total * (1 - feeRate);
  const payout = (amount / winnerPool) * distributable;
  return { payout, multiplier: payout / amount, wouldVoid: false };
}

/** Identifies the *structure* of the panel. The countdown ticks every second, but
 *  rebuilding the DOM that often would steal focus and reset the caret while someone
 *  is typing a stake — so a full rebuild only happens when this signature changes. */
function panelSignature() {
  const round = detail?.next_round;
  const mine = round ? myBets.find((b) => b.round_id === round.id) : null;
  return [
    round?.id ?? "none",
    bettableSeconds(round) > 0 ? "open" : "closed",
    mine ? `mine:${mine.side}` : "nobet",
    selectedSide ?? "noside",
    submitting ? "busy" : "idle",
  ].join("|");
}

let lastSignature = null;

/** Called every second: refresh only the volatile numbers, in place. */
function tickBetPanel() {
  if (!detail) return;
  if (panelSignature() !== lastSignature) return renderBetPanel();

  const round = detail.next_round;
  const left = bettableSeconds(round);
  document.querySelectorAll("[data-tick-countdown]").forEach((n) => {
    n.textContent = fmtCountdown(Math.max(0, left));
  });
  document.querySelectorAll("[data-tick-countdown-reopen]").forEach((n) => {
    n.textContent = fmtCountdown(Math.max(0, (round?.lock_ts ?? 0) - now()));
  });
  if (!round) return;
  for (const [id, x100] of [["pick-up", round.up_multiplier_x100], ["pick-down", round.down_multiplier_x100]]) {
    const btn = $(id);
    if (!btn) continue;
    const m = fmtMultiplier(x100);
    btn.querySelector(".btn__multiplier").textContent = m;
    // Keep the accessible name in step with the visible number, not just the label.
    btn.setAttribute("aria-label", `Bet ${id === "pick-up" ? "UP" : "DOWN"}, paying ${m}`);
  }
}

function renderBetPanel() {
  lastSignature = panelSignature();
  const host = $("bet-body");
  const round = detail.next_round;
  const left = bettableSeconds(round);

  if (!round) {
    host.innerHTML = `<div class="empty" style="padding:22px">No round is open yet.</div>`;
    return;
  }
  if (left <= 0) {
    const untilNext = Math.max(0, round.lock_ts - now());
    host.innerHTML = `
      <div class="notice notice--warn" style="margin-bottom:12px">
        <span>⏳</span>
        <span>Betting for round #${round.id} has closed — too little time left for a
        transaction to reach consensus before it locks.</span>
      </div>
      <div class="countdown">
        <div class="countdown__value" data-tick-countdown-reopen>${fmtCountdown(untilNext)}</div>
        <div class="countdown__label">until betting reopens</div>
      </div>
      <div class="notice notice--info" style="margin-top:12px">
        <span>↻</span><span>A fresh round opens the instant this one locks, so you will not
        have to wait for the ${fmtHorizon(detail.market.horizon_seconds)} horizon to play out.</span>
      </div>`;
    return;
  }

  const mine = myBets.find((b) => b.round_id === round.id);
  if (mine) {
    host.innerHTML = `
      <div class="notice notice--info" style="margin-bottom:12px">
        <span>${mine.side === "UP" ? "▲" : "▼"}</span>
        <span>You backed <b style="color:var(--${mine.side === "UP" ? "up" : "down"})">${mine.side}</b>
        with ${genFromWei(mine.amount)} GEN on round #${round.id}.
        One bet per round, so you're locked in — settlement happens automatically.</span>
      </div>
      <div class="pool-row"><span>Betting closes in</span><b data-tick-countdown>${fmtCountdown(left)}</b></div>`;
    return;
  }

  const est = selectedSide ? estimatePayout(round, selectedSide, stake) : null;

  host.innerHTML = `
    <div class="field" style="margin-bottom:12px">
      <label class="field__label" for="stake">Your stake</label>
      <div class="input-wrap">
        <input id="stake" type="number" min="0" step="0.1" value="${stake}" inputmode="decimal"/>
        <span class="input-wrap__suffix">GEN</span>
      </div>
      <div class="quick">
        <button data-stake="1">1</button>
        <button data-stake="5">5</button>
        <button data-stake="10">10</button>
        <button data-stake="max">Max</button>
      </div>
    </div>

    <div class="actions" style="margin-bottom:12px" role="group" aria-label="Choose a side">
      <button class="btn btn--up" id="pick-up" aria-pressed="${selectedSide === "UP"}"
              aria-label="Bet UP, paying ${fmtMultiplier(round.up_multiplier_x100)}"
              style="${selectedSide === "UP" ? "outline:2px solid var(--up);outline-offset:1px" : ""}">
        <span class="btn__label" aria-hidden="true">▲ UP</span>
        <span class="btn__multiplier" aria-hidden="true">${fmtMultiplier(round.up_multiplier_x100)}</span>
      </button>
      <button class="btn btn--down" id="pick-down" aria-pressed="${selectedSide === "DOWN"}"
              aria-label="Bet DOWN, paying ${fmtMultiplier(round.down_multiplier_x100)}"
              style="${selectedSide === "DOWN" ? "outline:2px solid var(--down);outline-offset:1px" : ""}">
        <span class="btn__label" aria-hidden="true">▼ DOWN</span>
        <span class="btn__multiplier" aria-hidden="true">${fmtMultiplier(round.down_multiplier_x100)}</span>
      </button>
    </div>

    ${est ? `
      <div class="payout-preview" style="margin-bottom:12px">
        ${est.wouldVoid ? `
          <div class="row"><span>Nobody is on the other side yet</span></div>
          <div class="row"><span>If it stays that way</span><b>Refunded in full</b></div>
          <div class="row" style="color:var(--text-muted);font-size:11.5px;border-top:1px solid rgba(255,255,255,0.08);padding-top:5px;margin-top:2px">
            <span>A round with one empty side is void — you get your ${Number(stake)} GEN back, win or lose.
            Real odds appear once someone takes the other side.</span>
          </div>` : `
          <div class="row"><span>If ${selectedSide} wins</span><b style="color:var(--up)">+${(est.payout - Number(stake)).toFixed(3)} GEN</b></div>
          <div class="row"><span>You'd receive</span><b>${est.payout.toFixed(3)} GEN</b></div>
          <div class="row"><span>Effective multiplier</span><b>${est.multiplier.toFixed(2)}x</b></div>
          <div class="row" style="color:var(--text-muted);font-size:11.5px;border-top:1px solid rgba(255,255,255,0.08);padding-top:5px;margin-top:2px">
            <span>Estimate only — the multiplier moves as others bet</span>
          </div>`}
      </div>` : `
      <div class="notice notice--info" style="margin-bottom:12px">
        <span>①</span><span>Pick a side to see your projected payout.</span>
      </div>`}

    <button class="btn btn--primary btn--block" id="submit-bet" ${!selectedSide || submitting ? "disabled" : ""}>
      ${submitting ? "Confirming…" : selectedSide ? `Bet ${stake} GEN on ${selectedSide}` : "Pick UP or DOWN"}
    </button>

    <div class="notice notice--warn" style="margin-top:10px">
      <span>⏱</span>
      <span>Closes in <b data-tick-countdown>${fmtCountdown(left)}</b>. GenLayer needs about a minute to reach
      consensus, so bet early — we stop accepting ${CONSENSUS_BUFFER_SECONDS}s before the lock.</span>
    </div>`;

  // Wire up
  const stakeInput = $("stake");
  stakeInput.addEventListener("input", () => {
    stake = stakeInput.value || "0";
    renderBetPanelSoft();
  });
  host.querySelectorAll("[data-stake]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (b.dataset.stake === "max") {
        const bal = await getBalance();
        // Leave a little behind for gas rather than handing back a bet that cannot be sent.
        const usable = bal ? Math.max(0, Number(bal) / 1e18 - 0.05) : 0;
        stake = usable.toFixed(3);
      } else {
        stake = b.dataset.stake;
      }
      renderBetPanel();
    })
  );
  $("pick-up").addEventListener("click", () => { selectedSide = "UP"; renderBetPanel(); });
  $("pick-down").addEventListener("click", () => { selectedSide = "DOWN"; renderBetPanel(); });
  $("submit-bet").addEventListener("click", submitBet);
}

/** Re-render the payout box without stealing focus from the stake input. */
function renderBetPanelSoft() {
  const round = detail.next_round;
  const est = selectedSide ? estimatePayout(round, selectedSide, stake) : null;
  const btn = $("submit-bet");
  if (btn && selectedSide) btn.textContent = `Bet ${stake} GEN on ${selectedSide}`;
  const box = document.querySelector(".payout-preview");
  if (box && est) {
    box.querySelectorAll(".row b")[0].textContent = `+${(est.payout - Number(stake)).toFixed(3)} GEN`;
    box.querySelectorAll(".row b")[1].textContent = `${est.payout.toFixed(3)} GEN`;
    box.querySelectorAll(".row b")[2].textContent = `${est.multiplier.toFixed(2)}x`;
  }
}

async function submitBet() {
  if (!wallet.account) {
    const acct = await connectWallet();
    if (!acct) return;
  }
  const round = detail.next_round;
  const left = bettableSeconds(round);
  if (left <= 0) {
    toast("Betting just closed for this round", "error");
    return renderBetPanel();
  }
  const amount = Number(stake);
  const minGen = Number(BigInt(detail.market.min_bet)) / 1e18;
  if (!isFinite(amount) || amount < minGen) {
    toast(`Minimum bet is ${minGen} GEN`, "error");
    return;
  }

  submitting = true;
  renderBetPanel();
  try {
    const hash = await write(CONFIG.predictAddress, "bet", [marketKey, selectedSide], parseGenToWei(stake));
    toast(`Bet sent — <a href="${txLink(hash)}" target="_blank">view tx</a>. Waiting for consensus…`,
          "pending", { html: true, timeout: 12000 });
    await waitAccepted(hash);
    toast(`${stake} GEN on ${selectedSide} confirmed for round #${round.id}`, "success");
    selectedSide = null;
    await Promise.all([refresh(), refreshBets()]);
  } catch (e) {
    toast(e.message || "Bet failed", "error");
  } finally {
    submitting = false;
    renderBetPanel();
  }
}

// ─── My bets ────────────────────────────────────────────────────────

function renderMyBets() {
  const host = $("my-bets");
  if (!wallet.account) {
    host.innerHTML = `<div class="empty" style="padding:20px">Connect your wallet to see your bets</div>`;
    return;
  }
  if (myBets.length === 0) {
    host.innerHTML = `<div class="empty" style="padding:20px">No bets on this market yet</div>`;
    return;
  }
  const statePill = {
    PENDING: `<span class="pill pill--open">Open</span>`,
    LIVE: `<span class="pill pill--live">Live</span>`,
    CLAIMABLE: `<span class="pill pill--open">Won</span>`,
    REFUNDABLE: `<span class="pill pill--draw">Refund</span>`,
    CLAIMED: `<span class="pill pill--resolved">Collected</span>`,
    LOST: `<span class="pill pill--resolved">Lost</span>`,
  };
  host.innerHTML = `<div class="table-scroll"><table>
    <thead><tr><th>Round</th><th class="t-center">Pick</th><th class="t-center">Stake</th>
    <th class="t-center">Status</th><th class="t-right">Payout</th></tr></thead>
    <tbody>${myBets.slice(0, 12).map((b) => `
      <tr>
        <td class="mono">#${b.round_id}</td>
        <td class="t-center" style="color:var(--${b.side === "UP" ? "up" : "down"})">${b.side === "UP" ? "▲" : "▼"}</td>
        <td class="t-center mono">${genFromWei(b.amount, 2)}</td>
        <td class="t-center">${statePill[b.state] || b.state}</td>
        <td class="t-right">${
          (b.state === "CLAIMABLE" || b.state === "REFUNDABLE")
            ? `<button class="btn btn--primary btn--sm" data-claim="${b.round_id}">Collect ${genFromWei(b.payout, 2)}</button>`
            : b.state === "CLAIMED"
            ? `<span class="mono" style="color:var(--text-muted)">${genFromWei(b.payout, 2)}</span>`
            : b.state === "LOST"
            ? `<span style="color:var(--text-muted)">—</span>`
            : `<span style="color:var(--text-muted)">pending</span>`
        }</td>
      </tr>`).join("")}</tbody></table></div>`;

  host.querySelectorAll("[data-claim]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      btn.disabled = true; btn.textContent = "Signing…";
      try {
        const hash = await write(CONFIG.predictAddress, "claim", [marketKey, Number(btn.dataset.claim)]);
        toast(`Collecting — <a href="${txLink(hash)}" target="_blank">view tx</a>`, "pending", { html: true });
        await waitAccepted(hash);
        toast("Winnings collected", "success");
        await refreshBets();
      } catch (e) {
        toast(e.message || "Claim failed", "error");
        btn.disabled = false; btn.textContent = "Collect";
      }
    })
  );
}

// ─── Data ───────────────────────────────────────────────────────────

async function refresh() {
  try {
    const raw = await readPredict("get_market_detail", [marketKey, 15]);
    const d = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (d.error) {
      $("mkt-title").textContent = "Market not found";
      return;
    }
    detail = d;
    renderHeader();
    renderRounds();
    renderHistory();
    renderBetPanel();
  } catch (e) {
    console.warn("refresh failed", e.message);
  }
}

async function refreshBets() {
  if (!wallet.account) { myBets = []; renderMyBets(); return; }
  try {
    const raw = await readPredict("get_user_bets", [wallet.account.toLowerCase(), marketKey]);
    myBets = typeof raw === "string" ? JSON.parse(raw) : raw || [];
  } catch (e) { myBets = []; }
  renderMyBets();
  if (detail) renderBetPanel();
}

// ─── Init ───────────────────────────────────────────────────────────

(async function init() {
  mountHeader("home");
  await loadConfig();
  await refresh();
  await refreshSpot();
  await autoReconnect();
  await refreshBets();

  onWalletChange(() => refreshBets());

  // Local ticks keep countdowns smooth; contract reads stay inside the RPC budget.
  setInterval(() => { if (detail) { renderRounds(); tickBetPanel(); } }, 1000);
  setInterval(refresh, 10000);
  setInterval(refreshSpot, 10000);
  setInterval(refreshBets, 30000);
})();
