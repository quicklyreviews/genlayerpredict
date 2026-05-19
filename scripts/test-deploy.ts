import { createClient } from "genlayer-js";
import { privateKeyToAccount } from "viem/accounts";
import { localnet } from "genlayer-js/chains";
import * as fs from "fs";

async function testDeploy() {
  const account = privateKeyToAccount(`0x5b651aa4ebedc9e472dc9824879d9a202ee9381332eee02c8cd1c3ed22e38162`);
  const client = createClient({ chain: localnet, endpoint: "https://studio.genlayer.com/api", account });
  
  const code = fs.readFileSync("contracts/test_payable.py", "utf-8");
  try {
    const tx = await client.deployContract({ code, args: [] });
    console.log("Deployed:", tx);
  } catch(e) {
    console.error("Deploy failed:", e);
  }
}
testDeploy();
