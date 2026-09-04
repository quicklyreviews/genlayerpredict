# 📈 GenPredict

Two crypto trading products on **GenLayer** — the AI-powered blockchain — sharing one frontend and one price engine:

- **GenPredict** (main) — short-horizon **up or down** prediction markets across eight coins. Pick a coin and a horizon (5m, 15m, 1h), back UP or DOWN, and winners split the pool. Parimutuel, like PancakeSwap Prediction, with a market list modelled on Polymarket.
- **GenPerp** — a multi-asset **leveraged perpetual-futures** exchange with live PnL, permissionless liquidations, and long/short funding.

Both fetch prices with GenLayer's **Intelligent Contracts** and **Equivalence Principle** — **no Chainlink, no oracle, no admin price input**.

## Live deployment

Studionet (chain 61999). Verified end to end on the addresses below.

| | |
|---|---|
| Prediction market | `0x1c06C78ed6b17e4126f11b9d5361EE886F1e2D11` |
| Perp exchange | `0x91Eee37BeDAfcF15a64a53F93236Cec84AF3a7B8` |
| House backstop | 5 GEN funded, 0.25 GEN cap per round |

Run it:

```bash
npm run backend                 # terminal 1 — read proxy + both keepers
npx serve frontend -l 5173      # terminal 2 — the UI
```

Then open http://localhost:5173. Closing terminal 1 stops the rounds; restarting
it catches up on everything outstanding.

Prove it works against the real chain — deposit, bet, settle, collect, withdraw,
and a solvency reconciliation, about ten minutes:

```bash
npm run smoke
```

Most recent run: a lone 0.2 GEN bet on BTC-5m, the house took the empty DOWN side,
the round settled PAID at $78,391 → $78,606, and 0.2 staked returned 0.388 — 1.94x.
Collecting twice was rejected, and holdings reconciled with debts.

## Publishing it

Two pieces. The frontend is static files; the backend is a Node process that holds
a key, runs the keepers and proxies reads.

**1. Backend** — any host that runs Node. `render.yaml` is a Render blueprint: point
Render at this repository as a Blueprint and the service is created with the start
command, health check and every address already filled in. It asks only for
`PRIVATE_KEY`, which is deliberately not in the repository.

On any other host, the start command is `npm run backend` and these are the
environment variables:

| | |
|---|---|
| `PRIVATE_KEY` | keeper wallet — needs GEN for gas, and owns the contract |
| `PREDICT_CONTRACT_ADDRESS` | current prediction contract |
| `CONTRACT_ADDRESS` | perp exchange |
| `PREDICT_LEGACY_ADDRESSES` | superseded contracts, comma separated, so players can recover balances left in them |
| `PORT` | provided by the host |

It already sends `Access-Control-Allow-Origin: *`, so the frontend can live on a
different domain.

**2. Frontend** — any static host. `vercel.json` points Vercel at `frontend/`.
Set one environment variable on the host and the build writes the config for you:

| | |
|---|---|
| `BACKEND_URL` | the backend's public URL, e.g. `https://genpredict-api.onrender.com` |

`npm run build` turns that into `frontend/backend.json`, so the URL never has to be
committed and one commit can deploy against different backends. Editing that file
by hand works too, for a host with no build step.

Leave it empty and the page falls back to `http://localhost:3005` when served from
localhost, or to its own origin otherwise — which is right only if the backend is
proxied under the same domain. Getting this wrong is the classic failure: a
hard-coded localhost ships a site that asks every visitor's own machine for the
API, and works on exactly one computer.

**Do not publish `.env`.** It holds the keeper's private key. The host's
environment variables are the only place it belongs.

> The keeper must keep running or rounds never lock or settle. A host that sleeps
> idle instances — Render's free plan among them — stalls the markets until a
> request wakes it, so rounds settle late rather than on time.

**If `/api/predict/call` returns 500**, read the body: it says which variable is
missing. An empty `predictAddress` in `/api/config` means `PREDICT_CONTRACT_ADDRESS`
never reached the host, and every prediction read fails until it does.

| Page | What it is |
|---|---|
| `index.html` | Market list — filter by horizon and coin, live countdowns and odds |
| `market.html?m=BTC-5m` | One market — LIVE/NEXT round cards, chart, betting panel, results |
| `portfolio.html` | Your history — every round joined, how it ended, what is still uncollected |
| `pool.html` | Earn — supply GEN to either pool at 10% a year, counted per second |
| `perp.html` | The leveraged perp terminal |

