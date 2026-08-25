/**
 * Tells you how your bets turned out.
 *
 * Until now a round settling was silent: you bet, waited five minutes, and had to
 * notice a table had changed. A prediction game that never tells you whether you
 * won is missing the point of playing it.
 *
 * So this watches your bets and announces every transition:
 *
 *   won   → a banner with the amount and a Collect button
 *   lost  → a plain notice saying what happened and why
 *   void  → refunded, with the reason (price unchanged, or nobody took the other side)
 *
 * Every settled round is announced exactly once. The set of rounds already seen is
 * kept in localStorage, so a reload does not replay every old result — and it is
 * scoped per wallet, so switching accounts does not show you someone else's history.
 */
import {
  CONFIG, $, readPredict, wallet, genFromWei, fmtUsd, write, waitAccepted,
  toast, txLink, refreshVaultChip,
} from './shared.js';

const SEEN_KEY = "genpredict_seen_results";

function seenKey() {
  return `${SEEN_KEY}_${(wallet.account || "anon").toLowerCase()}`;
}

function loadSeen() {
  try { return new Set(JSON.parse(localStorage.getItem(seenKey()) || "[]")); }
  catch (e) { return new Set(); }
}

function saveSeen(set) {
  try {
    // Cap it: a heavy player would otherwise grow this forever, and only recent
    // rounds can still produce a notification worth suppressing.
    const arr = [...set].slice(-300);
    localStorage.setItem(seenKey(), JSON.stringify(arr));
  } catch (e) { /* private mode — announcements may repeat, which is harmless */ }
}

let claimable = [];
const listeners = [];
export function onResults(fn) { listeners.push(fn); }

/** The unclaimed total, so a header badge can show money waiting. */
export function claimableTotal() {
  return claimable.reduce((sum, c) => sum + BigInt(c.payout), 0n);
}
export function claimableList() { return claimable; }

function priceMove(lock, close) {
  const l = parseFloat(lock), c = parseFloat(close);
  if (!isFinite(l) || !isFinite(c) || l === 0) return "";
  const pct = ((c - l) / l) * 100;
  return `${fmtUsd(lock)} → ${fmtUsd(close)} (${pct >= 0 ? "+" : ""}${pct.toFixed(3)}%)`;
}

function announceWin(bet) {
  const move = priceMove(bet.lock_price, bet.close_price);
  const isRefund = bet.settlement === "VOID";
  const body = isRefund
    ? `<b>Round ${bet.market} #${bet.round_id} was refunded.</b><br/>
       ${bet.winner === "DRAW" ? "The price finished exactly level" : "Nobody took the other side"},
       so your ${genFromWei(bet.amount)} GEN comes back in full.<br/>
       <span style="opacity:.75">${move}</span>`
    : `<b>You won ${genFromWei(bet.payout)} GEN</b> on ${bet.market} #${bet.round_id}<br/>
       ${bet.side} was right — <span style="opacity:.75">${move}</span>`;
  toast(`${body}<br/><span style="opacity:.75">Collect it from the banner above.</span>`,
        "success", { html: true, timeout: 15000 });
}

function announceLoss(bet) {
  const move = priceMove(bet.lock_price, bet.close_price);
  toast(
    `<b>Round ${bet.market} #${bet.round_id} went ${bet.winner}.</b><br/>
     You backed ${bet.side}, so the ${genFromWei(bet.amount)} GEN stake is gone.<br/>
     <span style="opacity:.75">${move}</span>`,
    "error", { html: true, timeout: 12000 }
  );
}

/**
 * Renders the "you have winnings" banner into [data-claim-banner], if the page has one.
 */
