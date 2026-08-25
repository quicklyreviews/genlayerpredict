/**
 * Session wallet — play without signing every bet.
 *
 * GenLayer takes about a minute to reach consensus, so a wallet popup on every
 * bet is not just friction: by the time you have read the prompt and clicked
 * approve, the betting window may have closed. The fix is the pattern web3 games
 * settled on — a throwaway keypair that lives in this browser and signs for you.
 *
 *   1. The browser generates a private key and keeps it in localStorage.
 *   2. You fund it once from your real wallet. That is the only popup.
 *   3. Every bet after that is signed locally. No prompts, no waiting on a click.
 *   4. Cashing out sweeps everything back to the wallet you funded it from.
 *
 * WHAT THIS COSTS YOU, PLAINLY
 *
 * The key sits in localStorage, so anything that can run script on this page —
 * a malicious extension, an XSS hole — can take whatever the session wallet
 * holds. That is a real risk and it is why the design deliberately bounds it:
 *
 *   • Only the session wallet is exposed. Your main wallet never signs anything
 *     except the one funding transfer, and holds no approval that could be reused.
 *   • The worst case is capped at what you funded, which the UI nudges you to keep
 *     small — spending money, not savings.
 *   • The key never leaves the browser. It is not sent to the backend, and the
 *     operator cannot spend on your behalf; this stays non-custodial.
 *
 * The alternative — the backend holding keys and signing for everyone — removes
 * the popup too, but then one leaked server file drains every player at once.
 * A per-user key with a small balance is the smaller blast radius.
 */
import { createClient } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import { TransactionStatus } from 'genlayer-js/types';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { CONFIG, wallet, getProvider, genFromWei, parseGenToWei, toast, txLink } from './shared.js';

const KEY_STORAGE = "genpredict_session_key";
const OWNER_STORAGE = "genpredict_session_owner";

export const session = {
  account: null,     // viem local account, or null when not enabled
  client: null,      // genlayer client signing with that account
  owner: null,       // the wallet that funded it, for sweeping back
  gasBalance: 0n,    // native GEN held by the session wallet, for fees
};

const listeners = [];
export function onSessionChange(fn) { listeners.push(fn); }
function emit() {
  listeners.forEach((fn) => { try { fn(session); } catch (e) { console.error(e); } });
}

/** True when bets can be signed locally rather than through the wallet popup. */
export function sessionActive() {
  return !!session.account;
}

function buildClient(account) {
  return createClient({ chain: studionet, endpoint: CONFIG.rpcUrl || "https://studio.genlayer.com/api", account });
}

/** Restores a session key from a previous visit, if one belongs to this wallet. */
export function loadSession() {
  try {
    const pk = localStorage.getItem(KEY_STORAGE);
    const owner = localStorage.getItem(OWNER_STORAGE);
    if (!pk) return null;
    // A key funded by a different wallet is not this user's to spend — switching
    // accounts must not silently hand over someone else's session balance.
    if (owner && wallet.account && owner.toLowerCase() !== wallet.account.toLowerCase()) {
      return null;
    }
    session.account = privateKeyToAccount(pk);
    session.client = buildClient(session.account);
    session.owner = owner;
    emit();
    return session.account;
  } catch (e) {
    return null;
  }
}

/** Creates a fresh session key bound to the currently connected wallet. */
export function createSession() {
  const pk = generatePrivateKey();
  localStorage.setItem(KEY_STORAGE, pk);
  if (wallet.account) localStorage.setItem(OWNER_STORAGE, wallet.account.toLowerCase());
  session.account = privateKeyToAccount(pk);
  session.client = buildClient(session.account);
  session.owner = wallet.account || null;
  emit();
  return session.account;
}

export function forgetSession() {
  localStorage.removeItem(KEY_STORAGE);
  localStorage.removeItem(OWNER_STORAGE);
  session.account = null;
  session.client = null;
  session.owner = null;
  session.gasBalance = 0n;
  emit();
}

/** Native GEN held by the session wallet — this is what pays gas. */
export async function refreshSessionGas() {
  if (!session.account) { session.gasBalance = 0n; return 0n; }
  try {
    const res = await fetch(CONFIG.rpcUrl || "https://studio.genlayer.com/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", method: "eth_getBalance",
        params: [session.account.address, "latest"], id: 1,
      }),
    });
    session.gasBalance = BigInt(((await res.json()) || {}).result || "0x0");
  } catch (e) {
    /* keep the last known figure */
  }
  emit();
  return session.gasBalance;
}

/**
 * Moves GEN from the main wallet into the session wallet. The single popup.
 *
 * The amount has to cover both the stake and the gas for every bet that follows,
 * because once funded the session wallet pays its own fees.
 */
export async function fundSession(amountGen) {
  if (!session.account) createSession();
  const provider = getProvider();
  if (!provider) throw new Error("No wallet detected");
  if (!wallet.account) throw new Error("Connect your wallet first");

  const valueHex = "0x" + parseGenToWei(amountGen).toString(16);
  const hash = await provider.request({
    method: "eth_sendTransaction",
    params: [{ from: wallet.account, to: session.account.address, value: valueHex }],
  });
  localStorage.setItem(OWNER_STORAGE, wallet.account.toLowerCase());
  session.owner = wallet.account.toLowerCase();
  return hash;
}

/** Signs a contract call with the session key — no popup. */
export async function sessionWrite(address, functionName, args = [], valueWei = 0n) {
  if (!session.client) throw new Error("No session wallet — enable instant play first");
  return session.client.writeContract({
    address,
    functionName,
    args,
    value: typeof valueWei === "bigint" ? valueWei : BigInt(valueWei),
  });
}

export async function sessionWaitAccepted(hash, { retries = 60 } = {}) {
  return session.client.waitForTransactionReceipt({
    hash, status: TransactionStatus.ACCEPTED, interval: 3000, retries,
  });
}

/**
 * Returns whatever native GEN is left to the funding wallet.
 *
 * A little has to stay behind to pay for this very transaction, so the sweep is
 * deliberately short of the full balance rather than failing on its own fee.
 */
export async function sweepSession() {
  if (!session.account) throw new Error("No session wallet");
  const target = session.owner || wallet.account;
  if (!target) throw new Error("Nowhere to send it — connect the funding wallet");
  await refreshSessionGas();

  const reserve = parseGenToWei("0.02");
  if (session.gasBalance <= reserve) {
    throw new Error(`Only ${genFromWei(session.gasBalance, 4)} GEN left — not enough to cover the transfer fee`);
  }
  const amount = session.gasBalance - reserve;
  const hash = await session.client.sendTransaction({ to: target, value: amount });
  return { hash, amount };
}

/** Describes the session in the terms a player cares about. */
export function sessionSummary() {
  if (!session.account) {
    return { active: false, label: "Instant play off" };
  }
  return {
    active: true,
    address: session.account.address,
    owner: session.owner,
    gas: session.gasBalance,
    // Bets are cheap, but running out of gas mid-round is a confusing failure, so
    // warn while there is still time to top up.
    lowGas: session.gasBalance < parseGenToWei("0.05"),
    label: `Instant play on · ${genFromWei(session.gasBalance, 3)} GEN for fees`,
  };
}
