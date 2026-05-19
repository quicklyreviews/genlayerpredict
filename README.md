# 📈 Gen Predict

A decentralized BTC Up/Down Prediction Market built on **GenLayer** — the AI-powered blockchain.

**Gen Predict** allows players to bet (with GEN tokens) on whether the price of Bitcoin will go **UP** or **DOWN** within a specific timeframe. The game leverages GenLayer's unique **Intelligent Contracts** and **Equivalence Principle** to fetch real-world BTC prices securely via decentralized consensus, without relying on traditional oracles like Chainlink.

---

## 🎮 How It Works

```text
Round Lifecycle (2 minutes)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
│  OPEN (0-1 min)  │  LOCKED (1-2 min)  │ RESOLVED
│  Players bet      │  No new bets        │ Winner decided
│  UP or DOWN       │  Waiting...         │ Winnings ready
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

1. **Start** — The backend cron job calls `start_round()`. The Intelligent Contract fetches the current BTC price as the "Opening Price".
2. **Bet** — Players connect their wallets and call `bet_up()` or `bet_down()` with GEN tokens within the 1-minute betting window.
3. **Lock** — The backend calls `lock_round()` after 1 minute. No more bets are accepted.
4. **Resolve** — After 2 minutes, the backend calls `resolve_round()`. The contract fetches the "Closing Price".
5. **Claim** — If the closing price matches the player's prediction, they can call `claim()` to withdraw their winnings directly to their wallet!

## 🧠 GenLayer Intelligent Consensus

This project demonstrates proper GenLayer **Equivalence Principle** design:
- **No LLMs for JSON Data**: We use `gl.nondet.web.get` and Python's `json` parser instead of AI prompts to read the CoinGecko API. This saves gas and ensures deterministic extraction.
- **Time Drift Tolerance**: Because validators fetch the BTC price at slightly different milliseconds, we use a custom `validator_fn` with `gl.vm.run_nondet_unsafe` allowing a **0.2% price tolerance**. This prevents consensus failures (UNDETERMINED state) due to natural API price drift.

## 📁 Project Structure

```text
├── contracts/
│   ├── btc_updown_market.py   # Main Intelligent Contract (Production)
│   └── btc_prediction.py      # Example IC with consensus tolerance 
├── frontend/
│   ├── index.html             # Game UI (Tailwind CSS)
│   └── app.js                 # Frontend logic (GenLayer JS SDK)
├── scripts/
│   ├── backend-proxy.js       # Node.js API Proxy & Auto-Round Cron Bot
│   └── build.js               # Injects environment variables into Frontend
├── vercel.json                # Vercel Deployment configuration
└── package.json               # Node.js dependencies
```

## 🚀 Deployment Guide

The architecture is split into two parts: a **Web Service Backend** and a **Static Frontend**.

### 1. Deploy the Backend & Cron Bot (Render)
The backend (`backend-proxy.js`) serves as an RPC proxy to avoid rate-limiting and runs the automatic game loop.
- Host on **Render** as a **Web Service**.
- **Build Command**: `npm install`
- **Start Command**: `node scripts/backend-proxy.js`
- **Environment Variables**:
  - `PRIVATE_KEY`: Your admin wallet private key (starts with `0x`).
  - `CONTRACT_ADDRESS`: Deployed GenLayer contract address.
  - `GENLAYER_RPC_URL`: `https://studio.genlayer.com/api` (or local/testnet URL).

### 2. Deploy the Frontend (Vercel)
The frontend is built using Vanilla JS and Tailwind CSS.
- Host on **Vercel** as a new Project.
- The `vercel.json` file is already configured with `"outputDirectory": "frontend"`.
- **Environment Variables**:
  - `BACKEND_URL`: Set this to your deployed Render URL (e.g., `https://gen-predict-backend.onrender.com`).
- During deployment, Vercel will run `npm run build` which injects your `BACKEND_URL` directly into `app.js`.

## 🛠 Local Development

### Prerequisites
- [GenLayer Simulator](https://docs.genlayer.com/) running locally (`genlayer up`)
- Node.js 18+

### Setup
1. Clone the repo and install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and fill in your details:
   ```env
   GENLAYER_RPC_URL=http://localhost:4000/api
   CONTRACT_ADDRESS=0x...
   PRIVATE_KEY=0x...
   ```
3. Start the Backend Proxy:
   ```bash
   node scripts/backend-proxy.js
   ```
4. Run the frontend:
   Simply open `frontend/index.html` in your browser using Live Server or serve it directly.

## 👨‍💻 Author
Created by [@trungkts29](https://x.com/trungkts29)

## 📄 License
MIT
