import { createClient } from "genlayer-js";
import { privateKeyToAccount } from "viem/accounts";
import { localnet } from "genlayer-js/chains";

async function testCall() {
  const account = privateKeyToAccount(`0x5b651aa4ebedc9e472dc9824879d9a202ee9381332eee02c8cd1c3ed22e38162`);
  const client = createClient({ chain: localnet, endpoint: "https://studio.genlayer.com/api", account });
  
  const contract = "0x9a5d0A2164b8ceb38EFBfF422e618eDbCde9b070";
  console.log(`Calling bet_up on ${contract}...`);
  try {
    const tx = await client.writeContract({ address: contract, functionName: "bet_up", args: [], value: 100n });
    console.log(`TX: ${tx}`);
    const r = await client.waitForTransactionReceipt({ hash: tx, status: "FINALIZED" });
    const full = await client.getTransaction({ hash: tx });
    console.log(`Result:`, full.data?.error || "Success");
  } catch(e) { console.error(`Err:`, e.message); }
}
testCall();
