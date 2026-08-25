/**
 * Earn page — supply GEN to either pool and watch the interest tick.
 *
 * Interest accrues per second on-chain, but reads are cached and slow-polled to
 * stay inside the node's request budget. So the figure on screen is projected
 * locally between fetches from the same formula the contract uses: principal x
 * rate x elapsed. A yield that only moved every thirty seconds would look broken
 * even though it was correct.
 */
import {
  CONFIG, $, loadConfig, readPredict, readPerp, mountHeader, wallet, onWalletChange,
  autoReconnect, connectWallet, genFromWei, parseGenToWei, write, waitAccepted,
  toast, txLink, pollWhileVisible,
} from './shared.js';

const SECONDS_PER_YEAR = 31536000;

const POOLS = [
  {
    id: "predict",
    name: "Prediction pool",
    blurb: "Players win from each other here, so your capital is never exposed to their trades.",
    risk: "No trading risk",
    riskClass: "pill--open",
    read: (fn, args) => readPredict(fn, args),
    address: () => CONFIG.predictAddress,
  },
  {
    id: "perp",
    name: "Perps pool",
    blurb: "Your capital is the counterparty to leveraged traders — it grows on their losses and shrinks on their wins.",
    risk: "Capital at risk",
    riskClass: "pill--closing",
    read: (fn, args) => readPerp(fn, args),
    address: () => CONFIG.perpAddress,
  },
];

// Last figures fetched per pool, plus when, so interest can be projected forward.
const state = {};

function projectedInterest(p) {
  const s = state[p.id];
  if (!s || !s.stake) return 0n;
  const principal = BigInt(s.stake.principal || "0");
  if (principal === 0n) return 0n;
  const elapsed = BigInt(Math.max(0, Math.floor((Date.now() - s.fetchedAt) / 1000)));
  const apy = BigInt(s.pool.apy_bps || 0);
  const since = (principal * apy * elapsed) / (10000n * BigInt(SECONDS_PER_YEAR));
  return BigInt(s.stake.interest || "0") + since;
}

function runwayLabel(seconds) {
  const n = Number(seconds);
  if (n < 0) return "—";
  if (n < 3600) return `${Math.round(n / 60)} min`;
  if (n < 86400) return `${Math.round(n / 3600)} hours`;
  return `${Math.round(n / 86400).toLocaleString()} days`;
}

function poolCard(p) {
  const s = state[p.id];
  if (!s) return `<div class="skel skel-card"></div>`;
  const apy = (Number(s.pool.apy_bps) / 100).toFixed(1);
  const staked = BigInt(s.stake?.principal || "0");
  const interest = projectedInterest(p);
  const runway = Number(s.pool.runway_seconds);
  const lowRunway = runway >= 0 && runway < 7 * 86400;

  const mine = staked > 0n
    ? `<div class="pricebox" style="margin-top:12px">
         <div class="priceline"><span>You supplied</span><b>${genFromWei(staked, 4)} GEN</b></div>
         <div class="priceline"><span>Interest earned</span>
           <b class="mono" style="color:var(--up)" data-interest="${p.id}">+${genFromWei(interest, 9)} GEN</b></div>
         ${s.stake.withdrawable_now !== undefined && BigInt(s.stake.withdrawable_now) < staked
           ? `<div class="priceline"><span>Withdrawable now</span>
              <b style="color:var(--warn)">${genFromWei(s.stake.withdrawable_now, 4)} GEN</b></div>`
           : ""}
       </div>`
    : `<div class="notice notice--info" style="margin-top:12px">
         <span>—</span><span>You have nothing in this pool yet.</span></div>`;

  return `
    <div class="panel" style="display:flex;flex-direction:column;gap:2px">
      <div style="display:flex;align-items:flex-start;gap:10px">
        <div style="flex:1">
          <div style="font-size:15px;font-weight:650">${p.name}</div>
          <div style="font-size:12.5px;color:var(--text-muted);margin-top:3px;line-height:1.45">${p.blurb}</div>
        </div>
        <span class="pill ${p.riskClass}">${p.risk}</span>
      </div>

      <div style="display:flex;align-items:baseline;gap:8px;margin:14px 0 2px">
        <span class="mono" style="font-size:30px;font-weight:700;color:var(--accent)">${apy}%</span>
        <span style="font-size:12px;color:var(--text-muted)">a year, per second</span>
      </div>

      <div class="pool-row"><span>Supplied by everyone</span>
        <b>${genFromWei(s.pool.staked_principal, 3)} GEN</b></div>
      <div class="pool-row"><span>Providers</span><b>${s.pool.providers}</b></div>
      <div class="pool-row"><span>Reward balance lasts</span>
        <b style="${lowRunway ? "color:var(--warn)" : ""}">${runwayLabel(runway)}</b></div>
      ${lowRunway ? `<div class="notice notice--warn" style="margin-top:8px"><span>⚠</span>
        <span>The subsidy is nearly out. Principal is unaffected, but interest may go unpaid
        until it is topped up.</span></div>` : ""}

      ${mine}

      <div class="field" style="margin-top:14px">
        <div class="input-wrap">
          <input id="amt-${p.id}" type="number" min="0" step="0.5" value="1" inputmode="decimal"
                 aria-label="Amount for ${p.name}"/>
          <span class="input-wrap__suffix">GEN</span>
        </div>
      </div>
      <div class="actions" style="margin-top:10px">
        <button class="btn btn--primary" data-act="stake" data-pool="${p.id}">Supply</button>
        <button class="btn btn--ghost" data-act="unstake" data-pool="${p.id}"
                ${staked === 0n ? "disabled" : ""}>Withdraw</button>
      </div>
      ${staked > 0n ? `<button class="btn btn--ghost btn--block" style="margin-top:8px"
        data-act="claim" data-pool="${p.id}">Take interest only</button>` : ""}
      <p class="modal__error" data-error="${p.id}"></p>
    </div>`;
}

