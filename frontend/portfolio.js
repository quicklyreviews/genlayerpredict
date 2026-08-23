/**
 * GenPredict portfolio — every bet across every market, from one contract call.
 */
import {
  CONFIG, $, loadConfig, readPredict, mountHeader, wallet, onWalletChange, autoReconnect,
  connectWallet, genFromWei, fmtUsd, write, waitAccepted, toast, txLink,
} from './shared.js';

let bets = [];

function stat(label, value, color) {
  return `<div class="panel" style="text-align:center;padding:14px">
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted)">${label}</div>
    <div class="mono" style="font-size:20px;font-weight:700;margin-top:5px;${color ? `color:${color}` : ""}">${value}</div>
  </div>`;
}

function renderSummary() {
  const settled = bets.filter((b) => b.status === "RESOLVED");
  const wins = settled.filter((b) => Number(b.payout) > 0).length;
  const staked = bets.reduce((s, b) => s + Number(BigInt(b.amount)) / 1e18, 0);
  // Net counts only settled rounds: an open bet has no result to book yet.
  const returned = settled.reduce((s, b) => s + Number(BigInt(b.payout)) / 1e18, 0);
  const settledStake = settled.reduce((s, b) => s + Number(BigInt(b.amount)) / 1e18, 0);
  const net = returned - settledStake;
  const claimable = bets.filter((b) => (b.state === "CLAIMABLE" || b.state === "REFUNDABLE"));
  const claimableSum = claimable.reduce((s, b) => s + Number(BigInt(b.payout)) / 1e18, 0);

  $("summary").innerHTML = [
    stat("Total bets", bets.length),
    stat("Win rate", settled.length ? `${Math.round((wins / settled.length) * 100)}%` : "—"),
    stat("Staked", `${staked.toFixed(2)} GEN`),
    stat("Net P&L", `${net >= 0 ? "+" : ""}${net.toFixed(3)} GEN`, net > 0 ? "var(--up)" : net < 0 ? "var(--down)" : undefined),
    stat("To collect", `${claimableSum.toFixed(3)} GEN`, claimableSum > 0 ? "var(--up)" : undefined),
  ].join("");
}

const statePill = {
  PENDING: `<span class="pill pill--open">Open</span>`,
  LIVE: `<span class="pill pill--live"><span class="dot-live"></span>Live</span>`,
  CLAIMABLE: `<span class="pill pill--open">Won</span>`,
  REFUNDABLE: `<span class="pill pill--draw">Refund</span>`,
  CLAIMED: `<span class="pill pill--resolved">Collected</span>`,
  LOST: `<span class="pill pill--resolved">Lost</span>`,
};

function renderTable() {
  const body = $("pf-body");
  if (!wallet.account) {
    body.innerHTML = `<tr><td colspan="8" class="empty">Connect your wallet to see your bets</td></tr>`;
    return;
  }
  if (bets.length === 0) {
    body.innerHTML = `<tr><td colspan="8" class="empty">No bets yet — <a href="index.html" style="color:var(--accent)">browse markets</a></td></tr>`;
    return;
  }
  body.innerHTML = bets.map((b) => {
    const winner = b.winner === "DRAW"
      ? `<span class="pill pill--draw">Draw</span>`
      : b.winner
      ? `<span style="color:var(--${b.winner === "UP" ? "up" : "down"})">${b.winner}</span>`
      : `<span style="color:var(--text-muted)">—</span>`;
    const payoutCell =
      (b.state === "CLAIMABLE" || b.state === "REFUNDABLE")
        ? `<button class="btn btn--primary btn--sm" data-claim="${b.market}|${b.round_id}">${b.state === "REFUNDABLE" ? "Refund" : "Collect"} ${genFromWei(b.payout, 2)}</button>`
        : b.state === "CLAIMED"
        ? `<span class="mono" style="color:var(--up)">+${genFromWei(b.payout, 3)}</span>`
        : b.state === "LOST"
        ? `<span class="mono" style="color:var(--down)">−${genFromWei(b.amount, 3)}</span>`
        : `<span style="color:var(--text-muted)">—</span>`;
    return `<tr>
      <td><a href="market.html?m=${encodeURIComponent(b.market)}" style="color:var(--text)">${b.market}</a></td>
      <td class="mono">#${b.round_id}</td>
      <td class="t-center" style="color:var(--${b.side === "UP" ? "up" : "down"})">${b.side === "UP" ? "▲" : "▼"} ${b.side}</td>
      <td class="t-center mono">${genFromWei(b.amount, 3)}</td>
      <td class="t-center mono" style="color:var(--text-dim)">${b.lock_price ? fmtUsd(b.lock_price) : "—"} → ${b.close_price ? fmtUsd(b.close_price) : "—"}</td>
      <td class="t-center">${winner}</td>
      <td class="t-center">${statePill[b.state] || b.state}</td>
      <td class="t-right">${payoutCell}</td>
    </tr>`;
  }).join("");

  body.querySelectorAll("[data-claim]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const [market, roundId] = btn.dataset.claim.split("|");
      btn.disabled = true; btn.textContent = "Signing…";
      try {
        const hash = await write(CONFIG.predictAddress, "claim", [market, Number(roundId)]);
        toast(`Collecting — <a href="${txLink(hash)}" target="_blank">view tx</a>`, "pending", { html: true });
        await waitAccepted(hash);
        toast("Winnings collected", "success");
        await refresh();
      } catch (e) {
        toast(e.message || "Claim failed", "error");
        btn.disabled = false; btn.textContent = "Collect";
      }
    })
  );

  $("hist-note").textContent = `${bets.length} bet${bets.length === 1 ? "" : "s"}`;
}

async function refresh() {
  if (!wallet.account) { bets = []; renderSummary(); renderTable(); return; }
  try {
    const raw = await readPredict("get_user_portfolio", [wallet.account.toLowerCase()]);
    bets = typeof raw === "string" ? JSON.parse(raw) : raw || [];
  } catch (e) { bets = []; }
  renderSummary();
  renderTable();
}

(async function init() {
  mountHeader("portfolio");
  await loadConfig();
  renderSummary();
  await autoReconnect();
  await refresh();
  onWalletChange(() => refresh());
  setInterval(refresh, 20000);
})();
