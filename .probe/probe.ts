/**
 * Probe: does gl.ContractAt actually let one Intelligent Contract call another?
 *
 * A shared vault across GenPredict and GenPerp depends entirely on this, and the
 * API is barely documented, so prove it on a throwaway pair before designing
 * anything around it. Three questions:
 *   1. Does a cross-contract WRITE mutate the callee's state?
 *   2. Does a cross-contract READ work from a view method?
 *   3. Who does the callee see as gl.message.sender_address — the calling contract
 *      or the original wallet? This decides whether a vault can authorise callers.
 */
import { createClient } from "genlayer-js";
import { privateKeyToAccount } from "viem/accounts";
import { localnet } from "genlayer-js/chains";
import * as fs from "fs";
import * as path from "path";

const D = __dirname;
const ROOT = path.resolve(D, "../../../../../../../F:/Work/Cryoto/Genlayer");

function loadEnv() {
  const p = path.join(D, "..", ".env");
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
}
loadEnv();

const RPC = process.env.GENLAYER_RPC_URL!;
const account = privateKeyToAccount(
  (process.env.PRIVATE_KEY!.startsWith("0x") ? process.env.PRIVATE_KEY! : `0x${process.env.PRIVATE_KEY}`) as `0x${string}`
);
const client = createClient({ chain: { ...localnet, id: 61999 } as any, endpoint: RPC, account });

const TX = ["UNINITIALIZED","PENDING","PROPOSING","COMMITTING","REVEALING","ACCEPTED",
  "UNDETERMINED","FINALIZED","CANCELED","APPEAL_REVEALING","APPEAL_COMMITTING",
  "READY_TO_FINALIZE","VALIDATORS_TIMEOUT","LEADER_TIMEOUT"];
const OK = new Set(["ACCEPTED", "FINALIZED"]);
const BAD = new Set(["UNDETERMINED", "CANCELED", "VALIDATORS_TIMEOUT", "LEADER_TIMEOUT"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function nonce() {
  const r = await fetch(RPC, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getTransactionCount", params: [account.address, "latest"], id: 1 }),
  });
  return parseInt(((await r.json()) as any).result, 16);
}

async function deploy(file: string, args: any[]): Promise<string> {
  const code = fs.readFileSync(path.join(D, file), "utf-8").replace(/\r\n/g, "\n");
  const hash = await client.deployContract({
    code, args, nonce: await nonce(), gas: 20000000n,
    maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 1000000000n,
  } as any);
  for (let i = 0; i < 40; i++) {
    await sleep(5000);
    const r = await fetch(RPC, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getTransactionReceipt", params: [hash], id: 1 }),
    });
    const d: any = await r.json();
    if (d?.result?.status === "0x1") {
      const addr = d.result.contract_address || d.result.to;
      for (let j = 0; j < 12; j++) {
        try {
          await client.readContract({ address: addr, functionName: args.length ? "get_note" : "get_ledger", args: [] } as any);
          return addr;
        } catch (e) { await sleep(5000); }
      }
      return addr;
    }
  }
  throw new Error(`${file} did not deploy`);
}

async function send(address: string, fn: string, args: any[] = []) {
  const hash = await client.writeContract({ address, functionName: fn, args, value: 0n } as any);
  process.stdout.write(`   ${fn} tx ${hash.slice(0, 10)}… `);
  for (let i = 0; i < 30; i++) {
    await sleep(20000);
    const tx: any = await client.getTransaction({ hash });
    const cd = tx.consensus_data;
    const lr = Array.isArray(cd?.leader_receipt) ? cd.leader_receipt[0] : cd?.leader_receipt;
    if (lr?.execution_result === "ERROR") {
      const trace = (lr.genvm_result?.stderr || "").trim().split("\n").filter(Boolean).slice(-2).join(" | ");
      process.stdout.write("REVERTED\n");
      return { ok: false, error: `${JSON.stringify(lr.result?.payload ?? lr.result)} ${trace}` };
    }
    const name = typeof tx.status === "number" ? TX[tx.status] ?? String(tx.status) : String(tx.status);
    if (BAD.has(name)) { process.stdout.write(`${name}\n`); return { ok: false, error: name }; }
    if (OK.has(name)) { process.stdout.write(`${name}\n`); return { ok: true }; }
  }
  return { ok: false, error: "no consensus" };
}

async function main() {
  console.log("🔬 Probing gl.ContractAt — can one contract call another?\n");

  console.log("1. Deploying the vault probe");
  const vault = await deploy("probe_vault.py", []);
  console.log(`   vault  = ${vault}`);

  console.log("2. Deploying the caller probe, pointed at it");
  const caller = await deploy("probe_caller.py", [vault]);
  console.log(`   caller = ${caller}\n`);

  const target = "0x000000000000000000000000000000000000dEaD";

  console.log("3. Cross-contract WRITE: caller.push_credit -> vault.credit");
  const w = await send(caller, "push_credit", [target, 500]);
  if (!w.ok) {
    console.log(`   ✗ FAILED: ${w.error}\n`);
  } else {
    const led = await client.readContract({ address: vault, functionName: "get_ledger", args: [] } as any);
    const seen = await client.readContract({ address: vault, functionName: "get_last_caller", args: [] } as any);
    console.log(`   vault ledger      : ${led}`);
    console.log(`   vault saw sender  : ${seen}`);
    console.log(`   caller address    : ${caller.toLowerCase()}`);
    console.log(`   wallet address    : ${account.address.toLowerCase()}`);
    const mutated = String(led).includes("500");
    console.log(`   → state mutated   : ${mutated ? "YES" : "NO"}`);
    if (mutated) {
      const who = String(seen).toLowerCase() === caller.toLowerCase() ? "the CALLING CONTRACT"
        : String(seen).toLowerCase() === account.address.toLowerCase() ? "the ORIGINAL WALLET" : "something else";
      console.log(`   → callee sees     : ${who}`);
    }
  }

  console.log("\n4. Cross-contract READ from a view method");
  try {
    const r = await client.readContract({ address: caller, functionName: "read_vault_balance", args: [target] } as any);
    console.log(`   ✓ caller read vault balance = ${r}`);
  } catch (e: any) {
    console.log(`   ✗ FAILED: ${String(e.message).split("\n")[0]}`);
  }

  console.log(`\nvault=${vault}\ncaller=${caller}`);
}

main().catch((e) => { console.error("probe failed:", e.message ?? e); process.exit(1); });
