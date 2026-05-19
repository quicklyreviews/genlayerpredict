import { createClient } from "genlayer-js";
import { localnet } from "genlayer-js/chains";

async function getTx() {
  const client = createClient({
    chain: localnet,
    endpoint: "https://studio.genlayer.com/api"
  });

  const tx = await client.getTransaction({ hash: "0xe7df381b830aaf520f753d70e0b5571d80de8cb6f217145fc5fe5d7b203e60a9" });
  console.log(JSON.stringify(tx, null, 2));
}

getTx();