> **Chỉ muốn dùng thử?** Đọc [HUONG-DAN.md](HUONG-DAN.md) — hướng dẫn tiếng Việt,
> từ cài đặt tới cách chơi, cách tính thắng thua và xử lý lỗi thường gặp.
> This README is the engineering reference; that file is the user guide.

---

## 🧠 Why live web prices via GenLayer, not Chainlink

GenLayer's whole pitch is *"no oracles, no intermediaries."* Every price-dependent call in the contract fetches the live USD price itself with `gl.nondet.web.get()`, and validators independently re-fetch it and reach consensus through the **Equivalence Principle**. Chainlink is an EVM oracle model that would require deploying and bridging a separate consumer contract on another chain — undocumented on GenLayer and contrary to the platform's design, so every trade, close, liquidation, and funding settlement in GenPerp resolves its price the native way instead.

The contract tries **Binance → CoinGecko → Coinbase** in order. One source is not survivable: every validator fetches independently, so under load some get rate-limited — and a throttled CoinGecko request answers `200` with an error body, which reverted trades outright before the fallback chain existed. Because the leader and a validator can land on different exchanges, the agreement band is **0.5%** rather than the 0.2% a single source needs. Measured live, the three sources sit within ~0.02% of each other across BTC/ETH/SOL — comfortably inside the band, and still far tighter than any move that would matter for margin.

## 🔮 How GenPredict works

A market is one (asset, horizon) pair — `BTC-5m`, `ETH-15m`. Each runs a continuous chain of rounds, with **two active at once** so there is never dead time:

```text
NEXT  (OPEN)   ── accepting bets, no price fixed yet
LIVE  (LOCKED) ── lock price fixed, counting down to settlement

start ──betting window──▶ lock ──horizon──▶ close
      bets accepted       lock_price       close_price
```

The moment a round locks, the following round opens for betting — so you can always place the next bet while the current one plays out. UP wins if `close > lock`, DOWN if `close < lock`.

**Funding is mandatory and works like an exchange account.** You deposit GEN once, and
your wallet address *is* your account number — attributable without anyone taking custody,
since only the wallet that owns a balance can move it and no operator key can spend it.
Bets are staked from that balance, and **winnings are collected with a transaction you
sign**. This went back and forth. Crediting automatically at settlement is friendlier —
on a chain that needs a minute to agree on anything, a second transaction to collect
money you already won is the worst part of playing — but it makes a win something that
happens to you rather than something you take, and the product owner asked for the
explicit step. Two things blunt the cost: `claim_all()` settles every outstanding win in
one transaction, and `_prune()` refuses to drop a round that still holds an uncollected
win, however old, so nothing is stranded by not coming back.

**Payouts are parimutuel.** The whole pool minus a 3% fee is split across the winning side in proportion to stake, so the multiplier is only final once betting closes and moves as pools fill — exactly like PancakeSwap Prediction. The UI shows a live estimate and says plainly that it is an estimate.

**Rounds are refunded in full, with no fee, when there is no real contest**: an exact price tie, or one side attracting no bets at all. That second case matters — with an empty losing side there is no counterparty to win from, so charging a fee would take money for nothing; with an empty *winning* side nobody could ever claim, which would strand the pool in the contract permanently.

### UX decisions worth keeping

- **Betting closes early, on purpose.** GenLayer needs roughly a minute to reach consensus, so the UI stops accepting bets `CONSENSUS_BUFFER_SECONDS` (45s) before the lock and says why. Letting someone pay gas for a bet that cannot land is worse than telling them no.
- **The badge and the numbers always describe the same round.** While betting is open a card shows the next round; once it closes the card switches to the live round, whose pool is the money actually at stake. Showing "LIVE" above an empty next-round pool reads as broken.
- **Multipliers live on the UP/DOWN buttons**, the way PancakeSwap does it, so the risk/reward is visible at the moment of choosing rather than one screen later.
- **The stake field never loses focus.** Countdowns tick every second, but the panel only rebuilds when its structure changes — otherwise typing an amount would reset the caret each second.

## 🎮 How GenPerp works

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

Ten prediction markets ship pre-registered — BTC/ETH/SOL at 5m, BTC/ETH at 15m, and
BNB/LINK/DOGE/SHIB/PEPE hourly — alongside eight perp markets whose leverage caps scale
with volatility (20x for majors down to 5x for memecoins, where a routine 10% candle
would otherwise wipe out a position before a keeper could liquidate it). Add more with
`add_market(...)`, but read the RPC budget section first: each new short-horizon market
has a real, measurable cost.