function render() {
  $("pools").innerHTML = POOLS.map(poolCard).join("");
  const first = state[POOLS[0].id];
  if (first) $("apy-headline").textContent = `${(Number(first.pool.apy_bps) / 100).toFixed(0)}%`;
  wireActions();
}

/** Ticks only the interest figures, so typing in an amount box is never interrupted. */
function tick() {
  for (const p of POOLS) {
    const el = document.querySelector(`[data-interest="${p.id}"]`);
    if (el) el.textContent = `+${genFromWei(projectedInterest(p), 9)} GEN`;
  }
}

function wireActions() {
  document.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const p = POOLS.find((x) => x.id === btn.dataset.pool);
      const act = btn.dataset.act;
      const err = document.querySelector(`[data-error="${p.id}"]`);
      err.textContent = "";

      if (!wallet.account) {
        const acct = await connectWallet();
        if (!acct) return;
      }

      const raw = $(`amt-${p.id}`)?.value || "0";
      if (act !== "claim" && !(Number(raw) > 0)) {
        err.textContent = "Enter an amount above zero.";
        return;
      }

      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Confirm in wallet…";
      try {
        const wei = parseGenToWei(raw);
        let hash;
        if (act === "stake") hash = await write(p.address(), "stake", [], wei);
        else if (act === "unstake") hash = await write(p.address(), "unstake", [wei]);
        else hash = await write(p.address(), "claim_interest", []);

        btn.textContent = "Waiting for consensus…";
        toast(`Sent — <a href="${txLink(hash)}" target="_blank">view tx</a>`, "pending",
              { html: true, timeout: 10000 });
        await waitAccepted(hash);
        toast(
          act === "stake" ? `Supplied ${raw} GEN` :
          act === "unstake" ? `Withdrew ${raw} GEN plus interest` : "Interest collected",
          "success"
        );
        await refresh();
      } catch (e) {
        // The contract's own message is the useful one — it explains a withdrawal
        // capped by open positions, or an empty subsidy, in the user's terms.
        err.textContent = e.message || "Transaction failed";
        btn.disabled = false;
        btn.textContent = label;
      }
    });
  });
}

async function refresh() {
  await Promise.all(POOLS.map(async (p) => {
    if (!p.address()) return;
    try {
      const pool = await p.read("get_pool", []);
      const stake = wallet.account
        ? await p.read("get_stake", [wallet.account.toLowerCase()])
        : null;
      state[p.id] = { pool, stake, fetchedAt: Date.now() };
    } catch (e) {
      /* keep the previous snapshot rather than blanking the card */
    }
  }));
  render();
}

(async function init() {
  mountHeader("pool");
  await loadConfig();
  await refresh();
  await autoReconnect();
  await refresh();

  onWalletChange(() => refresh());
  setInterval(tick, 1000);
  pollWhileVisible(refresh, 30000);
})();
