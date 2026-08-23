# v1.0.0 — GenPredict: multi-asset parimutuel up/down prediction markets
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

# GenVM parses the two lines above as the "runner comment" and is strict about them:
# line 1 must START with the version token, the Depends line must come immediately
# after, and NO further comment may follow before the code — violating any of these
# fails deployment with a bare `invalid_contract` error.
#
# Zero gl.ContractState usage — ContractState writes are broken on GenLayer.
# All state lives in plain instance fields; nested data is JSON-encoded into strings.
#
# Never return a float from a public method or from a nondeterministic block: GenVM's
# calldata codec has no float type and aborts with `not calldata encodable ...: float`.

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


class PredictMarket(gl.Contract):
    """
    GenPredict — "will it be up or down in N minutes?" parimutuel markets.

    A market is one (asset, horizon) pair, e.g. BTC-5m. Each market runs a
    continuous chain of rounds. Two rounds are active at once, which is what
    removes dead time between rounds:

        NEXT  (OPEN)   — accepting bets, no price fixed yet
        LIVE  (LOCKED) — lock price fixed, counting down to close

    Lifecycle per round:
        start  ──betting_seconds──▶ lock ──horizon_seconds──▶ close
               bets accepted        lock_price fixed          close_price fixed

    A round predicts whether close_price > lock_price, so the horizon a user is
    betting on is exactly the advertised one (lock → close). The betting window
    sits *before* the horizon starts and is deliberately generous: GenLayer needs
    roughly a minute to reach consensus, so a bet sent in the last few seconds
    would not land. The frontend warns near the cutoff for the same reason.

    Payouts are parimutuel, like PancakeSwap Prediction: the whole pool minus a
    treasury fee is split across the winning side in proportion to stake. The
    resulting multiplier is therefore only known once betting closes, and moves
    as the pools fill. If close == lock the round is a DRAW and every bet is
    refundable in full, with no fee taken.

    The contract holds only what bettors put in — it is never the counterparty,
    so unlike the perp exchange there is no vault to keep solvent.
    """

    owner: str
    treasury: u256              # accumulated fees, withdrawable by owner
    total_bets_placed: u256
    total_volume: u256
    markets_json: str           # { "BTC-5m": {config...} }
    rounds_json: str            # { "BTC-5m": { "7": {round...} } }
    bets_json: str              # { "BTC-5m": { "7": { "0xaddr": {bet...} } } }
    pointers_json: str          # { "BTC-5m": {"next_id": 8, "live_id": 7, "last_id": 8} }
    history_limit: u256         # resolved rounds kept per market before pruning

    # ─── Construction ────────────────────────────────────────────────

    def __init__(self):
        self.owner = str(gl.message.sender_address).lower()
        self.treasury = u256(0)
        self.total_bets_placed = u256(0)
        self.total_volume = u256(0)
        self.history_limit = u256(40)

        # symbol, coingecko_id, horizon_seconds, betting_seconds, fee_bps, min_bet
        defaults = [
            ("BTC", "bitcoin", 300, 180, 300, "10000000000000000"),
            ("ETH", "ethereum", 300, 180, 300, "10000000000000000"),
            ("SOL", "solana", 300, 180, 300, "10000000000000000"),
            ("BTC", "bitcoin", 900, 300, 300, "10000000000000000"),
            ("ETH", "ethereum", 900, 300, 300, "10000000000000000"),
        ]
        markets: dict = {}
        for sym, cg, horizon, betting, fee, min_bet in defaults:
            key = f"{sym}-{horizon // 60}m"
            markets[key] = {
                "key": key,
                "symbol": sym,
                "coingecko_id": cg,
                "horizon_seconds": int(horizon),
                "betting_seconds": int(betting),
                "fee_bps": int(fee),
                "min_bet": str(min_bet),
                "enabled": 1,
            }
        self.markets_json = json.dumps(markets)
        self.rounds_json = "{}"
        self.bets_json = "{}"
        self.pointers_json = "{}"

    # ─── Internal helpers ───────────────────────────────────────────

    def _load(self, s: str, default: typing.Any) -> typing.Any:
        try:
            return json.loads(s) if s else default
        except Exception:
            return default

    def _require_owner(self) -> None:
        if str(gl.message.sender_address).lower() != self.owner:
            raise gl.vm.UserError("Only owner can call this")

    def _market(self, markets: dict, key: str) -> dict:
        m = markets.get(key)
        if not m:
            raise gl.vm.UserError(f"Unknown market: {key}")
        return m

    def _fetch_price(self, symbol: str, coingecko_id: str) -> float:
        """Live USD price agreed by validators through the Equivalence Principle.

        Sources are tried in order because a single one is not survivable: every
        validator fetches independently, so some get rate-limited, and a throttled
        CoinGecko answers 200 with an error body rather than an HTTP error. The
        agreement band is 0.5% since the leader and a validator may end up on
        different exchanges; live, the three sit within ~0.02% of each other.
        """
        binance_symbol = f"{symbol}USDT"
        coinbase_pair = f"{symbol}-USD"

        def leader_fn() -> str:
            sources = [
                (f"https://api.binance.com/api/v3/ticker/price?symbol={binance_symbol}",
                 lambda d: d.get("price")),
                (f"https://api.coingecko.com/api/v3/simple/price?ids={coingecko_id}&vs_currencies=usd",
                 lambda d: d.get(coingecko_id, {}).get("usd")),
                (f"https://api.coinbase.com/v2/prices/{coinbase_pair}/spot",
                 lambda d: d.get("data", {}).get("amount")),
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

    def _new_round(self, market: dict, round_id: int, start_ts: int) -> dict:
        return {
            "id": round_id,
            "market": market["key"],
            "start_ts": start_ts,
            "lock_ts": start_ts + int(market["betting_seconds"]),
            "close_ts": start_ts + int(market["betting_seconds"]) + int(market["horizon_seconds"]),
            "status": "OPEN",
            "lock_price": "",
            "close_price": "",
            "winner": "",
            "up_pool": "0",
            "down_pool": "0",
            "up_count": 0,
            "down_count": 0,
        }

    def _payout_for(self, rnd: dict, market: dict, side: str, amount: int) -> int:
        """Parimutuel share of the pool, or a full refund when the round is voided.

        A round is voided (settlement VOID) on an exact price tie, or whenever one
        side attracted no stake at all. That second case matters: with an empty
        losing side there is nobody to win from, so charging the fee would take
        money from a bet that had no counterparty — and with an empty *winning*
        side nobody could ever claim, which would strand the pool in the contract
        forever. Refunding everyone in full is the only settlement that is both
        fair and leaves no funds behind.
        """
        if rnd.get("settlement", "PAID") == "VOID":
            return amount
        winner = rnd.get("winner", "")
        if side != winner:
            return 0
        up_pool = int(rnd.get("up_pool", "0"))
        down_pool = int(rnd.get("down_pool", "0"))
        total = up_pool + down_pool
        winner_pool = up_pool if winner == "UP" else down_pool
        if winner_pool <= 0:
            return 0
        fee = total * int(market["fee_bps"]) // 10000
        distributable = total - fee
        return amount * distributable // winner_pool

    def _prune(self, rounds: dict, bets: dict, market_key: str) -> None:
        """Keep state bounded. Every write re-serialises these blobs, so unbounded
        history would make each bet progressively more expensive. Winnings must be
        claimed within history_limit rounds — surfaced in the UI as a claim deadline."""
        limit = int(self.history_limit)
        mrounds = rounds.get(market_key, {})
        resolved = sorted(
            (int(rid) for rid, r in mrounds.items() if r.get("status") == "RESOLVED"),
            reverse=True,
        )
        for rid in resolved[limit:]:
            mrounds.pop(str(rid), None)
            bets.get(market_key, {}).pop(str(rid), None)

    # ─── Admin ───────────────────────────────────────────────────────

    @gl.public.write
    def add_market(self, symbol: str, coingecko_id: str, horizon_seconds: u256,
                   betting_seconds: u256, fee_bps: u256, min_bet: u256) -> str:
        """Register or reconfigure a market. Key is derived, e.g. BTC + 300s -> "BTC-5m"."""
        self._require_owner()
        symbol = symbol.upper()
        horizon = int(horizon_seconds)
        betting = int(betting_seconds)
        fee = int(fee_bps)
        mb = int(min_bet)

        if horizon < 60:
            raise gl.vm.UserError("horizon_seconds must be at least 60")
        # A bet needs to clear consensus before the lock, which takes ~1 minute.
        if betting < 90:
            raise gl.vm.UserError("betting_seconds must be at least 90 so bets can reach consensus")
        if fee > 1000:
            raise gl.vm.UserError("fee_bps too high (max 1000 = 10%)")
        if mb == 0:
            raise gl.vm.UserError("min_bet must be > 0")
        if not coingecko_id or len(coingecko_id) > 64:
            raise gl.vm.UserError("Invalid coingecko_id")

        key = f"{symbol}-{horizon // 60}m"
        markets = self._load(self.markets_json, {})
        markets[key] = {
            "key": key,
            "symbol": symbol,
            "coingecko_id": coingecko_id,
            "horizon_seconds": horizon,
            "betting_seconds": betting,
            "fee_bps": fee,
            "min_bet": str(mb),
            "enabled": 1,
        }
        self.markets_json = json.dumps(markets)
        return key

    @gl.public.write
    def set_market_enabled(self, market_key: str, enabled: u256) -> None:
        """Stop or resume new rounds (1=on, 0=off). Rounds already running finish normally."""
        self._require_owner()
        markets = self._load(self.markets_json, {})
        self._market(markets, market_key)
        markets[market_key]["enabled"] = 1 if int(enabled) != 0 else 0
        self.markets_json = json.dumps(markets)

    @gl.public.write
    def set_history_limit(self, limit: u256) -> None:
        self._require_owner()
        v = int(limit)
        if v < 5 or v > 200:
            raise gl.vm.UserError("history_limit must be between 5 and 200")
        self.history_limit = u256(v)

    @gl.public.write
    def transfer_ownership(self, new_owner: str) -> None:
        self._require_owner()
        self.owner = new_owner.lower()

    @gl.public.write
    def withdraw_treasury(self, amount: u256) -> None:
        """Withdraw accumulated fees. Cannot touch bettors' stakes — treasury only
        grows when a round resolves, and only by the fee taken from that pool."""
        self._require_owner()
        amt = int(amount)
        if amt <= 0 or amt > int(self.treasury):
            raise gl.vm.UserError(f"Cannot withdraw more than treasury ({int(self.treasury)} wei)")
        self.treasury -= u256(amt)
        _Recipient(gl.message.sender_address).emit_transfer(value=u256(amt))

    # ─── Round lifecycle (permissionless keeper actions) ─────────────

    @gl.public.write
    def start_round(self, market_key: str) -> dict[str, typing.Any]:
        """Open the first betting round for a market. Later rounds open automatically
        when the previous one locks, so this is only needed to bootstrap or restart."""
        markets = self._load(self.markets_json, {})
        market = self._market(markets, market_key)
        if int(market.get("enabled", 0)) != 1:
            raise gl.vm.UserError("Market is disabled")

        pointers = self._load(self.pointers_json, {})
        ptr = pointers.get(market_key, {"next_id": 0, "live_id": 0, "last_id": 0})
        rounds = self._load(self.rounds_json, {})
        mrounds = rounds.get(market_key, {})

        existing = mrounds.get(str(ptr.get("next_id", 0)))
        if existing and existing.get("status") == "OPEN":
            raise gl.vm.UserError("A betting round is already open")

        now = int(time.time())
        rid = int(ptr.get("last_id", 0)) + 1
        mrounds[str(rid)] = self._new_round(market, rid, now)
        rounds[market_key] = mrounds
        ptr["next_id"] = rid
        ptr["last_id"] = rid
        pointers[market_key] = ptr

        self.rounds_json = json.dumps(rounds)
        self.pointers_json = json.dumps(pointers)
        return {"market": market_key, "round_id": rid, "lock_ts": mrounds[str(rid)]["lock_ts"]}

    @gl.public.write
    def lock_round(self, market_key: str) -> dict[str, typing.Any]:
        """Fix the lock price for the open round and immediately open the next one,
        so betting never pauses. Callable by anyone once lock_ts has passed."""
        markets = self._load(self.markets_json, {})
        market = self._market(markets, market_key)
        pointers = self._load(self.pointers_json, {})
        ptr = pointers.get(market_key, {"next_id": 0, "live_id": 0, "last_id": 0})
        rounds = self._load(self.rounds_json, {})
        mrounds = rounds.get(market_key, {})

        rid = int(ptr.get("next_id", 0))
        rnd = mrounds.get(str(rid))
        if not rnd or rnd.get("status") != "OPEN":
            raise gl.vm.UserError("No open round to lock")
        now = int(time.time())
        if now < int(rnd["lock_ts"]):
            raise gl.vm.UserError(f"Not lockable yet, {int(rnd['lock_ts']) - now}s remaining")

        price = self._fetch_price(market["symbol"], market["coingecko_id"])
        rnd["lock_price"] = str(price)
        rnd["status"] = "LOCKED"
        # Anchor the horizon to the actual lock, not the schedule: consensus latency
        # means this transaction lands somewhat after lock_ts, and the advertised
        # horizon should be measured from the price that was actually fixed.
        rnd["close_ts"] = now + int(market["horizon_seconds"])
        mrounds[str(rid)] = rnd
        ptr["live_id"] = rid

        opened = 0
        if int(market.get("enabled", 0)) == 1:
            new_id = int(ptr.get("last_id", 0)) + 1
            mrounds[str(new_id)] = self._new_round(market, new_id, now)
            ptr["next_id"] = new_id
            ptr["last_id"] = new_id
            opened = new_id

        rounds[market_key] = mrounds
        pointers[market_key] = ptr
        self.rounds_json = json.dumps(rounds)
        self.pointers_json = json.dumps(pointers)
        return {
            "market": market_key,
            "locked_round": rid,
            "lock_price": str(price),
            "close_ts": rnd["close_ts"],
            "opened_round": opened,
        }

    @gl.public.write
    def resolve_round(self, market_key: str, round_id: u256) -> dict[str, typing.Any]:
        """Fix the close price and decide the winner. Callable by anyone after close_ts."""
        markets = self._load(self.markets_json, {})
        market = self._market(markets, market_key)
        rounds = self._load(self.rounds_json, {})
        mrounds = rounds.get(market_key, {})
        rid = str(int(round_id))
        rnd = mrounds.get(rid)
        if not rnd:
            raise gl.vm.UserError("Round not found")
        if rnd.get("status") != "LOCKED":
            raise gl.vm.UserError(f"Round is {rnd.get('status')}, expected LOCKED")
        now = int(time.time())
        if now < int(rnd["close_ts"]):
            raise gl.vm.UserError(f"Not closable yet, {int(rnd['close_ts']) - now}s remaining")

        price = self._fetch_price(market["symbol"], market["coingecko_id"])
        lock_price = float(rnd["lock_price"])
        if price > lock_price:
            winner = "UP"
        elif price < lock_price:
            winner = "DOWN"
        else:
            winner = "DRAW"

        up_pool = int(rnd["up_pool"])
        down_pool = int(rnd["down_pool"])
        total = up_pool + down_pool

        # Void the round unless both sides actually had money on it — see _payout_for.
        one_sided = up_pool == 0 or down_pool == 0
        settlement = "VOID" if (winner == "DRAW" or one_sided) else "PAID"

        rnd["close_price"] = str(price)
        rnd["winner"] = winner
        rnd["settlement"] = settlement
        rnd["status"] = "RESOLVED"
        mrounds[rid] = rnd

        fee = 0
        if settlement == "PAID":
            fee = total * int(market["fee_bps"]) // 10000
            self.treasury += u256(fee)

        rounds[market_key] = mrounds
        bets = self._load(self.bets_json, {})
        self._prune(rounds, bets, market_key)
        self.rounds_json = json.dumps(rounds)
        self.bets_json = json.dumps(bets)

        return {
            "market": market_key,
            "round_id": int(round_id),
            "lock_price": rnd["lock_price"],
            "close_price": str(price),
            "winner": winner,
            "settlement": settlement,
            "fee": str(fee),
        }

    # ─── Betting ─────────────────────────────────────────────────────

    @gl.public.write.payable
    def bet(self, market_key: str, side: str) -> dict[str, typing.Any]:
        """Back UP or DOWN on the market's open round with the attached GEN."""
        side = side.upper()
        if side not in ("UP", "DOWN"):
            raise gl.vm.UserError("side must be UP or DOWN")

        markets = self._load(self.markets_json, {})
        market = self._market(markets, market_key)
        pointers = self._load(self.pointers_json, {})
        ptr = pointers.get(market_key, {})
        rounds = self._load(self.rounds_json, {})
        mrounds = rounds.get(market_key, {})

        rid = str(int(ptr.get("next_id", 0)))
        rnd = mrounds.get(rid)
        if not rnd or rnd.get("status") != "OPEN":
            raise gl.vm.UserError("No round is open for betting")

        now = int(time.time())
        if now >= int(rnd["lock_ts"]):
            raise gl.vm.UserError("Betting has closed for this round")

        amount = int(gl.message.value)
        if amount < int(market["min_bet"]):
            raise gl.vm.UserError(f"Bet must be at least {market['min_bet']} wei")

        player = str(gl.message.sender_address).lower()
        bets = self._load(self.bets_json, {})
        mbets = bets.get(market_key, {})
        rbets = mbets.get(rid, {})
        existing = rbets.get(player)
        if existing:
            # Betting both ways in one round would just burn the fee, and topping up
            # silently would change a payout the user already saw. Reject instead.
            raise gl.vm.UserError(f"Already bet {existing['side']} on this round")

        rbets[player] = {"side": side, "amount": str(amount), "claimed": 0}
        mbets[rid] = rbets
        bets[market_key] = mbets

        if side == "UP":
            rnd["up_pool"] = str(int(rnd["up_pool"]) + amount)
            rnd["up_count"] = int(rnd["up_count"]) + 1
        else:
            rnd["down_pool"] = str(int(rnd["down_pool"]) + amount)
            rnd["down_count"] = int(rnd["down_count"]) + 1
        mrounds[rid] = rnd
        rounds[market_key] = mrounds

        self.rounds_json = json.dumps(rounds)
        self.bets_json = json.dumps(bets)
        self.total_bets_placed += u256(1)
        self.total_volume += u256(amount)

        return {
            "market": market_key,
            "round_id": int(rid),
            "side": side,
            "amount": str(amount),
            "lock_ts": int(rnd["lock_ts"]),
        }

    @gl.public.write
    def claim(self, market_key: str, round_id: u256) -> dict[str, typing.Any]:
        """Collect winnings (or a DRAW refund) for one resolved round."""
        markets = self._load(self.markets_json, {})
        market = self._market(markets, market_key)
        rounds = self._load(self.rounds_json, {})
        rid = str(int(round_id))
        rnd = rounds.get(market_key, {}).get(rid)
        if not rnd:
            raise gl.vm.UserError("Round not found (it may have been pruned)")
        if rnd.get("status") != "RESOLVED":
            raise gl.vm.UserError("Round is not resolved yet")

        player = str(gl.message.sender_address).lower()
        bets = self._load(self.bets_json, {})
        rbets = bets.get(market_key, {}).get(rid, {})
        bet = rbets.get(player)
        if not bet:
            raise gl.vm.UserError("No bet found for this round")
        if int(bet.get("claimed", 0)) == 1:
            raise gl.vm.UserError("Already claimed")

        payout = self._payout_for(rnd, market, bet["side"], int(bet["amount"]))
        if payout <= 0:
            raise gl.vm.UserError("Nothing to claim — this bet did not win")
        refunded = rnd.get("settlement", "PAID") == "VOID"

        bet["claimed"] = 1
        rbets[player] = bet
        bets[market_key][rid] = rbets
        self.bets_json = json.dumps(bets)

        _Recipient(gl.message.sender_address).emit_transfer(value=u256(payout))
        return {
            "market": market_key,
            "round_id": int(round_id),
            "payout": str(payout),
            "refund": 1 if refunded else 0,
        }

    # ─── Views ───────────────────────────────────────────────────────

    @gl.public.view
    def get_owner(self) -> str:
        return self.owner

    @gl.public.view
    def get_all_markets(self) -> str:
        return self.markets_json

    @gl.public.view
    def get_stats(self) -> dict[str, typing.Any]:
        return {
            "total_bets_placed": int(self.total_bets_placed),
            "total_volume": str(self.total_volume),
            "treasury": str(self.treasury),
            "history_limit": int(self.history_limit),
        }

    def _round_view(self, rnd: dict, market: dict) -> dict:
        """Round plus the derived numbers the UI would otherwise recompute:
        the parimutuel multipliers, which are the headline number on every card."""
        up_pool = int(rnd.get("up_pool", "0"))
        down_pool = int(rnd.get("down_pool", "0"))
        total = up_pool + down_pool
        fee_bps = int(market["fee_bps"])
        distributable = total - (total * fee_bps // 10000)
        # x100 integers: floats are not calldata-encodable, and the UI wants 2 decimals.
        #
        # While one side is still empty the round would settle as VOID, so the honest
        # figure is a 1.00x refund. Deriving it from the pool instead would advertise
        # something below 1x — a number that can never actually be paid.
        if up_pool == 0 or down_pool == 0:
            up_x100 = 100 if up_pool > 0 else 0
            down_x100 = 100 if down_pool > 0 else 0
        else:
            up_x100 = distributable * 100 // up_pool
            down_x100 = distributable * 100 // down_pool
        return {
            "id": int(rnd["id"]),
            "market": rnd["market"],
            "status": rnd["status"],
            "start_ts": int(rnd["start_ts"]),
            "lock_ts": int(rnd["lock_ts"]),
            "close_ts": int(rnd["close_ts"]),
            "lock_price": rnd.get("lock_price", ""),
            "close_price": rnd.get("close_price", ""),
            "winner": rnd.get("winner", ""),
            "settlement": rnd.get("settlement", ""),
            "up_pool": str(up_pool),
            "down_pool": str(down_pool),
            "total_pool": str(total),
            "up_count": int(rnd.get("up_count", 0)),
            "down_count": int(rnd.get("down_count", 0)),
            "up_multiplier_x100": up_x100,
            "down_multiplier_x100": down_x100,
        }

    @gl.public.view
    def get_home(self) -> str:
        """Everything the home page needs, in ONE call.

        The Studio RPC allows only ~30 requests/minute across all clients, so a page
        that fetched each market separately would break itself as markets are added.
        """
        markets = self._load(self.markets_json, {})
        rounds = self._load(self.rounds_json, {})
        pointers = self._load(self.pointers_json, {})
        out = []
        for key, market in markets.items():
            ptr = pointers.get(key, {})
            mrounds = rounds.get(key, {})
            nxt = mrounds.get(str(ptr.get("next_id", 0)))
            # The card has room for one live round, so show the one settling soonest
            # rather than whichever locked most recently.
            live_ids = sorted(int(rid) for rid, r in mrounds.items() if r.get("status") == "LOCKED")
            live = mrounds.get(str(live_ids[0])) if live_ids else None
            entry = {
                "key": key,
                "symbol": market["symbol"],
                "horizon_seconds": int(market["horizon_seconds"]),
                "betting_seconds": int(market["betting_seconds"]),
                "fee_bps": int(market["fee_bps"]),
                "min_bet": market["min_bet"],
                "enabled": int(market.get("enabled", 0)),
                "next_round": self._round_view(nxt, market) if nxt else None,
                "live_round": self._round_view(live, market) if live else None,
            }
            out.append(entry)
        return json.dumps(out)

    @gl.public.view
    def get_market_detail(self, market_key: str, history: u256) -> str:
        """Market config + next round + live round + recent resolved rounds, in one call."""
        markets = self._load(self.markets_json, {})
        market = markets.get(market_key)
        if not market:
            return json.dumps({"error": "not found"})
        rounds = self._load(self.rounds_json, {})
        pointers = self._load(self.pointers_json, {})
        ptr = pointers.get(market_key, {})
        mrounds = rounds.get(market_key, {})

        nxt = mrounds.get(str(ptr.get("next_id", 0)))
        want = max(0, min(int(history), 50))
        resolved_ids = sorted(
            (int(rid) for rid, r in mrounds.items() if r.get("status") == "RESOLVED"),
            reverse=True,
        )[:want]

        # Every locked round, not just the latest. Whenever the horizon is longer than
        # the betting window — the normal case — several rounds are mid-flight at once,
        # and showing only the newest would hide rounds the user still has money in.
        live_ids = sorted(int(rid) for rid, r in mrounds.items() if r.get("status") == "LOCKED")
        live_views = [self._round_view(mrounds[str(rid)], market) for rid in live_ids]

        return json.dumps({
            "market": market,
            "next_round": self._round_view(nxt, market) if nxt else None,
            "live_rounds": live_views,
            # Settling soonest, which is the one a user is watching most closely.
            "live_round": live_views[0] if live_views else None,
            "history": [self._round_view(mrounds[str(rid)], market) for rid in resolved_ids],
        })

    def _user_bets(self, addr: str, market_key: str) -> list:
        """Shared by get_user_bets and get_user_portfolio. Kept separate from the
        public views so one never calls the other through its decorator."""
        addr = addr.lower()
        markets = self._load(self.markets_json, {})
        market = markets.get(market_key)
        if not market:
            return []
        rounds = self._load(self.rounds_json, {})
        mrounds = rounds.get(market_key, {})
        mbets = self._load(self.bets_json, {}).get(market_key, {})

        out = []
        for rid, rbets in mbets.items():
            bet = rbets.get(addr)
            if not bet:
                continue
            rnd = mrounds.get(rid)
            if not rnd:
                continue
            status = rnd.get("status", "")
            winner = rnd.get("winner", "")
            claimed = int(bet.get("claimed", 0)) == 1
            payout = 0
            if status == "RESOLVED":
                payout = self._payout_for(rnd, market, bet["side"], int(bet["amount"]))
            if status != "RESOLVED":
                state = "LIVE" if status == "LOCKED" else "PENDING"
            elif payout <= 0:
                state = "LOST"
            elif claimed:
                state = "CLAIMED"
            elif rnd.get("settlement") == "VOID":
                state = "REFUNDABLE"
            else:
                state = "CLAIMABLE"
            out.append({
                "market": market_key,
                "round_id": int(rid),
                "side": bet["side"],
                "amount": bet["amount"],
                "status": status,
                "winner": winner,
                "settlement": rnd.get("settlement", ""),
                "lock_price": rnd.get("lock_price", ""),
                "close_price": rnd.get("close_price", ""),
                "payout": str(payout),
                "state": state,
            })
        out.sort(key=lambda b: b["round_id"], reverse=True)
        return out

    @gl.public.view
    def get_user_bets(self, addr: str, market_key: str) -> str:
        """A user's bets on one market, with payout and claim state already worked out."""
        return json.dumps(self._user_bets(addr, market_key))

    @gl.public.view
    def get_user_portfolio(self, addr: str) -> str:
        """Every market's bets for one user — one call for the portfolio page."""
        markets = self._load(self.markets_json, {})
        out = []
        for key in markets.keys():
            out.extend(self._user_bets(addr, key))
        out.sort(key=lambda b: b["round_id"], reverse=True)
        return json.dumps(out)

    @gl.public.view
    def get_round(self, market_key: str, round_id: u256) -> dict[str, typing.Any]:
        markets = self._load(self.markets_json, {})
        market = markets.get(market_key)
        if not market:
            return {"error": "market not found"}
        rnd = self._load(self.rounds_json, {}).get(market_key, {}).get(str(int(round_id)))
        if not rnd:
            return {"error": "round not found"}
        return self._round_view(rnd, market)

    @gl.public.view
    def get_pending_actions(self) -> str:
        """What the keeper should do right now, decided on-chain in a single call:
        which markets need starting, locking, or resolving."""
        markets = self._load(self.markets_json, {})
        rounds = self._load(self.rounds_json, {})
        pointers = self._load(self.pointers_json, {})
        now = int(time.time())
        actions = []
        for key, market in markets.items():
            if int(market.get("enabled", 0)) != 1:
                continue
            ptr = pointers.get(key, {})
            mrounds = rounds.get(key, {})
            nxt = mrounds.get(str(ptr.get("next_id", 0)))
            if not nxt or nxt.get("status") != "OPEN":
                actions.append({"action": "start_round", "market": key, "round_id": 0})
            elif now >= int(nxt["lock_ts"]):
                actions.append({"action": "lock_round", "market": key, "round_id": int(nxt["id"])})
            for rid, rnd in mrounds.items():
                if rnd.get("status") == "LOCKED" and now >= int(rnd["close_ts"]):
                    actions.append({"action": "resolve_round", "market": key, "round_id": int(rid)})
        return json.dumps(actions)