## 🐛 Bugs the smoke tests caught

Each of these was found by running the thing on-chain, not by reading the code:

1. **Stranded funds on a one-sided round.** If everyone backed UP and DOWN won, the winning pool was zero: nobody could claim, no fee was taken, and the entire pool sat in the contract permanently. Rounds with an empty side (or an exact price tie) now settle as `VOID` and refund every stake in full. Proven live — a 1 GEN bet on UP lost on direction, and was refunded because no one took the other side.
2. **A multiplier that could never be paid.** While one side was empty the card advertised `0.97x`, derived from the parimutuel formula with the fee applied. The round would actually refund at `1.00x`. The contract now reports the honest figure and the betting panel explains that a round with no counterparty is void.
3. **A keeper that could wedge itself forever.** Sweeps were serialised to avoid double-sending, but RPC calls had no timeout — so a single hung request stalled every market permanently. It happened during a network blip and rounds stopped advancing. All keeper calls are now bounded, with an overrun escape hatch.
4. **Hidden in-flight rounds.** Because the horizon outlasts the betting window, two rounds are normally locked at once, but the contract only tracked the most recent — hiding a round the user had money in. `get_market_detail` now returns every locked round.
5. **A card that contradicted itself.** A market showing `LIVE` alongside an empty pool reads as broken: the badge described the live round while the numbers came from the next one. Badge and numbers now always describe the same round.

## 🏦 The liquidity pool

Anyone may stake GEN into either contract and earn **10% a year**, accruing per second,
withdrawable together with the principal at any moment. No lock-up, no epochs, no
minimum.

```bash
stake()                 # payable — supply GEN
unstake(amount)         # principal + the interest it earned
claim_interest()        # interest only, leave the principal working
fund_rewards()          # payable — top up the subsidy that pays the yield
get_stake(addr)         # your position, interest counted to this second
get_pool()              # pool health, including how long the subsidy lasts
```

### Where the yield comes from, honestly

**It is a subsidy, not revenue.** Interest is paid from `rewards_pool`, which the owner
funds deliberately with `fund_rewards()`. Trading fees do not fund it and the contract
does not pretend they do.

That matters because a fixed APY on an open-ended deposit base is a promise something
has to keep. Rather than let it fail quietly, the contract publishes
`runway_seconds` — at the current stake size and rate, how long the subsidy lasts — and
when it does run out, `unstake` returns the principal **in full**, pays the interest as
far as the subsidy stretches, and reports `interest_unpaid` instead of issuing an IOU it
cannot honour. The unpaid remainder stays on the books, so a later top-up settles it.

Interest accrues per second and is calculated only when an account is touched, so there
is no keeper loop and no transaction cost to earning it. It is simple interest on the
principal, not compounding: compounding needs either a global index or repeated
settlement, and neither earns its complexity at these amounts.

### The two pools are not the same

| | GenPredict | GenPerp |
|---|---|---|
| What staked capital does | **Nothing.** | **Backs trader PnL.** |
| Why | Parimutuel — players win from each other, so the contract never needs outside capital to pay a winner | The exchange is the counterparty, so profit is paid out of the vault |
| Risk to principal | None from trading | **Real** — if traders win more than fees take in, the vault shrinks |
| Withdrawal limit | Your principal | Capped by free liquidity: margin backing open positions belongs to traders |

Staking into GenPredict is therefore a pure yield position. Staking into GenPerp is
taking the other side of the traders, which is what the yield is compensating for — and
why `get_stake` there also reports `withdrawable_now`, which can be less than your
principal while positions are open.

## 🌐 Studionet only

Everything targets **GenLayer Studionet (chain 61999)** and nothing else. `scripts/chain.js`
is the single place that decides this: it exports the real `studionet` config from
genlayer-js and refuses an RPC pointing anywhere but Studionet (a localhost simulator is
also accepted).

This replaced `{ ...localnet, id: 61999 }` copied across nine files — localnet's config
with Studionet's chain id bolted on. It worked by coincidence, and it meant an RPC aimed
at another network would have been trusted without question, transacting against
whatever contract happened to sit at the same address.

## ⚖️ How a round is decided

The whole question is: *who decided the price, and can they be argued with?* On this
exchange nobody decides it. There is no oracle, no admin key that can post a number,
and no off-chain service whose word is taken. The price is fetched by the validators
themselves, and a round only settles if enough of them independently agree.

### The two prices that matter

A round fixes exactly two numbers, each written by its own on-chain transaction:

