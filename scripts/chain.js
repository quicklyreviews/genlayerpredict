/**
 * The one place that decides which chain this project talks to.
 *
 * Everything here targets **GenLayer Studionet (chain 61999)** and nothing else.
 * That is not a preference — the deployed contracts live there, so pointing a
 * keeper or a script at another network would either fail confusingly or, worse,
 * transact against a contract that happens to share the address.
 *
 * The codebase used to spread `{ ...localnet, id: 61999 }` across nine files:
 * localnet's config with studionet's id bolted on. It worked by accident, and it
 * meant an RPC pointed anywhere else would be trusted without question. genlayer-js
 * exports `studionet` properly, so use it, and refuse anything that is not it.
 */
const { studionet } = require("genlayer-js/chains");

const STUDIONET_CHAIN_ID = 61999;
const STUDIONET_RPC = "https://studio.genlayer.com/api";

/**
 * Resolves the RPC endpoint, refusing anything that is not Studionet.
 *
 * Defaults are fine; an explicit GENLAYER_RPC_URL pointing elsewhere is not, and
 * failing loudly at startup beats discovering it after a transaction lands.
 */
function resolveRpc(url = process.env.GENLAYER_RPC_URL) {
  const rpc = (url || STUDIONET_RPC).trim();
  const isStudio = /(^|\/\/)studio\.genlayer\.com/.test(rpc);
  const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(rpc);
  if (!isStudio && !isLoopback) {
    throw new Error(
      `This project runs on GenLayer Studionet only.\n` +
        `  GENLAYER_RPC_URL is "${rpc}"\n` +
        `  Expected ${STUDIONET_RPC} (a localhost simulator is also accepted).`
    );
  }
  return rpc;
}

/** Warns once if the node behind an accepted RPC is not the chain we expect. */
async function assertStudionet(rpc) {
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
      signal: AbortSignal.timeout(10000),
    });
    const id = parseInt(((await res.json()) || {}).result, 16);
    if (Number.isFinite(id) && id !== STUDIONET_CHAIN_ID) {
      console.warn(
        `[chain] ⚠ ${rpc} reports chain ${id}, expected ${STUDIONET_CHAIN_ID} (Studionet).`
      );
      return false;
    }
    return true;
  } catch (e) {
    // A probe failure is not proof of the wrong chain; let the caller proceed.
    return null;
  }
}

module.exports = { studionet, STUDIONET_CHAIN_ID, STUDIONET_RPC, resolveRpc, assertStudionet };
