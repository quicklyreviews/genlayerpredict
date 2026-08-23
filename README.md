# 📈 GenPerp

A **multi-asset leveraged perpetual-futures exchange** built on **GenLayer** — the AI-powered blockchain.

GenPerp lets anyone open a leveraged **LONG** or **SHORT** on BTC, ETH, or SOL (or any market the admin registers), against a shared on-chain vault, with live PnL, permissionless liquidations, and real long/short funding payments — all powered by GenLayer's **Intelligent Contracts** and **Equivalence Principle**, with **no Chainlink or third-party oracle**.

> This repo previously hosted **Gen Predict**, a simple BTC Up/Down prediction round. That contract (`contracts/btc_updown_market.py`) is kept for reference under [Legacy](#-legacy-gen-predict), but GenPerp is now the primary project.

---

## 🧠 Why live web prices via GenLayer, not Chainlink

GenLayer's whole pitch is *"no oracles, no intermediaries."* Every price-dependent call in the contract fetches the live USD price itself with `gl.nondet.web.get()`, and validators independently re-fetch it and reach consensus through the **Equivalence Principle**. Chainlink is an EVM oracle model that would require deploying and bridging a separate consumer contract on another chain — undocumented on GenLayer and contrary to the platform's design, so every trade, close, liquidation, and funding settlement in GenPerp resolves its price the native way instead.

The contract tries **Binance → CoinGecko → Coinbase** in order. One source is not survivable: every validator fetches independently, so under load some get rate-limited — and a throttled CoinGecko request answers `200` with an error body, which reverted trades outright before the fallback chain existed. Because the leader and a validator can land on different exchanges, the agreement band is **0.5%** rather than the 0.2% a single source needs. Measured live, the three sources sit within ~0.02% of each other across BTC/ETH/SOL — comfortably inside the band, and still far tighter than any move that would matter for margin.

## 🎮 How It Works

```text
open_position(symbol, LONG|SHORT, leverage)  ──▶  margin posted, live entry price fetched,
                                                    liq. price estimated, notional = margin × leverage

close_position(id)      any time, live price fetched  ──▶  payout = margin ± PnL, vault settles
liquidate_position(id)  anyone, any time               ──▶  if equity ≤ maintenance margin,
                                                              liquidator earns a bounty
settle_funding(symbol)  anyone, once per interval       ──▶  longs/shorts pay each other based
                                                              on open-interest skew
```

1. **Open** — pick a market, direction, leverage (1x up to the market's cap), and margin amount (GEN). The contract fetches the live price via consensus and stores your entry price, notional size, and an estimated liquidation price.
2. **Hold** — PnL is computed as `notional × %price-move` (a documented simplification: the margin token doubles as the quote currency, so no separate USD conversion is needed — see the contract docstring). A keeper refreshes the cached mark price regularly so the UI shows live unrealized PnL.
3. **Funding** — every `funding_interval_seconds`, longs and shorts pay each other proportional to the long/short open-interest imbalance, pushing skewed markets back toward balance — exactly like a real perpetual swap.
4. **Close** — call `close_position` any time to realize PnL and get your margin back (± PnL), paid out of the vault.
5. **Liquidate** — if your equity drops to the market's maintenance margin, *anyone* can call `liquidate_position` and earn a small bounty. This replaces a centralized liquidation engine.

## 🛠 Fully Configurable Markets

Nothing is hardcoded to BTC or to one round length. The owner can register or update any market with:

| Parameter | What it controls |
|---|---|
| `coingecko_id` | Which CoinGecko asset this market prices |
| `max_leverage` | Cap on leverage traders can choose (1–125x) |
| `maintenance_margin_bps` | How much equity buffer before liquidation |
| `taker_fee_bps` | Fee taken from margin on open |
| `funding_interval_seconds` | How often funding settles |
| `funding_k_bps` | Max funding rate per interval at full skew |
| `min_margin` | Minimum GEN margin to open a position |

BTC, ETH, and SOL ship pre-registered; add more with `add_market(...)`.

## ⚠️ GenVM gotchas found the hard way

Three constraints cost real deploys while building this — they are enforced by GenVM but not spelled out in the docs:

1. **The runner comment is positional.** Line 1 must *start* with a version token (`# v1.0.0 — ...`), the `{ "Depends": ... }` line must be line 2, and **no comment may follow it** before the code. Break any of these and deployment fails with a bare `invalid_contract` (or `invalid_contract absent_runner_comment`).
2. **`float` is not calldata-encodable.** Any value crossing the nondeterministic boundary (what `leader_fn` returns) or returned from a public method is calldata-encoded, and the codec has no float type. Returning one aborts the transaction with `not calldata encodable 76744.0: float`. Return strings and parse them Python-side — that's why `_fetch_price`'s `leader_fn` returns `str`, and why `roi_pct` and `enabled` are `str`/`int`.
3. **An EVM receipt of `0x1` does not mean the contract deployed.** GenVM can reject the code while the outer transaction still succeeds and burns the fee, leaving nothing at the address. `deploy/deployPerpScript.ts` therefore validates the schema via `gen_getContractSchemaForCode` *before* sending, and calls a view method *after* to confirm the contract is live.

Validate any contract change before spending gas:
```bash
npm run deploy
```

## 📁 Project Structure

```text
├── contracts/
│   ├── perp_exchange.py        # GenPerp Intelligent Contract (current)
│   ├── btc_updown_market.py    # Legacy Gen Predict contract
│   └── btc_prediction.py       # Legacy example IC with consensus tolerance
├── frontend/
│   ├── index.html              # Trading terminal UI (Tailwind CSS)
│   └── app.js                  # Frontend logic (GenLayer JS SDK)
├── deploy/
│   ├── deployPerpScript.ts     # Deploys perp_exchange.py
│   └── deployScript.ts         # Legacy deploy script
├── scripts/
│   ├── backend-proxy.js        # Read proxy + keeper bot (Render web service)
│   ├── perp-keeper.ts          # Standalone keeper (price refresh/liquidate/funding)
│   ├── perp-smoke-test.ts      # End-to-end lifecycle test against a live node
│   ├── fund-vault.ts           # One-off vault funding helper
│   └── build.js                # Injects BACKEND_URL into frontend at build time
├── vercel.json                 # Vercel deployment configuration
└── package.json
```

## 🚀 Deployment Guide

### 1. Deploy the contract
```bash
npm install
cp .env.example .env   # fill in PRIVATE_KEY, GENLAYER_RPC_URL
npm run deploy          # runs deploy/deployPerpScript.ts
```
Copy the printed `CONTRACT_ADDRESS` into `.env`, then seed the vault so it can pay winning traders:
```bash
npm run fund-vault -- 50
```

### 2. Backend & Keeper (Render)
`scripts/backend-proxy.js` serves as a read-only RPC proxy for the frontend **and** runs the keeper loop (price refresh, liquidations, funding settlement).
- Host on **Render** as a **Web Service**.
- **Build Command**: `npm install`
- **Start Command**: `npm run backend`
- **Environment Variables**: `PRIVATE_KEY`, `CONTRACT_ADDRESS`, `GENLAYER_RPC_URL`, `KEEPER_INTERVAL_MS` (optional).

> Trading itself (`open_position`, `close_position`, `fund_vault`) is always signed by the **user's own wallet** in the browser — the backend never spends on a trader's behalf. Its private key is only used for the permissionless keeper actions, and an explicit allowlist rejects anything else.

**RPC budget matters.** GenLayer Studio allows roughly **30 requests per minute**, shared by every browser tab and the keeper — enough to break reads outright if you ignore it. Three things keep the system inside it:
- the backend caches reads (10s TTL, 2min for market configs), so extra browser tabs cost nothing;
- the keeper skips any market with no open positions — an idle market costs one cached read per sweep instead of a transaction;
- the frontend reloads market configs every 10th poll rather than every poll.

`KEEPER_INTERVAL_MS` (default 60s) is a direct gas cost: each sweep sends one `touch_price` transaction per market that has open positions.

### 3. Frontend (Vercel)
- Host on **Vercel** as a new Project. `vercel.json` sets `"outputDirectory": "frontend"`.
- **Environment Variables**: `BACKEND_URL` → your deployed Render URL.
- `npm run build` injects `BACKEND_URL` into `app.js` at deploy time.

## 🛠 Local Development

### Prerequisites
- [GenLayer Simulator](https://docs.genlayer.com/) running locally (`genlayer up`), or use GenLayer Studio
- Node.js 18+

### Setup
```bash
npm install
cp .env.example .env        # fill in PRIVATE_KEY, GENLAYER_RPC_URL
npm run deploy               # deploy perp_exchange.py, note CONTRACT_ADDRESS
npm run fund-vault -- 50     # seed the vault
npm run backend               # RPC proxy + keeper on http://localhost:3005
```
Then open `frontend/index.html` (Live Server or any static server) with `CONTRACT_ADDRESS` set via the ⚙ config modal if it isn't picked up from the backend automatically.

Admin-only calls (`add_market`, `set_market_enabled`, `withdraw_vault`, `set_liquidation_bounty_bps`, `transfer_ownership`) can be sent with any GenLayer JS/TS script using the deployer's wallet — there's no separate admin UI yet.

## 🧪 Contract Interface (quick reference)

**Trading (payable where noted):**
`open_position(symbol, direction, leverage)` *payable* · `close_position(id)` · `liquidate_position(id)` · `settle_funding(symbol)` · `touch_price(symbol)`

**Admin:**
`add_market(...)` · `set_market_enabled(symbol, enabled)` · `set_liquidation_bounty_bps(bps)` · `transfer_ownership(addr)` · `fund_vault()` *payable* · `withdraw_vault(amount)`

**Views:**
`get_market(symbol)` · `get_all_markets()` · `get_position(id)` · `get_user_positions(addr)` · `get_all_open_positions()` · `get_open_positions_for_symbol(symbol)` · `get_open_interest(symbol)` · `get_vault_status()` · `get_mark_price(symbol)` · `get_funding_info(symbol)` · `estimate_position(id)`

---

## 🗄 Legacy: Gen Predict

The original BTC Up/Down parimutuel prediction round (`contracts/btc_updown_market.py`, `scripts/round-cron.ts`) is left in the repo for reference. It used 1–2 minute rounds where players bet UP/DOWN and split the losing pool — see its inline docstrings for details. It is no longer the deployed/maintained product.

## 👨‍💻 Author
Created by [@trungkts29](https://x.com/trungkts29)

## 📄 License
MIT
