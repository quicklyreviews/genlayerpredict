import { createClient } from "genlayer-js";
import { localnet } from "genlayer-js/chains";

async function getError() {
  const client = createClient({ chain: localnet, endpoint: "https://studio.genlayer.com/api" });
  const tx = await client.getTransaction({hash:'0x9e00edff18e43c115137faabe4016910af6693738d5700b5f0aedaeaafc6614c'});
  for (const v of tx.consensus_data?.validators || []) {
      if (v.execution_result === "ERROR") {
          console.log(v.stderr || v.result || "No stderr/result");
          break;
      }
  }
}
getError();
