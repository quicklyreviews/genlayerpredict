# v1.0.0 — GenPerp: multi-asset leveraged perpetual exchange on GenLayer
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

# GenVM parses the two lines above as the "runner comment" and is strict about them:
# line 1 must START with the version token (`# v1.0.0 ...`), the Depends line must
# come immediately after, and NO further comment may follow before the code —
# violating any of these fails deployment with a bare `invalid_contract` error.
#
# Zero gl.ContractState usage — ContractState writes are broken on GenLayer.
# All state lives in plain instance fields; nested/dict data is JSON-encoded
# into string fields (same pattern proven in btc_updown_market.py).

from genlayer import *

import json
import typing
import time


@gl.evm.contract_interface
class _Recipient:
    class Write:
        pass
    class View:
        pass


class PerpExchange(gl.Contract):
    """
    GenPerp — a multi-asset leveraged perpetual-futures exchange.

    Design notes (read before touching the math):
      - No oracle, no Chainlink. Every trade fetches the live USD price
        itself via gl.nondet.web.get() — Binance, then CoinGecko, then
        Coinbase as fallbacks — and validators reach consensus on the
        result through the Equivalence Principle (0.5% agreement band,
        see _fetch_price). This is GenLayer's native way of doing price
        feeds — see docs.genlayer.com.
      - The contract itself is the counterparty (a single shared vault),
        not a peer-to-peer order book. Traders post margin, open a LONG
        or SHORT with 1x-125x leverage (per-market cap), and PnL is
        settled against the vault when they close or get liquidated.
      - PnL is computed in the margin's own currency (GEN) using the
        percentage price move, not a separate USD-margined conversion:
            pct = (price_now - entry) / entry            (LONG)
            pct = (entry - price_now) / entry             (SHORT)
            pnl = notional * pct                          (notional = margin * leverage)
        This is the standard "linear/inverse-free" simplification used by
        most non-custodial leveraged CFD/perp demos when the collateral
        token doubles as the quote currency — deliberate, documented here.
      - Funding: periodically (per-market interval), longs and shorts pay
        each other proportional to the open-interest skew, so one-sided
        markets get pushed back toward balance exactly like a real perp.
      - Liquidation is permissionless — anyone can call liquidate_position
        on an under-margined position and earn a bounty. This is what
        replaces a centralized liquidation engine.
    """

    owner: str
    next_position_id: u256
    total_positions: u256
    vault_balance: u256          # total GEN wei actually held by the contract
    total_margin_locked: u256    # sum of current margin across all OPEN positions
    protocol_fees_collected: u256
    liquidation_bounty_bps: u256
    stakes_json: str            # { "0xaddr": {"principal": wei, "since": ts, "accrued": wei} }
    staked_principal: u256      # sum of every LP's principal, part of vault_balance
    rewards_pool: u256          # owner-funded subsidy that pays LP yield
    rewards_paid: u256          # lifetime yield actually handed out
    apy_bps: u256               # LP yield, in basis points per year
    markets_json: str            # { "BTC": {...}, "ETH": {...}, ... }
    positions_json: str          # { "1": {...}, "2": {...}, ... }
    oi_json: str                 # { "BTC": {"long": "wei", "short": "wei"}, ... }
    funding_json: str            # { "BTC": {"last_ts": 0, "last_rate_bps": 0}, ... }
    price_cache_json: str        # { "BTC": {"price": "60000.0", "ts": 0}, ... }

    # ─── Construction ────────────────────────────────────────────────

    def __init__(self):
        self.owner = str(gl.message.sender_address).lower()
        self.next_position_id = u256(0)
        self.total_positions = u256(0)
        self.vault_balance = u256(0)
        self.total_margin_locked = u256(0)
        self.protocol_fees_collected = u256(0)
        self.liquidation_bounty_bps = u256(50)  # 0.5% of lost margin, paid to liquidator
        self.stakes_json = "{}"
        self.staked_principal = u256(0)
        self.rewards_pool = u256(0)
        self.rewards_paid = u256(0)
        self.apy_bps = u256(1000)  # 10.00% per year

        # Leverage caps and maintenance margins are set by how violently each asset
        # moves: the majors tolerate 20x, memecoins get a fraction of that and a
        # much wider maintenance buffer, because a routine 10% candle would wipe out
        # a high-leverage position before a keeper could ever liquidate it.
        default_markets = {
            "BTC":  self._market_config("bitcoin",     20, 500, 10, 300, 100, "10000000000000000"),
            "ETH":  self._market_config("ethereum",    20, 500, 10, 300, 100, "10000000000000000"),
            "SOL":  self._market_config("solana",      15, 700, 15, 300, 150, "10000000000000000"),
            "BNB":  self._market_config("binancecoin", 15, 700, 15, 300, 150, "10000000000000000"),
            "LINK": self._market_config("chainlink",   10, 800, 20, 300, 150, "10000000000000000"),
            "DOGE": self._market_config("dogecoin",     8, 1000, 25, 300, 200, "10000000000000000"),
            "SHIB": self._market_config("shiba-inu",    5, 1200, 30, 300, 200, "10000000000000000"),
            "PEPE": self._market_config("pepe",         5, 1200, 30, 300, 200, "10000000000000000"),
        }
        self.markets_json = json.dumps(default_markets)
        self.positions_json = "{}"
        self.oi_json = "{}"
        self.funding_json = "{}"
        self.price_cache_json = "{}"

    # ─── Internal helpers ───────────────────────────────────────────

    def _load(self, s: str, default: typing.Any) -> typing.Any:
        try:
            return json.loads(s) if s else default
        except Exception:
            return default

    def _require_owner(self) -> None:
        if str(gl.message.sender_address).lower() != self.owner:
            raise gl.vm.UserError("Only owner can call this")

    def _market_config(self, coingecko_id: str, max_leverage: int, maintenance_margin_bps: int,
                        taker_fee_bps: int, funding_interval_seconds: int, funding_k_bps: int,
                        min_margin: str) -> dict:
        return {
            "coingecko_id": coingecko_id,
            # 1/0 rather than True/False: this dict is returned by get_market(),
            # and GenVM's calldata codec is strict about the types it accepts.
            "enabled": 1,
            "max_leverage": int(max_leverage),
            "maintenance_margin_bps": int(maintenance_margin_bps),
            "taker_fee_bps": int(taker_fee_bps),
            "funding_interval_seconds": int(funding_interval_seconds),
            "funding_k_bps": int(funding_k_bps),
            "min_margin": str(min_margin),
        }

    def _fetch_price(self, symbol: str, coingecko_id: str) -> float:
        """Fetch a live USD price via GenLayer's Equivalence Principle (no oracle).

        Two hard-won details:

        * leader_fn returns a *string*, never a float. Values crossing the
          nondeterministic boundary are calldata-encoded and GenVM's codec has
          no float type — returning one aborts the transaction with
          `not calldata encodable ...: float`.
        * Several price sources are tried in order. A single source is not
          survivable here: every validator fetches independently, so a busy
          market rate-limits some of them, and CoinGecko answers a throttled
          request with a 200 + error body that used to blow up as
          `KeyError: 'bitcoin'` and revert the trade.

        Because the leader and a validator may end up on different exchanges,
        the agreement band is 0.5% rather than the 0.2% a single source needs —
        wide enough for normal cross-exchange spread, still far tighter than any
        move that would matter for margin.
        """
        binance_symbol = f"{symbol}USDT"
        coinbase_pair = f"{symbol}-USD"

        def leader_fn() -> str:
            # (url, extractor) pairs, most reliable first.
            sources = [
                (
                    f"https://api.binance.com/api/v3/ticker/price?symbol={binance_symbol}",
                    lambda d: d.get("price"),
                ),
                (
                    f"https://api.coingecko.com/api/v3/simple/price?ids={coingecko_id}&vs_currencies=usd",
                    lambda d: d.get(coingecko_id, {}).get("usd"),
                ),
                (
                    f"https://api.coinbase.com/v2/prices/{coinbase_pair}/spot",
                    lambda d: d.get("data", {}).get("amount"),
                ),
            ]
            for url, extract in sources:
                try:
                    response = gl.nondet.web.get(url)
                    data = json.loads(response.body)
                    raw = extract(data)
                    if raw is None:
                        continue
                    price = float(raw)
                    if price > 0:
                        return str(price)
                except Exception:
                    continue
            raise gl.vm.UserError(f"All price sources failed for {symbol}")

        def validator_fn(leader_result) -> bool:
            if not isinstance(leader_result, gl.vm.Return):
                return False
            leader_price = float(leader_result.calldata)
            validator_price = float(leader_fn())
            if leader_price == 0:
                return validator_price == 0
            return abs(leader_price - validator_price) / abs(leader_price) <= 0.005

        return float(gl.vm.run_nondet_unsafe(leader_fn, validator_fn))

    def _price_change_pct(self, entry_price: float, current_price: float, direction: str) -> float:
        if entry_price == 0:
            return 0.0
        if direction == "LONG":
            return (current_price - entry_price) / entry_price
        return (entry_price - current_price) / entry_price

    def _adjust_open_interest(self, symbol: str, direction: str, delta: int) -> None:
        oi = self._load(self.oi_json, {})
        entry = oi.get(symbol, {"long": "0", "short": "0"})
        key = "long" if direction == "LONG" else "short"
        entry[key] = str(max(0, int(entry[key]) + delta))
        oi[symbol] = entry
        self.oi_json = json.dumps(oi)

    def _cache_price(self, symbol: str, price: float) -> None:
        cache = self._load(self.price_cache_json, {})
        cache[symbol] = {"price": str(price), "ts": int(time.time())}
        self.price_cache_json = json.dumps(cache)

    # ─── Liquidity pool ──────────────────────────────────────────────
    #
    # Here the LPs are doing real work. This exchange is the counterparty to every
    # trade, so trader profit is paid out of the vault and staked capital is what
    # makes that possible — unlike the parimutuel prediction market, where players
    # win from each other and outside liquidity would just sit there.
    #
    # Two consequences follow, and both are enforced below:
    #
    # 1. Staked principal is part of vault_balance and genuinely at risk. If traders
    #    win more than the fees take in, the vault shrinks and there is less to go
    #    round. Withdrawals are therefore capped at what the vault can actually free
    #    without touching margin belonging to open positions.
    # 2. The APY is a subsidy paid from rewards_pool, which the owner funds. Trading
    #    fees do not fund it and are not pretended to. When it runs dry the contract
    #    pays what remains and reports the shortfall rather than issuing an IOU it
    #    cannot honour; get_pool() publishes the remaining runway.

    SECONDS_PER_YEAR = 31536000

    def _stake_of(self, stakes: dict, addr: str) -> dict:
        return stakes.get(addr.lower(), {"principal": "0", "since": 0, "accrued": "0"})

    def _accrue(self, stakes: dict, addr: str) -> dict:
        """Bring one account's interest up to date. Safe to call repeatedly."""
        a = addr.lower()
        st = self._stake_of(stakes, a)
        principal = int(st["principal"])
        now = int(time.time())
        since = int(st.get("since", 0)) or now
        if principal > 0 and now > since:
            earned = principal * int(self.apy_bps) * (now - since) // (10000 * self.SECONDS_PER_YEAR)
            st["accrued"] = str(int(st.get("accrued", "0")) + earned)
        st["since"] = now
        st["principal"] = str(principal)
        stakes[a] = st
        return st

    def _pending_interest(self, st: dict) -> int:
        principal = int(st.get("principal", "0"))
        now = int(time.time())
        since = int(st.get("since", 0)) or now
        live = 0
        if principal > 0 and now > since:
            live = principal * int(self.apy_bps) * (now - since) // (10000 * self.SECONDS_PER_YEAR)
        return int(st.get("accrued", "0")) + live

    def _runway_seconds(self) -> int:
        principal = int(self.staked_principal)
        if principal <= 0 or int(self.apy_bps) <= 0:
            return -1
        per_second = principal * int(self.apy_bps) / (10000 * self.SECONDS_PER_YEAR)
        if per_second <= 0:
            return -1
        return int(int(self.rewards_pool) / per_second)

    @gl.public.write.payable
    def stake(self) -> dict[str, typing.Any]:
        """Supply GEN to back trader PnL and earn the advertised APY.

        The stake joins vault_balance, so it is genuinely exposed to trader profit
        and loss — this is not a savings account with a yield bolted on.
        """
        amount = int(gl.message.value)
        if amount <= 0:
            raise gl.vm.UserError("Stake must be greater than zero")
        provider = str(gl.message.sender_address).lower()
        stakes = self._load(self.stakes_json, {})
        st = self._accrue(stakes, provider)
        st["principal"] = str(int(st["principal"]) + amount)
        stakes[provider] = st
        self.stakes_json = json.dumps(stakes)
        self.staked_principal += u256(amount)
        self.vault_balance += u256(amount)
        return {
            "address": provider,
            "staked": str(amount),
            "principal": st["principal"],
            "apy_bps": int(self.apy_bps),
            "runway_seconds": self._runway_seconds(),
        }

    @gl.public.write
    def unstake(self, amount: u256) -> dict[str, typing.Any]:
        """Withdraw principal plus interest earned.

        Capped by what the vault can free: margin backing open positions belongs to
        traders, and letting an LP withdraw against it would leave a position that
        cannot be paid out. Wait for positions to close, or withdraw less.
        """
        want = int(amount)
        if want <= 0:
            raise gl.vm.UserError("Amount must be greater than zero")
        provider = str(gl.message.sender_address).lower()
        stakes = self._load(self.stakes_json, {})
        st = self._accrue(stakes, provider)
        principal = int(st["principal"])
        if want > principal:
            raise gl.vm.UserError(f"You have {principal} wei staked, cannot withdraw {want}")

        free = int(self.vault_balance) - int(self.total_margin_locked)
        if want > free:
            raise gl.vm.UserError(
                f"Only {max(0, free)} wei is free right now — the rest is margin backing "
                f"open positions. Try a smaller amount or wait for positions to close."
            )

        accrued = int(st["accrued"])
        share = accrued if want == principal else accrued * want // principal
        payable = min(share, int(self.rewards_pool))
        shortfall = share - payable

        st["principal"] = str(principal - want)
        st["accrued"] = str(accrued - share + shortfall)
        stakes[provider] = st
        self.stakes_json = json.dumps(stakes)
        self.staked_principal = u256(max(0, int(self.staked_principal) - want))
        self.vault_balance = u256(max(0, int(self.vault_balance) - want))
        self.rewards_pool = u256(int(self.rewards_pool) - payable)
        self.rewards_paid += u256(payable)

        _Recipient(gl.message.sender_address).emit_transfer(value=u256(want + payable))
        return {
            "withdrawn_principal": str(want),
            "interest_paid": str(payable),
            "interest_unpaid": str(shortfall),
            "principal_left": st["principal"],
        }

    @gl.public.write
    def claim_interest(self) -> dict[str, typing.Any]:
        """Take the interest without touching the principal."""
        provider = str(gl.message.sender_address).lower()
        stakes = self._load(self.stakes_json, {})
        st = self._accrue(stakes, provider)
        accrued = int(st["accrued"])
        if accrued <= 0:
            raise gl.vm.UserError("No interest has accrued yet")
        payable = min(accrued, int(self.rewards_pool))
        if payable <= 0:
            raise gl.vm.UserError("The reward subsidy is empty — ask the owner to top it up")
        st["accrued"] = str(accrued - payable)
        stakes[provider] = st
        self.stakes_json = json.dumps(stakes)
        self.rewards_pool = u256(int(self.rewards_pool) - payable)
        self.rewards_paid += u256(payable)
        _Recipient(gl.message.sender_address).emit_transfer(value=u256(payable))
        return {"interest_paid": str(payable), "interest_unpaid": str(accrued - payable)}

    @gl.public.write.payable
    def fund_rewards(self) -> dict[str, typing.Any]:
        """Top up the subsidy that pays LP interest. Kept separate from the vault so
        yield can never be mistaken for capital backing trader payouts."""
        amount = int(gl.message.value)
        if amount <= 0:
            raise gl.vm.UserError("Amount must be greater than zero")
        self.rewards_pool += u256(amount)
        return {"rewards_pool": str(self.rewards_pool), "runway_seconds": self._runway_seconds()}

    @gl.public.write
    def set_apy_bps(self, bps: u256) -> None:
        """Change the advertised APY. Every staker is settled to this second first,
        so a rate change never rewrites interest already earned."""
        self._require_owner()
        v = int(bps)
        if v > 10000:
            raise gl.vm.UserError("An APY above 100% is almost certainly a mistake")
        stakes = self._load(self.stakes_json, {})
        for addr in list(stakes.keys()):
            self._accrue(stakes, addr)
        self.stakes_json = json.dumps(stakes)
        self.apy_bps = u256(v)

    @gl.public.view
    def get_stake(self, addr: str) -> dict[str, typing.Any]:
        stakes = self._load(self.stakes_json, {})
        st = self._stake_of(stakes, addr)
        interest = self._pending_interest(st)
        free = max(0, int(self.vault_balance) - int(self.total_margin_locked))
        return {
            "address": addr.lower(),
            "principal": st.get("principal", "0"),
            "interest": str(interest),
            "total": str(int(st.get("principal", "0")) + interest),
            "withdrawable_now": str(min(int(st.get("principal", "0")), free)),
            "since": int(st.get("since", 0)),
            "apy_bps": int(self.apy_bps),
        }

    @gl.public.view
    def get_pool(self) -> dict[str, typing.Any]:
        return {
            "staked_principal": str(self.staked_principal),
            "rewards_pool": str(self.rewards_pool),
            "rewards_paid": str(self.rewards_paid),
            "apy_bps": int(self.apy_bps),
            "runway_seconds": self._runway_seconds(),
            "providers": len(self._load(self.stakes_json, {})),
            "vault_balance": str(self.vault_balance),
            "margin_locked": str(self.total_margin_locked),
            "free_liquidity": str(max(0, int(self.vault_balance) - int(self.total_margin_locked))),
        }

    # ─── Admin: market registry & vault ─────────────────────────────

    @gl.public.write
    def add_market(self, symbol: str, coingecko_id: str, max_leverage: u256, maintenance_margin_bps: u256,
                    taker_fee_bps: u256, funding_interval_seconds: u256, funding_k_bps: u256,
                    min_margin: u256) -> None:
        """Register a new market or overwrite an existing one's config. Owner only."""
        self._require_owner()
        symbol = symbol.upper()
        ml = int(max_leverage)
        mmb = int(maintenance_margin_bps)
        tfb = int(taker_fee_bps)
        fis = int(funding_interval_seconds)
        fkb = int(funding_k_bps)
        mm = int(min_margin)

        if ml < 1 or ml > 125:
            raise gl.vm.UserError("max_leverage must be between 1 and 125")
        if mmb < 1 or mmb >= 10000:
            raise gl.vm.UserError("maintenance_margin_bps must be between 1 and 9999")
        if tfb > 1000:
            raise gl.vm.UserError("taker_fee_bps too high (max 1000 = 10%)")
        if fis < 30:
            raise gl.vm.UserError("funding_interval_seconds must be >= 30")
        if fkb > 2000:
            raise gl.vm.UserError("funding_k_bps too high (max 2000 = 20%)")
        if mm == 0:
            raise gl.vm.UserError("min_margin must be > 0")
        if not coingecko_id or len(coingecko_id) > 64:
            raise gl.vm.UserError("Invalid coingecko_id")

        markets = self._load(self.markets_json, {})
        markets[symbol] = self._market_config(coingecko_id, ml, mmb, tfb, fis, fkb, str(mm))
        self.markets_json = json.dumps(markets)

    @gl.public.write
    def set_market_enabled(self, symbol: str, enabled: u256) -> None:
        """Pause/resume new positions on a market (enabled: 1=on, 0=off). Existing positions
        are unaffected. Owner only. (u256 instead of bool — GenVM calldata support for bool
        parameters is undocumented, so every public method here sticks to u256/str.)"""
        self._require_owner()
        symbol = symbol.upper()
        markets = self._load(self.markets_json, {})
        if symbol not in markets:
            raise gl.vm.UserError("Unknown market")
        markets[symbol]["enabled"] = 1 if int(enabled) != 0 else 0
        self.markets_json = json.dumps(markets)

    @gl.public.write
    def set_liquidation_bounty_bps(self, bps: u256) -> None:
        self._require_owner()
        b = int(bps)
        if b < 0 or b > 500:
            raise gl.vm.UserError("Bounty must be between 0 and 500 bps (5%)")
        self.liquidation_bounty_bps = u256(b)

    @gl.public.write
    def transfer_ownership(self, new_owner: str) -> None:
        self._require_owner()
        self.owner = new_owner.lower()

    @gl.public.write.payable
    def fund_vault(self) -> None:
        """Anyone (typically the admin/LP) can top up the vault backing traders' payouts."""
        self.vault_balance += u256(int(gl.message.value))

    @gl.public.write
    def withdraw_vault(self, amount: u256) -> None:
        """Owner withdraws vault profit. Cannot withdraw margin currently locked in open positions."""
        self._require_owner()
        amt = int(amount)
        free = int(self.vault_balance) - int(self.total_margin_locked)
        if amt <= 0 or amt > free:
            raise gl.vm.UserError(f"Cannot withdraw more than free vault balance ({free} wei)")
        self.vault_balance -= u256(amt)
        _Recipient(gl.message.sender_address).emit_transfer(value=u256(amt))

    # ─── Trading ─────────────────────────────────────────────────────

    @gl.public.write.payable
    def open_position(self, symbol: str, direction: str, leverage: u256) -> dict[str, typing.Any]:
        """Open a leveraged LONG or SHORT. gl.message.value is the margin (GEN wei)."""
        symbol = symbol.upper()
        direction = direction.upper()
        if direction not in ("LONG", "SHORT"):
            raise gl.vm.UserError("direction must be LONG or SHORT")

        markets = self._load(self.markets_json, {})
        market = markets.get(symbol)
        if not market or int(market.get("enabled", 0)) != 1:
            raise gl.vm.UserError(f"Unknown or disabled market: {symbol}")

        lev = int(leverage)
        if lev < 1 or lev > int(market["max_leverage"]):
            raise gl.vm.UserError(f"Leverage must be between 1 and {market['max_leverage']}x for {symbol}")

        value = int(gl.message.value)
        min_margin = int(market["min_margin"])
        if value < min_margin:
            raise gl.vm.UserError(f"Margin must be at least {min_margin} wei for {symbol}")

        fee = value * int(market["taker_fee_bps"]) // 10000
        net_margin = value - fee
        notional = net_margin * lev

        entry_price = self._fetch_price(symbol, market["coingecko_id"])
        if entry_price <= 0:
            raise gl.vm.UserError("Invalid price feed, please retry")

        self.next_position_id += u256(1)
        pid = int(self.next_position_id)
        self.total_positions += u256(1)

        mm_ratio = int(market["maintenance_margin_bps"]) / 10000.0
        adverse_threshold = (1 - mm_ratio) / lev
        if direction == "LONG":
            liq_price = entry_price * (1 - adverse_threshold)
        else:
            liq_price = entry_price * (1 + adverse_threshold)

        position = {
            "id": pid,
            "owner": str(gl.message.sender_address).lower(),
            "symbol": symbol,
            "direction": direction,
            "leverage": lev,
            "margin": str(net_margin),
            "notional": str(notional),
            "entry_price": str(entry_price),
            "liq_price_estimate": str(liq_price),
            "status": "OPEN",
            "opened_at": int(time.time()),
            "closed_at": 0,
            "close_price": "",
            "realized_pnl": "",
            "funding_paid": "0",
        }
        positions = self._load(self.positions_json, {})
        positions[str(pid)] = position
        self.positions_json = json.dumps(positions)

        self._adjust_open_interest(symbol, direction, notional)
        self.total_margin_locked += u256(net_margin)
        self.vault_balance += u256(value)
        self.protocol_fees_collected += u256(fee)
        self._cache_price(symbol, entry_price)

        return {
            "position_id": pid,
            "symbol": symbol,
            "direction": direction,
            "leverage": lev,
            "margin": str(net_margin),
            "notional": str(notional),
            "entry_price": str(entry_price),
            "liq_price_estimate": str(liq_price),
            "fee": str(fee),
        }

    @gl.public.write
    def close_position(self, position_id: u256) -> dict[str, typing.Any]:
        """Voluntarily close an OPEN position at the live price and receive margin +/- PnL."""
        pid = str(int(position_id))
        positions = self._load(self.positions_json, {})
        p = positions.get(pid)
        if not p:
            raise gl.vm.UserError("Position not found")
        if p["status"] != "OPEN":
            raise gl.vm.UserError("Position is not open")
        sender = str(gl.message.sender_address).lower()
        if p["owner"] != sender:
            raise gl.vm.UserError("Not the position owner")

        markets = self._load(self.markets_json, {})
        market = markets.get(p["symbol"])
        if not market:
            raise gl.vm.UserError("Market no longer exists")

        current_price = self._fetch_price(p["symbol"], market["coingecko_id"])
        entry_price = float(p["entry_price"])
        margin = int(p["margin"])
        notional = int(p["notional"])

        pct = self._price_change_pct(entry_price, current_price, p["direction"])
        pnl = notional * pct
        payout = max(0, int(round(margin + pnl)))
        # Solvency guard: never pay out more than the vault currently holds
        payout = min(payout, int(self.vault_balance))

        p["status"] = "CLOSED"
        p["close_price"] = str(current_price)
        p["closed_at"] = int(time.time())
        p["realized_pnl"] = str(int(round(pnl)))
        positions[pid] = p
        self.positions_json = json.dumps(positions)

        self._adjust_open_interest(p["symbol"], p["direction"], -notional)
        self.total_margin_locked = u256(max(0, int(self.total_margin_locked) - margin))
        self.vault_balance = u256(max(0, int(self.vault_balance) - payout))
        self._cache_price(p["symbol"], current_price)

        if payout > 0:
            _Recipient(gl.message.sender_address).emit_transfer(value=u256(payout))

        return {
            "position_id": int(position_id),
            "close_price": str(current_price),
            "realized_pnl": str(int(round(pnl))),
            "payout": str(payout),
        }

    @gl.public.write
    def liquidate_position(self, position_id: u256) -> dict[str, typing.Any]:
        """Permissionless liquidation. Anyone can call this on an under-margined position
        and earn liquidation_bounty_bps of the lost margin as a reward."""
        pid = str(int(position_id))
        positions = self._load(self.positions_json, {})
        p = positions.get(pid)
        if not p:
            raise gl.vm.UserError("Position not found")
        if p["status"] != "OPEN":
            raise gl.vm.UserError("Position is not open")

        markets = self._load(self.markets_json, {})
        market = markets.get(p["symbol"])
        if not market:
            raise gl.vm.UserError("Market no longer exists")

        current_price = self._fetch_price(p["symbol"], market["coingecko_id"])
        entry_price = float(p["entry_price"])
        margin = int(p["margin"])
        notional = int(p["notional"])

        pct = self._price_change_pct(entry_price, current_price, p["direction"])
        pnl = notional * pct
        equity = margin + pnl
        maintenance = margin * (int(market["maintenance_margin_bps"]) / 10000.0)

        if equity > maintenance:
            raise gl.vm.UserError("Position is healthy — not liquidatable")

        bounty = int(margin * (int(self.liquidation_bounty_bps) / 10000.0))
        bounty = max(0, min(bounty, margin, int(self.vault_balance)))

        p["status"] = "LIQUIDATED"
        p["close_price"] = str(current_price)
        p["closed_at"] = int(time.time())
        p["realized_pnl"] = str(-margin)
        positions[pid] = p
        self.positions_json = json.dumps(positions)

        self._adjust_open_interest(p["symbol"], p["direction"], -notional)
        self.total_margin_locked = u256(max(0, int(self.total_margin_locked) - margin))
        self.vault_balance = u256(max(0, int(self.vault_balance) - bounty))
        self._cache_price(p["symbol"], current_price)

        if bounty > 0:
            _Recipient(gl.message.sender_address).emit_transfer(value=u256(bounty))

        return {
            "position_id": int(position_id),
            "liquidated": 1,
            "close_price": str(current_price),
            "liquidator_bounty": str(bounty),
            "margin_lost": str(margin),
        }

    @gl.public.write
    def settle_funding(self, symbol: str) -> dict[str, typing.Any]:
        """Permissionless funding settlement. Rate-limited to once per funding_interval_seconds.
        Longs and shorts pay each other proportional to the open-interest skew — no GEN moves
        in or out of the vault, this only reallocates margin between open positions."""
        symbol = symbol.upper()
        markets = self._load(self.markets_json, {})
        market = markets.get(symbol)
        if not market or int(market.get("enabled", 0)) != 1:
            raise gl.vm.UserError("Unknown or disabled market")

        funding = self._load(self.funding_json, {})
        finfo = funding.get(symbol, {"last_ts": 0, "last_rate_bps": 0})
        now = int(time.time())
        interval = int(market["funding_interval_seconds"])
        elapsed = now - int(finfo.get("last_ts", 0))
        if elapsed < interval:
            raise gl.vm.UserError(f"Funding not due yet, wait {interval - elapsed}s")

        positions = self._load(self.positions_json, {})
        long_ids = []
        short_ids = []
        for pid, p in positions.items():
            if p.get("symbol") == symbol and p.get("status") == "OPEN":
                (long_ids if p["direction"] == "LONG" else short_ids).append(pid)

        long_sum = sum(int(positions[pid]["notional"]) for pid in long_ids)
        short_sum = sum(int(positions[pid]["notional"]) for pid in short_ids)
        total = long_sum + short_sum

        k = int(market["funding_k_bps"]) / 10000.0
        skew = 0.0 if total == 0 else (long_sum - short_sum) / total
        rate_long = skew * k     # positive => longs pay (more longs than shorts)
        rate_short = -skew * k   # positive => shorts pay (more shorts than longs)

        margin_delta_total = 0
        for pid in long_ids:
            p = positions[pid]
            delta = int(round(int(p["notional"]) * rate_long))
            old_margin = int(p["margin"])
            new_margin = max(0, old_margin - delta)
            actual = old_margin - new_margin
            p["margin"] = str(new_margin)
            p["funding_paid"] = str(int(p.get("funding_paid", "0")) + actual)
            margin_delta_total -= actual
        for pid in short_ids:
            p = positions[pid]
            delta = int(round(int(p["notional"]) * rate_short))
            old_margin = int(p["margin"])
            new_margin = max(0, old_margin - delta)
            actual = old_margin - new_margin
            p["margin"] = str(new_margin)
            p["funding_paid"] = str(int(p.get("funding_paid", "0")) + actual)
            margin_delta_total -= actual

        self.positions_json = json.dumps(positions)
        self.total_margin_locked = u256(max(0, int(self.total_margin_locked) + margin_delta_total))

        finfo["last_ts"] = now
        finfo["last_rate_bps"] = int(round(skew * int(market["funding_k_bps"])))
        funding[symbol] = finfo
        self.funding_json = json.dumps(funding)

        return {
            "symbol": symbol,
            "funding_rate_bps": finfo["last_rate_bps"],
            "long_notional": str(long_sum),
            "short_notional": str(short_sum),
            "positions_settled": len(long_ids) + len(short_ids),
        }

    @gl.public.write
    def touch_price(self, symbol: str) -> str:
        """Cheap helper: fetch & cache the live price for a symbol without opening a position.
        Useful for keepers/frontends to keep a fresh mark price for display & liquidation checks."""
        symbol = symbol.upper()
        markets = self._load(self.markets_json, {})
        market = markets.get(symbol)
        if not market:
            raise gl.vm.UserError("Unknown market")
        price = self._fetch_price(symbol, market["coingecko_id"])
        self._cache_price(symbol, price)
        return str(price)

    # ─── Views ───────────────────────────────────────────────────────

    @gl.public.view
    def get_owner(self) -> str:
        return self.owner

    @gl.public.view
    def get_market(self, symbol: str) -> dict[str, typing.Any]:
        markets = self._load(self.markets_json, {})
        m = markets.get(symbol.upper())
        return m if m else {"error": "not found"}

    @gl.public.view
    def get_all_markets(self) -> str:
        return self.markets_json

    @gl.public.view
    def get_position(self, position_id: u256) -> dict[str, typing.Any]:
        positions = self._load(self.positions_json, {})
        p = positions.get(str(int(position_id)))
        return p if p else {"error": "not found"}

    @gl.public.view
    def get_user_positions(self, addr: str) -> str:
        addr = addr.lower()
        positions = self._load(self.positions_json, {})
        result = [p for p in positions.values() if p.get("owner") == addr]
        return json.dumps(result)

    @gl.public.view
    def get_all_open_positions(self) -> str:
        positions = self._load(self.positions_json, {})
        result = [p for p in positions.values() if p.get("status") == "OPEN"]
        return json.dumps(result)

    @gl.public.view
    def get_open_positions_for_symbol(self, symbol: str) -> str:
        symbol = symbol.upper()
        positions = self._load(self.positions_json, {})
        result = [p for p in positions.values() if p.get("symbol") == symbol and p.get("status") == "OPEN"]
        return json.dumps(result)

    @gl.public.view
    def get_open_interest(self, symbol: str) -> dict[str, typing.Any]:
        oi = self._load(self.oi_json, {})
        return oi.get(symbol.upper(), {"long": "0", "short": "0"})

    @gl.public.view
    def get_vault_status(self) -> dict[str, typing.Any]:
        return {
            "vault_balance": str(self.vault_balance),
            "total_margin_locked": str(self.total_margin_locked),
            "free_balance": str(max(0, int(self.vault_balance) - int(self.total_margin_locked))),
            "protocol_fees_collected": str(self.protocol_fees_collected),
            "total_positions": int(self.total_positions),
        }

    @gl.public.view
    def get_mark_price(self, symbol: str) -> dict[str, typing.Any]:
        cache = self._load(self.price_cache_json, {})
        return cache.get(symbol.upper(), {"price": "0", "ts": 0})

    @gl.public.view
    def get_funding_info(self, symbol: str) -> dict[str, typing.Any]:
        funding = self._load(self.funding_json, {})
        return funding.get(symbol.upper(), {"last_ts": 0, "last_rate_bps": 0})

    @gl.public.view
    def estimate_position(self, position_id: u256) -> dict[str, typing.Any]:
        """Unrealized PnL & equity using the last cached mark price. Call touch_price(symbol)
        first (or open/close any position on that symbol) for a fresh read."""
        positions = self._load(self.positions_json, {})
        p = positions.get(str(int(position_id)))
        if not p:
            return {"error": "not found"}
        if p["status"] != "OPEN":
            return {"error": "position not open", "status": p["status"]}
        cache = self._load(self.price_cache_json, {})
        mark = cache.get(p["symbol"], {})
        mark_price = float(mark.get("price", "0"))
        if mark_price <= 0:
            return {"error": "no cached price yet, call touch_price first"}
        entry_price = float(p["entry_price"])
        margin = int(p["margin"])
        notional = int(p["notional"])
        pct = self._price_change_pct(entry_price, mark_price, p["direction"])
        pnl = notional * pct
        equity = margin + pnl
        roi_pct = round((pnl / margin) * 100, 2) if margin > 0 else 0.0
        return {
            "position_id": int(position_id),
            "mark_price": str(mark_price),
            "entry_price": str(entry_price),
            "unrealized_pnl": str(int(round(pnl))),
            "equity": str(max(0, int(round(equity)))),
            "liq_price_estimate": p.get("liq_price_estimate", "0"),
            "roi_pct": str(roi_pct),
        }
