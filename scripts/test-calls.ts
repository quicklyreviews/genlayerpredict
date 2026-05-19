import { createClient } from "genlayer-js";
import { privateKeyToAccount } from "viem/accounts";
import { localnet } from "genlayer-js/chains";

async function testCalls() {
  const account = privateKeyToAccount(`0x5b651aa4ebedc9e472dc9824879d9a202ee9381332eee02c8cd1c3ed22e38162`);
  const client = createClient({ chain: localnet, endpoint: "https://studio.genlayer.com/api", account });
  const txReceipt = await client.waitForTransactionReceipt({ hash: "0xacac7a36ae6ae42f339d18210f1c5b5347fe17dd947404ed53c167dd3f9eb09e", status: "FINALIZED" });
  const contract = txReceipt.recipient;
  
  for (const fn of ["pay1", "pay2", "pay3"]) {
    console.log(`Calling ${fn}...`);
    try {
      const tx = await client.writeContract({ address: contract, functionName: fn, args: [], value: 100n });
      console.log(`TX ${fn}: ${tx}`);
      const r = await client.waitForTransactionReceipt({ hash: tx, status: "FINALIZED" });
      const full = await client.getTransaction({ hash: tx });
      console.log(`Result ${fn}:`, full.data?.error || "Success");
    } catch(e) { console.error(`Err ${fn}:`, e.message); }
  }
}
testCalls();