```text
lock_round()      →  lock_price     the price when betting closed
   ⋯ horizon ⋯
resolve_round()   →  close_price    the price when the horizon elapsed

close_price >  lock_price   →  UP wins
close_price <  lock_price   →  DOWN wins
close_price == lock_price   →  void, everyone refunded in full
```

Nothing else enters the decision. Not volume, not who bet, not what the pools look
like — just two timestamps and the prices at them.

### Where each price comes from

Inside `lock_round` and `resolve_round`, the contract runs a **non-deterministic
block**: code that reaches out to the live web. Every validator executes it
independently, each making its own HTTP request:

```python
def leader_fn() -> str:
    # Binance first, then CoinGecko, then Coinbase.
    response = gl.nondet.web.get(url)
    return str(float(json.loads(response.body)[...]))
```

The leader's answer is proposed, and every other validator runs the same function and
compares. This is GenLayer's **Equivalence Principle**: the network does not need
identical results, it needs results that agree within a stated tolerance.

```python
def validator_fn(leader_result) -> bool:
    leader_price = float(leader_result.calldata)
    validator_price = float(leader_fn())
    return abs(leader_price - validator_price) / abs(leader_price) <= 0.005
```

**0.5%** is the agreement band. It has to be wider than zero because validators fetch
at slightly different milliseconds, and wider still because a validator that gets
rate-limited by Binance falls through to CoinGecko or Coinbase — so two honest
validators can legitimately be quoting different exchanges. Measured live, those three
sources sit within about **0.02%** of each other, so the band is roughly 25x wider than
normal disagreement while remaining far tighter than any move that would change an
outcome.

If validators cannot agree, the transaction does not settle the round. It fails and is
retried on the next keeper sweep — a disputed price produces no result rather than a
wrong one.

### What this rules out

- **The operator cannot set the price.** No method accepts a price as an argument.
  `lock_round` and `resolve_round` take a market key and nothing else; the number is
  produced inside consensus.
- **A single exchange going down cannot decide it.** Three sources are tried in order.
- **A single lying validator cannot decide it.** Its answer has to survive comparison
  against everyone else's.
- **Late bets cannot see the answer.** Betting closes before `lock_round` runs, and the
  UI stops accepting bets 45 seconds earlier still, because a transaction sent inside
  that window would not reach consensus in time anyway.

### Checking it yourself

Every settled round keeps both prices and the decision, and the frontend shows them on
the results table — lock, close, the percentage move, and the winner. The same figures
come from the contract:

```bash
get_round(market_key, round_id)   # lock_price, close_price, winner, settlement
```

`settlement` is `PAID` when a winning side was actually paid, or `VOID` when the round
was refunded — either because the price finished exactly level, or because one side
attracted no bets and there was nobody to win from.

## 🔗 Cross-contract calls: what actually works

A single vault shared by GenPredict and GenPerp needs one contract to call another,
which is barely documented. Probed on-chain rather than trusted, and the answers were
not what the documentation suggested:

| Question | Answer |
|---|---|
| Is it `gl.ContractAt`? | **No.** That name does not exist — `AttributeError: module 'genlayer.gl' has no attribute 'ContractAt'`. Listing `dir(gl)` on-chain gives the real one: **`gl.get_contract_at`**, alongside `ContractProxy`, `deploy_contract` and `genvm_contracts`. |
| Reading another contract | **Works, synchronously.** `gl.get_contract_at(addr).view().some_method()` returns inline, usable from a view method. |
| Writing to another contract | **Works, but asynchronously.** `.emit().some_method()` returns immediately and the callee's state is unchanged when the parent transaction is ACCEPTED. The sub-call lands after the parent finalises. (`emit()` takes no `gas` kwarg — passing one is a `TypeError`.) |
| Who does the callee see as sender? | **The calling contract**, not the original wallet — so a vault can authorise callers by allowlist. |

**Why the shared vault is not built on this.** The async write is the blocker. Debiting a
balance has to be atomic with placing the bet: if the stake is recorded and the debit
lands a minute later — or fails because the balance moved — the two contracts disagree
about who owns what, and the bet is already on the books. Making that safe needs a
reserve-then-confirm protocol with compensation on every failure path, which is a lot of
new failure modes to buy one shared pool.

