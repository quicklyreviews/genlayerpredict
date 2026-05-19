import { createClient } from "genlayer-js";
import { localnet } from "genlayer-js/chains";

async function getError() {
  const client = createClient({ chain: localnet, endpoint: "https://studio.genlayer.com/api" });
  const tx = await client.getTransaction({hash:'0x05a60708c6208cc7d2db45d3919caa87a2c5c136cbf9193deaabc292bb44b894'});
  for (const v of tx.consensus_data?.validators || []) {
      if (v.execution_result === "ERROR") {
          console.log(v.stderr || v.result || "No stderr/result");
          break;
      }
  }
}
getError();
