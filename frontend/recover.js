/**
 * Finds money left behind on superseded contracts, and hands it back.
 *
 * Deploying a new version of the prediction contract does not migrate anything.
 * The new contract starts with empty storage, the old one goes on holding whatever
 * players deposited, and the app only ever reads the current address — so a play
 * balance that was real yesterday reads as zero today and looks like the money was
 * taken. It was not: it is sitting in a contract nobody is pointing at any more.
 *
 * This checks the old addresses the backend still knows about, and offers to take
 * the balance back. Every transaction here is signed by the wallet that owns the
 * funds, against the old contract's own withdraw — nothing in this file can move
 * anyone else's money, and no operator key is involved.
 *
 * Stakes riding on a round that never settled are a separate problem: the keeper
 * for that contract stopped when it was superseded, so the round is frozen part-way.
 * Resolving is permissionless, so where a round is past its close time this offers
 * to finish it — after which the payout can be collected and withdrawn like any
 * other.
 */
import {
  CONFIG, $, wallet, genFromWei, toast, write, waitAccepted, txLink, refreshVaultChip,
} from './shared.js';

let found = [];
let scanning = false;

async function readAt(address, method, args = []) {
  const res = await fetch(`${CONFIG.backendUrl}/api/predict/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, args, type: "read", fresh: true, address }),
  });
  if (!res.ok) throw new Error(`read failed: ${res.status}`);
  return res.json();
}

/** What one old contract still owes this wallet, and what it would take to get it. */
async function inspect(address) {
  const out = { address, spendable: 0n, atRisk: 0n, claimable: [], stuck: [] };
  try {
    const acct = await readAt(address, "get_account", [wallet.account.toLowerCase()]);
    out.spendable = BigInt(acct.balance || "0");
    out.atRisk = BigInt(acct.at_risk || "0");
  } catch (e) {
    return null; // an address that no longer answers has nothing to give back
  }
  try {
    const raw = await readAt(address, "get_claimable", [wallet.account.toLowerCase()]);
    out.claimable = typeof raw === "string" ? JSON.parse(raw) : raw || [];
  } catch (e) { /* older versions may not have it */ }

  if (out.atRisk > 0n) {
    // A stake still at risk means a round that never finished. Find the ones that
    // are ripe, so the offer to resolve is only made when it would actually work.
    try {
      const raw = await readAt(address, "get_user_portfolio", [wallet.account.toLowerCase()]);
      const bets = typeof raw === "string" ? JSON.parse(raw) : raw || [];
      const now = Math.floor(Date.now() / 1000);
      // close_ts only exists on later versions of the contract, and the balances
      // worth recovering are mostly on earlier ones — filtering on it would hide
      // exactly the rounds this is here to unstick. When it is missing, offer the
      // button anyway: resolve_round refuses politely if the round is not ready,
      // which is a better outcome than silently pretending there is nothing to do.
      out.stuck = bets
        .filter((b) => b.state === "LIVE" || b.state === "PENDING")
        .map((b) => ({
          ...b,
          ripe: b.close_ts === undefined ? true : now >= Number(b.close_ts),
        }));
    } catch (e) { /* best effort */ }
  }
  return out;
}

function totalRecoverable(f) {
  return f.spendable + f.claimable.reduce((s, c) => s + BigInt(c.payout || 0), 0n);
}

export async function scan() {
  const legacy = CONFIG.predictLegacyAddresses || [];
  if (!wallet.account || legacy.length === 0) { found = []; render(); return; }
  if (scanning) return;
  scanning = true;
  try {
    const results = await Promise.all(legacy.map((a) => inspect(a).catch(() => null)));
    found = results.filter(
      (r) => r && (totalRecoverable(r) > 0n || r.atRisk > 0n)
    );
  } finally {
    scanning = false;
  }
  render();
}

function render() {
  const host = document.querySelector("[data-recover]");
  if (!host) return;
  if (found.length === 0) {
    host.classList.add("hidden");
    host.innerHTML = "";
    return;
  }
  const grand = found.reduce((s, f) => s + totalRecoverable(f), 0n);
  const stuckTotal = found.reduce((s, f) => s + f.atRisk, 0n);

  host.classList.remove("hidden");
  host.innerHTML = `
    <div class="recover">
      <div class="recover__head">
        <b>${genFromWei(grand, 4)} GEN is waiting on an older version of this contract</b>
      </div>
      <p class="recover__why">
        The contract was replaced and balances do not carry across. Your money stayed
        in the old one — take it back here, then deposit again if you want to keep playing.
        ${stuckTotal > 0n
          ? `<br/>A further ${genFromWei(stuckTotal, 4)} GEN is staked on a round that never
             finished, because the old version stopped running. Finish the round first and
             it becomes collectable.`
          : ""}
      </p>
      ${found.map((f, i) => {
        const amount = totalRecoverable(f);
        const ripe = f.stuck.filter((b) => b.ripe);
        return `
        <div class="recover__row">
          <span class="mono recover__addr" title="${f.address}">${f.address.slice(0, 10)}…${f.address.slice(-6)}</span>
          <span class="mono">${genFromWei(amount, 4)} GEN${f.atRisk > 0n ? ` · ${genFromWei(f.atRisk, 4)} stuck` : ""}</span>
          <span class="recover__actions">
            ${ripe.length
              ? `<button class="btn btn--ghost btn--sm" data-finish="${i}">Finish ${ripe.length} round${ripe.length > 1 ? "s" : ""}</button>`
              : ""}
            ${amount > 0n
              ? `<button class="btn btn--primary btn--sm" data-recover-i="${i}">Take back ${genFromWei(amount, 3)}</button>`
              : ""}
          </span>
        </div>`;
      }).join("")}
    </div>`;

  host.querySelectorAll("[data-recover-i]").forEach((btn) =>
    btn.addEventListener("click", () => recoverFrom(found[Number(btn.dataset.recoverI)], btn))
  );
  host.querySelectorAll("[data-finish]").forEach((btn) =>
    btn.addEventListener("click", () => finishRounds(found[Number(btn.dataset.finish)], btn))
  );
}

async function recoverFrom(f, btn) {
  const label = btn.textContent;
  btn.disabled = true;
  try {
    // Collect first: an uncollected win is not part of the withdrawable balance yet,
    // so withdrawing before claiming would leave it behind for good.
    if (f.claimable.length > 0) {
      btn.textContent = "Collecting…";
      const h = await write(f.address, "claim_all", []);
      toast(`Collecting from the old contract — <a href="${txLink(h)}" target="_blank">view tx</a>`,
            "pending", { html: true });
      await waitAccepted(h);
    }
    btn.textContent = "Withdrawing…";
    const h2 = await write(f.address, "withdraw_all", []);
    toast(`Withdrawing — <a href="${txLink(h2)}" target="_blank">view tx</a>`, "pending", { html: true });
    await waitAccepted(h2);
    toast("Recovered into your wallet", "success");
    await scan();
    await refreshVaultChip({ fresh: true });
  } catch (e) {
    toast(e.message || "Could not recover", "error");
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function finishRounds(f, btn) {
  const label = btn.textContent;
  btn.disabled = true;
  const ripe = f.stuck.filter((b) => b.ripe);
  try {
    for (const b of ripe) {
      btn.textContent = `Finishing #${b.round_id}…`;
      // resolve_round is permissionless by design, so the player can unstick their
      // own round without waiting for an operator to run a keeper again.
      const h = await write(f.address, "resolve_round", [b.market, Number(b.round_id)]);
      await waitAccepted(h);
    }
    toast("Round finished — take the payout back with the button beside it", "success");
    await scan();
  } catch (e) {
    toast(e.message || "Could not finish the round", "error");
    btn.disabled = false;
    btn.textContent = label;
  }
}