So each product owns its own funds. That still delivers what a shared vault was wanted
for: funding is mandatory, deposits are attributable per wallet, and one contract holds
the pool it pays from. The async path *is* safe for crediting, since a credit cannot
fail, so paying out across contracts stays open if it is ever needed.

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
│   ├── predict_market.py       # GenPredict — parimutuel up/down markets
│   ├── perp_exchange.py        # GenPerp — leveraged perpetuals
│   ├── btc_updown_market.py    # Legacy single-asset prediction round
│   └── btc_prediction.py       # Legacy example IC with consensus tolerance
├── frontend/
│   ├── index.html / home.js    # Market list
│   ├── market.html / market.js # One market: rounds, chart, betting
│   ├── portfolio.html / .js    # History: rounds joined, outcomes, collection state
│   ├── pool.html / pool.js     # Earn: supply and withdraw from either pool
│   ├── perp.html / perp-app.js # Leveraged perp terminal
│   ├── results.js              # Announces wins/losses/refunds; the collect banner
│   ├── session.js              # Optional burner key for signature-free betting
│   ├── shared.js               # Wallet, config, formatting, toasts, polling
│   └── styles.css              # Design system
├── deploy/
│   ├── deployPredictScript.ts  # Deploys predict_market.py
│   ├── deployPerpScript.ts     # Deploys perp_exchange.py
│   └── deployScript.ts         # Legacy deploy script
├── scripts/
│   ├── backend-proxy.js        # Read proxy + both keepers (Render web service)
│   ├── predict-keeper.js       # Round lifecycle: start / lock / resolve
│   ├── predict-smoke-test.ts   # End-to-end bet → settle → claim test
│   ├── perp-keeper.ts          # Price refresh / liquidations / funding
│   ├── perp-smoke-test.ts      # End-to-end perp lifecycle test
│   ├── fund-vault.ts           # One-off perp vault funding helper
│   └── build.js                # Injects BACKEND_URL into frontend at build time
├── vercel.json                 # Vercel deployment configuration
└── package.json
```

### Commands

```bash
npm run deploy        # deploy predict_market.py (validates in GenVM first)
npm run deploy:perp   # deploy perp_exchange.py
npm run backend       # read proxy + both keepers on :3005
npm run smoke         # end-to-end predict test (bet → settle → claim)
npm run smoke:perp    # end-to-end perp test
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

**The RPC budget decides how many markets you can run.** This is the single hardest
constraint in the project, and it is worth understanding before adding anything.

The node enforces **500 requests/hour** and **5000/day**, shared by every browser tab,
both keepers and any script. Exceeding either takes the whole app down until the window
rolls — an hour, or eight hours. It happened twice while building this.

Measured, not estimated (the backend's RPC meter counts every round trip):

| | cost |
|---|---|
| a contract read | **1** call |
| a keeper transaction | **4** calls — `eth_getTransactionCount`, `eth_estimateGas`, `eth_gasPrice`, `eth_sendRawTransaction` |
| a round | 2 transactions (lock + resolve) = **8** calls |

That 4x on writes is what makes the budget tight, and assuming it was 1 is how the quota
first got blown.

The second, larger mistake was assuming the horizon set the pace. It does not: **a new
round opens every time the previous one locks**, so the cadence comes from the *betting
window*, not the horizon. An hourly market was still opening a round every five minutes,
which is why moving the long tail from 15m to 1h barely helped — 876 calls/hour became
750.

The real problem was that **a market nobody was playing still cycled forever**, burning
two transactions per betting window whether or not a single bet existed. So now:

- **A round with no stake on it never locks.** The keeper skips it, it simply waits, and
  it costs nothing. The first bet wakes it up and restarts the betting window from that
  moment, so whoever wants the other side still gets a full window to take it.

An idle market therefore costs **zero transactions**, and cost scales with how much
people actually play rather than with how many markets are listed — which is what makes
listing eight coins affordable at all. The other savings:

- **The keeper never polls a transaction to completion.** It used to check every 5s for
  ~70s of consensus: 14 calls per action, ~19k a day on its own. The contract already
  reports what is outstanding, so a successful action disappears from
  `get_pending_actions` and a failed one is retried next sweep. Send and forget.
- **The perp keeper checks one number before reading anything else.** Scanning every
  market cost one read per market per sweep (~480/hour with the full listing). It now
  reads total margin locked first and skips the scan entirely when nothing is open.
- **Browser polling pauses when the tab is hidden**, so a forgotten tab costs nothing,
  and reads are cached 30s. Countdowns tick locally from timestamps already held, so
  nothing feels slower.

Watch the real number in the backend log — it reports every five minutes and warns at 450:

```text
[RPC] 73 calls in 5.0min → ~876/hour of 500  eth_getTransactionCount=13 ...
```

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