export function renderClaimBanner() {
  const host = document.querySelector("[data-claim-banner]");
  if (!host) return;
  const total = claimableTotal();
  if (!wallet.account || total === 0n) {
    host.classList.add("hidden");
    host.innerHTML = "";
    return;
  }
  const wins = claimable.filter((c) => c.settlement !== "VOID").length;
  const refunds = claimable.length - wins;
  const parts = [];
  if (wins) parts.push(`${wins} win${wins > 1 ? "s" : ""}`);
  if (refunds) parts.push(`${refunds} refund${refunds > 1 ? "s" : ""}`);

  host.classList.remove("hidden");
  host.innerHTML = `
    <div class="claim-banner">
      <div class="claim-banner__text">
        <div class="claim-banner__amount">${genFromWei(total, 4)} GEN waiting</div>
        <div class="claim-banner__sub">${parts.join(" and ")} — collect into your play balance</div>
      </div>
      <button class="btn btn--primary" id="collect-all">
        Collect ${claimable.length > 1 ? "all" : ""}</button>
    </div>`;

  $("collect-all").addEventListener("click", async () => {
    const btn = $("collect-all");
    btn.disabled = true;
    btn.textContent = "Confirm in wallet…";
    try {
      // One transaction for everything: asking for a signature per round is exactly
      // the friction that leaves winnings uncollected.
      const single = claimable.length === 1;
      const hash = single
        ? await write(CONFIG.predictAddress, "claim", [claimable[0].market, claimable[0].round_id])
        : await write(CONFIG.predictAddress, "claim_all", []);
      btn.textContent = "Waiting for consensus…";
      toast(`Collecting — <a href="${txLink(hash)}" target="_blank">view tx</a>`,
            "pending", { html: true, timeout: 10000 });
      await waitAccepted(hash);
      toast(`Collected ${genFromWei(total, 4)} GEN into your play balance`, "success");
      await refresh({ fresh: true });
      await refreshVaultChip({ fresh: true });
    } catch (e) {
      toast(e.message || "Could not collect", "error");
      btn.disabled = false;
      btn.textContent = "Collect all";
    }
  });
}

/**
 * Fetches outstanding winnings and announces anything that settled since last time.
 */
export async function refresh({ fresh = false, announce = true } = {}) {
  if (!wallet.account || !CONFIG.predictAddress) {
    claimable = [];
    renderClaimBanner();
    return;
  }
  try {
    const raw = await readPredict("get_claimable", [wallet.account.toLowerCase()], { fresh });
    claimable = typeof raw === "string" ? JSON.parse(raw) : raw || [];
  } catch (e) {
    return; // keep the previous view rather than clearing the banner on a blip
  }

  if (announce) {
    const seen = loadSeen();
    let changed = false;

    for (const c of claimable) {
      const id = `${c.market}#${c.round_id}`;
      if (seen.has(id)) continue;
      seen.add(id); changed = true;
      announceWin(c);
    }

    // Losses never appear in get_claimable — there is nothing to collect — so they
    // have to be found in the bet history instead.
    try {
      const rawAll = await readPredict("get_user_portfolio", [wallet.account.toLowerCase()], { fresh });
      const all = typeof rawAll === "string" ? JSON.parse(rawAll) : rawAll || [];
      for (const b of all) {
        if (b.state !== "LOST") continue;
        const id = `${b.market}#${b.round_id}`;
        if (seen.has(id)) continue;
        seen.add(id); changed = true;
        announceLoss(b);
      }
      // Rounds still running must not be marked seen, or their result would be
      // swallowed when they finally settle.
    } catch (e) { /* announcements are best-effort */ }

    if (changed) saveSeen(seen);
  }

  renderClaimBanner();
  listeners.forEach((fn) => { try { fn(claimable); } catch (e) { console.error(e); } });
}

/**
 * On a player's very first load we do not want a burst of toasts for history they
 * have already lived through — so mark everything current as seen, silently.
 */
export async function primeSeen() {
  if (!wallet.account) return;
  const seen = loadSeen();
  if (seen.size > 0) return; // returning player: announce normally
  try {
    const raw = await readPredict("get_user_portfolio", [wallet.account.toLowerCase()]);
    const all = typeof raw === "string" ? JSON.parse(raw) : raw || [];
    for (const b of all) {
      if (b.state === "PENDING" || b.state === "LIVE") continue;
      seen.add(`${b.market}#${b.round_id}`);
    }
    saveSeen(seen);
  } catch (e) { /* nothing to prime */ }
}
