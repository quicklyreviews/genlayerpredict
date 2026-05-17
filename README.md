# BTC Up/Down Prediction Market

A mini prediction game built on **GenLayer** — the AI-powered blockchain.

Players predict whether Bitcoin's price will go **UP** or **DOWN** over a 10-minute round. The contract fetches real BTC/USD prices using GenLayer's non-deterministic web access with validator consensus.

## 🎮 How It Works

```
Round Lifecycle (10 minutes)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
│  OPEN (0-5 min)  │  LOCKED (5-10 min)  │ RESOLVED
│  Players bet      │  No new bets        │ Winner decided
│  UP or DOWN       │  Waiting...         │ Compare prices
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

1. **Start** — Bot calls `start_round()`, contract fetches BTC opening price
2. **Bet** — Players call `bet_up()` or `bet_down()` within 5 minutes
3. **Lock** — Bot calls `lock_round()` after 5 minutes
4. **Resolve** — Bot calls `resolve_round()` after 10 minutes, fetches closing price

**Winner:** If close > open → UP wins. If close < open → DOWN wins. Equal → DRAW.

## 📁 Project Structure

```
├── contracts/
│   └── btc_updown_market.py   # Main intelligent contract
├── tests/
│   └── test_btc_updown.py     # Direct VM tests
├── deploy/
│   └── deployScript.ts        # Contract deployment
├── scripts/
│   └── round-cron.ts          # Off-chain round manager bot
└── frontend/
    ├── index.html              # Game UI
    ├── styles.css              # Design system
    └── app.js                  # Frontend logic
```

## 🚀 Quick Start

### Prerequisites

- [GenLayer CLI](https://docs.genlayer.com/developers/cli)
- Node.js 18+
- GenLayer Studio running (`genlayer up`)

### 1. Run Tests

```bash
cd F:\Work\Cryoto\Genlayer
gltest tests/test_btc_updown.py
```

### 2. Deploy Contract

```bash
npx tsx deploy/deployScript.ts
```

### 3. Start the Round Bot

```bash
CONTRACT_ADDRESS=0x... npx tsx scripts/round-cron.ts
```

### 4. Open Frontend

Open `frontend/index.html` in a browser. Click **Settings** to enter your RPC URL and contract address.

## 🔧 Contract API

### Write Methods

| Method | Description |
|--------|-------------|
| `start_round()` | Start new round, fetch opening BTC price |
| `bet_up()` | Predict price will go up |
| `bet_down()` | Predict price will go down |
| `lock_round()` | Lock round after betting window (5 min) |
| `resolve_round()` | Resolve round with closing price (10 min) |

### View Methods

| Method | Description |
|--------|-------------|
| `get_round()` | Get current round data |
| `get_my_vote(addr)` | Get a player's vote |

## ⚙️ Configuration

| Env Variable | Default | Description |
|---|---|---|
| `GENLAYER_RPC_URL` | `http://localhost:4000/api` | GenLayer RPC endpoint |
| `CONTRACT_ADDRESS` | — | Deployed contract address |
| `ROUND_PAUSE_MS` | `5000` | Pause between rounds (ms) |

## 📝 Architecture Notes

- **No cron in contract** — Round transitions are triggered by an off-chain bot. The contract only validates timing and state.
- **Non-deterministic price fetch** — Uses `gl.vm.run_nondet_unsafe()` with a leader/validator pattern. Leader fetches price, validators independently verify within tolerance (max $10 or 0.1%).
- **Integer prices** — BTC price is stored as integer USD to minimize floating-point disagreement between validators.
- **TreeMap votes** — Uses GenLayer's `TreeMap[Address, str]` for efficient vote storage with one-vote-per-player enforcement.

## 📄 License

MIT
