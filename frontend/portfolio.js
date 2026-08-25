/**
 * Your history: every round you joined, how it ended, and whether you took the money.
 *
 * The page this replaces listed bets but could not answer the two questions a player
 * actually opens a history for — "did I win that one?" and "have I collected it?"
 * It still used the state names from before winnings needed collecting, so a round
 * sitting there unclaimed rendered as a blank cell.
 *
 * Results and collection are the spine of the page now. Every settled round says
 * plainly whether it was won, lost or refunded; every uncollected win says so and
 * offers the button; and the filters exist because "what have I not collected yet?"
 * deserves one click rather than a scroll through months of rounds.
 */
import {
  CONFIG, $, loadConfig, readPredict, mountHeader, wallet, onWalletChange, autoReconnect,
  genFromWei, fmtUsd, toast, pollWhileVisible, refreshVaultChip, vaultState,
  write, waitAccepted, txLink, coinLogo,
} from './shared.js';
import * as results from './results.js';

let bets = [];
let filter = "all";

/* ── helpers ─────────────────────────────────────────────────────────────── */

const gen = (wei) => Number(BigInt(wei || 0)) / 1e18;

const SETTLED = ["CLAIMABLE", "REFUNDABLE", "COLLECTED", "LOST"];
const isSettled = (b) => SETTLED.includes(b.state);
const isOpen = (b) => b.state === "PENDING" || b.state === "LIVE";

// Whether a round was won or refunded is decided by how it settled, never by
// whether the money has been picked up. The state collapses to COLLECTED once
// claimed, so reading win/refund off the state told a player who was handed their
// own stake back that they had predicted correctly — and counted it in the win rate.
const isRefund = (b) => isSettled(b) && b.settlement === "VOID";
const isWin = (b) => isSettled(b) && !isRefund(b) && BigInt(b.payout || 0) > 0n;
const isUncollected = (b) => b.state === "CLAIMABLE" || b.state === "REFUNDABLE";

