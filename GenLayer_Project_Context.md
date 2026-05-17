# GenLayer Project Context

## Overview
This project involves developing and deploying an **Intelligent Contract** on the GenLayer network using Python and the `genlayer-js` TypeScript SDK. The main contract being developed is a **BTC Up/Down Prediction Market** (`contracts/btc_updown_market.py`).

## Key Technologies
- **GenVM & Intelligent Contracts**: Python-based contracts using the `gl.Contract` interface.
- **GenLayer SDKs**: Using `genlayer-js` (`npm` package) to interact with the GenLayer RPC and deploy contracts.
- **GenLayer Localnet**: A Docker-based development environment running local validators, json-rpc (`genlayer-jsonrpc-1`), and a hardhat node (`genlayer-hardhat-1`).

## Contract Development Status
- Refactored `btc_updown_market.py` to use `gl.ContractState` and strict consensus mechanisms (`gl.eq_principle.strict_eq`) since GenLayer does not support standard dicts for consensus data.
- Addressed non-deterministic API fetch requirements using the equivalence principle to ensure validators reach consensus on the BTC price.

## Current Debugging Context (CRITICAL)
If you are picking up this task, here is the current state of the debugging process:

1. **Deployment Failures**: We were repeatedly encountering `Error: Transaction reverted without a reason string` from the `ConsensusMain#addTransaction` endpoint during `deployScript.ts` execution.
2. **Root Cause Discovered - Out of Gas**:
   - The contract deployment (which sends the entire Python source code as `calldata`) was consuming roughly ~2.96 million gas.
   - The `genlayer-js` SDK internally falls back to a hardcoded gas limit of **500,000** (or whatever its internal estimation clamps to), which was completely ignoring the `gas` arguments passed to `deployContract`.
3. **Workarounds Applied**:
   - We monkey-patched `node_modules/genlayer-js/dist/index.js` (and its `.cjs`/`.mjs` variants) directly.
   - We replaced the fallback `500000n` / `3000000n` gas limits with **`20000000n`** (20 million) and updated the hexadecimal representations to ensure the inner transaction has enough gas to execute `createGhost` on the chain layer.
4. **Current Status**:
   - We just dispatched a new deployment transaction with the 20M gas limit via `npx tsx deploy/deployScript.ts`.

## Next Steps for Agents
1. Wait for the `deployScript.ts` to finish or check the JSON-RPC Docker logs (`docker logs --tail 50 genlayer-jsonrpc-1`).
2. If the deployment succeeds, move on to validating the game functions (`start_round`, `place_bet`).
3. If it reverts again, consider extracting the raw transaction via `viem` or `ethers` and tracing it (`debug_traceTransaction`) directly on the Hardhat container (`http://localhost:8545`) to see if there is another underlying VM error (e.g., maximum code size exceeded).
4. Do NOT try to modify `deployScript.ts` gas parameters—it won't affect `genlayer-js`. Instead, modify the `node_modules` code or switch to using native `ethers.js`/`web3` scripts interacting with `ConsensusMain` directly.
