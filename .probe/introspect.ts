import { createClient } from "genlayer-js";
import { privateKeyToAccount } from "viem/accounts";
import { localnet } from "genlayer-js/chains";
import * as fs from "fs";
import * as path from "path";

for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf-8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i === -1) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}
const RPC = process.env.GENLAYER_RPC_URL!;
const account = privateKeyToAccount((process.env.PRIVATE_KEY!.startsWith("0x") ? process.env.PRIVATE_KEY! : `0x${process.env.PRIVATE_KEY}`) as `0x${string}`);
const client = createClient({ chain: { ...localnet, id: 61999 } as any, endpoint: RPC, account });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const code = fs.readFileSync(path.join(__dirname, "probe_introspect.py"), "utf-8").replace(/\r\n/g, "\n");
  const nr = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getTransactionCount", params: [account.address, "latest"], id: 1 }) });
  const nonce = parseInt(((await nr.json()) as any).result, 16);
  const hash = await client.deployContract({ code, args: [], nonce, gas: 20000000n,
    maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 1000000000n } as any);
  let addr = "";
  for (let i = 0; i < 40; i++) {
    await sleep(5000);
    const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getTransactionReceipt", params: [hash], id: 1 }) });
    const d: any = await r.json();
    if (d?.result?.status === "0x1") { addr = d.result.contract_address || d.result.to; break; }
  }
  console.log("introspect contract:", addr);
  for (let i = 0; i < 12; i++) {
    try {
      const gl = JSON.parse((await client.readContract({ address: addr, functionName: "gl_attrs", args: [] } as any)) as any);
      const evm = await client.readContract({ address: addr, functionName: "evm_attrs", args: [] } as any);
      console.log("\ngl.* exposes:\n  " + gl.join(", "));
      console.log("\ngl.evm.* exposes:\n  " + evm);
      const candidates = gl.filter((a: string) => /contract|call|at|proxy|invoke/i.test(a));
      console.log("\ncross-contract candidates:", candidates.length ? candidates.join(", ") : "(none)");
      return;
    } catch (e) { await sleep(5000); }
  }
  console.log("could not read the contract");
})();