/** Relative while it is fresh, absolute once it is old enough for that to be vague. */
function whenText(ts) {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ` +
         `${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

const fullWhen = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : "");

function moveText(b) {
  const l = parseFloat(b.lock_price), c = parseFloat(b.close_price);
  if (!isFinite(l) || !isFinite(c) || !l) return "";
  const pct = ((c - l) / l) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(3)}%`;
}

/* ── summary ─────────────────────────────────────────────────────────────── */

function stat(label, value, color, sub) {
  return `<div class="panel" style="text-align:center;padding:14px">
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted)">${label}</div>
    <div class="mono" style="font-size:20px;font-weight:700;margin-top:5px;${color ? `color:${color}` : ""}">${value}</div>
    ${sub ? `<div style="font-size:11px;color:var(--text-muted);margin-top:3px">${sub}</div>` : ""}
  </div>`;
}

function renderSummary() {
  const settled = bets.filter(isSettled);
  const wins = settled.filter(isWin).length;
  const losses = settled.filter((b) => b.state === "LOST").length;
  const refunds = settled.filter(isRefund).length;

  // Refunds are left out of the win rate deliberately: getting your own stake back
  // because nobody took the other side is not a prediction you got right, and
  // counting it as one would flatter the number.
  const decided = wins + losses;

  // P&L books settled rounds only — an open bet has no result yet — and counts a win
  // whether or not it has been collected, because it is owed to you either way.
  const staked = settled.reduce((s, b) => s + gen(b.amount), 0);
  const returned = settled.reduce((s, b) => s + gen(b.payout), 0);
  const net = returned - staked;

  const open = bets.filter(isOpen);
  const atRisk = open.reduce((s, b) => s + gen(b.amount), 0);
  const uncollected = bets.filter(isUncollected);
  const owed = uncollected.reduce((s, b) => s + gen(b.payout), 0);

  $("summary").innerHTML = [
    stat("Rounds joined", bets.length, undefined, `${settled.length} settled`),
    stat("Win rate", decided ? `${Math.round((wins / decided) * 100)}%` : "—", undefined,
         decided ? `${wins}W · ${losses}L${refunds ? ` · ${refunds}R` : ""}` : "nothing decided yet"),
    stat("Net P&L", `${net >= 0 ? "+" : ""}${net.toFixed(3)}`,
         net > 0 ? "var(--up)" : net < 0 ? "var(--down)" : undefined, "GEN · settled rounds"),
    stat("To collect", owed.toFixed(3), owed > 0 ? "var(--up)" : undefined,
         uncollected.length ? `${uncollected.length} round${uncollected.length > 1 ? "s" : ""} waiting` : "nothing waiting"),
    stat("On open rounds", atRisk.toFixed(3), atRisk > 0 ? "var(--warn)" : undefined,
         open.length ? `${open.length} still running` : "none running"),
    stat("Play balance", (Number(vaultState.balance) / 1e18).toFixed(3), undefined, "GEN ready to bet"),
  ].join("");
}

/* ── filters ─────────────────────────────────────────────────────────────── */

const TABS = [
  ["all", "All"],
  ["uncollected", "To collect"],
  ["open", "Running"],
  ["won", "Won"],
  ["lost", "Lost"],
  // Refunds are neither, and this design produces plenty of them — without a tab
  // of their own they would be reachable only by scrolling the full list.
  ["refunded", "Refunded"],
];

function counts() {
  return {
    all: bets.length,
    uncollected: bets.filter(isUncollected).length,
    open: bets.filter(isOpen).length,
    won: bets.filter(isWin).length,
    lost: bets.filter((b) => b.state === "LOST").length,
    refunded: bets.filter(isRefund).length,
  };
}

function renderFilters() {
  const c = counts();
  $("pf-filters").innerHTML = TABS.map(([key, label]) =>
    `<button class="chip ${filter === key ? "is-active" : ""}" data-filter="${key}"
      ${!c[key] && key !== "all" ? "disabled" : ""}>${label}<span class="chip__count">${c[key]}</span></button>`
  ).join("");

  $("pf-filters").querySelectorAll("[data-filter]").forEach((b) =>
    b.addEventListener("click", () => { filter = b.dataset.filter; renderFilters(); renderTable(); })
  );
}

function visible() {
  if (filter === "uncollected") return bets.filter(isUncollected);
  if (filter === "open") return bets.filter(isOpen);
  if (filter === "won") return bets.filter(isWin);
  if (filter === "lost") return bets.filter((b) => b.state === "LOST");
  if (filter === "refunded") return bets.filter(isRefund);
  return bets;
}

/* ── table ───────────────────────────────────────────────────────────────── */

function outcomeCell(b) {
  if (!isSettled(b)) {
    return b.state === "LIVE"
      ? `<span class="pill pill--live"><span class="dot-live"></span>Running</span>`
      : `<span class="pill pill--open">Betting open</span>`;
  }
  if (b.state === "LOST") {
    return `<span class="pill pill--resolved">Lost</span>
            <div class="hist-note" style="color:var(--down)">${b.winner} won · ${moveText(b)}</div>`;
  }
  if (isRefund(b)) {
    return `<span class="pill pill--draw">Refunded</span>
            <div class="hist-note">${b.winner === "DRAW" ? "price finished level" : "no opposing side"}</div>`;
  }
  return `<span class="pill pill--open">Won</span>
          <div class="hist-note" style="color:var(--up)">${b.side} was right · ${moveText(b)}</div>`;
}

function collectCell(b) {
  if (isUncollected(b)) {
    return `<button class="btn btn--primary btn--sm" data-collect="${b.market}|${b.round_id}">
              Collect ${genFromWei(b.payout, 3)}</button>`;
  }
  if (b.state === "COLLECTED") {
    return `<span class="pill pill--resolved" title="${fullWhen(b.claimed_ts)}">Collected</span>
            <div class="hist-note">${b.claimed_ts ? whenText(b.claimed_ts) : ""}</div>`;
  }
  if (b.state === "LOST") return `<span class="hist-note">nothing to collect</span>`;
  return `<span class="hist-note">not settled yet</span>`;
}

function renderTable() {
  const body = $("pf-body");
  const note = $("hist-note");
  if (!wallet.account) {
    body.innerHTML = `<tr><td colspan="8" class="empty">Connect your wallet to see your history</td></tr>`;
    note.textContent = "";
    return;
  }
  const rows = visible();
  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="8" class="empty">${
      bets.length === 0
        ? `No rounds yet — <a href="index.html" style="color:var(--accent)">browse markets</a>`
        : "Nothing in this filter"
    }</td></tr>`;
    note.textContent = bets.length ? `${bets.length} rounds total` : "";
    return;
  }

  body.innerHTML = rows.map((b) => {
    const sym = b.market.split("-")[0];
    const payout =
      isWin(b) || isRefund(b)
        ? `<span class="mono" style="color:var(--up)">+${genFromWei(b.payout, 3)}</span>`
        : b.state === "LOST"
        ? `<span class="mono" style="color:var(--down)">−${genFromWei(b.amount, 3)}</span>`
        : `<span style="color:var(--text-muted)">—</span>`;
    const when = b.close_ts || b.lock_ts || b.start_ts;
    return `<tr>
      <td>
        <a href="market.html?m=${encodeURIComponent(b.market)}" class="hist-market">
          ${coinLogo(sym, 22)}<span>${b.market}</span>
        </a>
        <div class="hist-note mono">#${b.round_id}</div>
      </td>
      <td class="t-center" title="${fullWhen(when)}">${whenText(when)}</td>
      <td class="t-center" style="color:var(--${b.side === "UP" ? "up" : "down"})">
        ${b.side === "UP" ? "▲" : "▼"} ${b.side}
      </td>
      <td class="t-center mono">${genFromWei(b.amount, 3)}</td>
      <td class="t-center mono" style="color:var(--text-dim);white-space:nowrap">
        ${b.lock_price ? fmtUsd(b.lock_price) : "—"} → ${b.close_price ? fmtUsd(b.close_price) : "—"}
      </td>
      <td class="t-center">${outcomeCell(b)}</td>
      <td class="t-right">${payout}</td>
      <td class="t-right">${collectCell(b)}</td>
    </tr>`;
  }).join("");

  note.textContent = rows.length === bets.length
    ? `${bets.length} round${bets.length === 1 ? "" : "s"}`
    : `${rows.length} of ${bets.length} rounds`;

  body.querySelectorAll("[data-collect]").forEach((btn) =>
    btn.addEventListener("click", () => collectOne(btn))
  );
}

async function collectOne(btn) {
  const [market, rid] = btn.dataset.collect.split("|");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Confirm…";
  try {
    const hash = await write(CONFIG.predictAddress, "claim", [market, Number(rid)]);
    btn.textContent = "Waiting…";
    toast(`Collecting — <a href="${txLink(hash)}" target="_blank">view tx</a>`, "pending", { html: true });
    await waitAccepted(hash);
    toast("Collected into your play balance", "success");
    await Promise.all([
      refresh({ fresh: true }),
      refreshVaultChip({ fresh: true }),
      results.refresh({ fresh: true }),
    ]);
  } catch (e) {
    toast(e.message || "Could not collect", "error");
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* ── data ────────────────────────────────────────────────────────────────── */

async function refresh({ fresh = false } = {}) {
  if (!wallet.account) { bets = []; renderSummary(); renderFilters(); renderTable(); return; }
  try {
    const raw = await readPredict("get_user_portfolio", [wallet.account.toLowerCase()], { fresh });
    bets = typeof raw === "string" ? JSON.parse(raw) : raw || [];
  } catch (e) {
    // Keep whatever is on screen: one bad read should not blank a history.
    if (bets.length === 0) {
      $("pf-body").innerHTML =
        `<tr><td colspan="8" class="empty">Could not load your history — retrying…</td></tr>`;
    }
    return;
  }
  renderSummary();
  renderFilters();
  renderTable();
}

(async function init() {
  mountHeader("portfolio");
  await loadConfig();
  renderSummary();
  renderFilters();
  await autoReconnect();
  await refreshVaultChip();
  await results.primeSeen();
  await results.refresh();
  await refresh();

  onWalletChange(async () => {
    await refreshVaultChip();
    await results.primeSeen();
    await results.refresh();
    await refresh();
  });
  // Collecting from the banner should update the table underneath it.
  results.onResults(() => refresh());
  pollWhileVisible(async () => { await refreshVaultChip(); await refresh(); }, 45000);
})();
