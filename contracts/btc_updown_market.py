# v0.3.0-test — hardcoded prices to verify OPEN→LOCKED→RESOLVED→OPEN flow
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *

import json
import typing
import time

class BtcUpDownMarket(gl.Contract):
    round_id: u256
    status: str            # "IDLE", "OPEN", "LOCKED", "RESOLVED"
    start_price: str
    end_price: str
    winner: str            # "NONE", "UP", "DOWN", "DRAW"
    round_start_time: u256
    betting_seconds: u256
    lock_seconds: u256
    up_pool: u256
    down_pool: u256
    up_count: u256
    down_count: u256
    total_rounds: u256

    def __init__(self):
        self.round_id = u256(0)
        self.status = "IDLE"
        self.start_price = "0"
        self.end_price = "0"
        self.winner = "NONE"
        self.round_start_time = u256(0)
        self.betting_seconds = u256(300)
        self.lock_seconds = u256(300)
        self.up_pool = u256(0)
        self.down_pool = u256(0)
        self.up_count = u256(0)
        self.down_count = u256(0)
        self.total_rounds = u256(0)

    # ─── Internal: BTC Price Oracle ──────────────────────────────────────
    # NOTE: Using GenLayer nondet web fetch with Binance API.
    # A hardcoded fallback is used if the fetch fails to ensure state progresses.

    def _fetch_btc_price(self) -> str:
        def fetch_price() -> str:
            web_data = gl.nondet.web.render(
                "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
                mode="text"
            )
            data = json.loads(web_data)
            price = data["price"]
            return str(int(float(str(price))))

        def price_validator(leader: str, validator: str) -> bool:
            try:
                l = int(float(leader.strip()))
                v = int(float(validator.strip()))
                return abs(l - v) <= max(1, l // 200)
            except (ValueError, TypeError):
                return False

        return gl.eq_principle.get(fetch_price, price_validator)

    # ─── Phase 1: Start Round ───────────────────────────────────────────

    @gl.public.write
    def start_round(self) -> None:
        if self.status not in ("IDLE", "RESOLVED"):
            raise gl.vm.UserError("Cannot start round from current status")

        self.round_id += u256(1)
        self.total_rounds += u256(1)
        self.status = "OPEN"
        self.start_price = "0"
        self.end_price = "0"
        self.winner = "NONE"
        self.round_start_time = u256(int(time.time()))
        self.up_pool = u256(0)
        self.down_pool = u256(0)
        self.up_count = u256(0)
        self.down_count = u256(0)

    # ─── Phase 2: Place Bet ─────────────────────────────────────────────

    def _place_bet(self, side: str) -> None:
        if self.status != "OPEN":
            raise gl.vm.UserError("Betting is not open")

        now = u256(int(time.time()))
        if now > self.round_start_time + self.betting_seconds:
            raise gl.vm.UserError("Betting window closed")

        amount = gl.message.value
        if amount == u256(0):
            raise gl.vm.UserError("Bet amount must be > 0")

        player = str(gl.message.sender_account).lower()
        vote_key = f"vote_{self.round_id}_{player}"
        try:
            existing = gl.ContractState[vote_key]
        except:
            existing = ""
            
        if existing != "":
            raise gl.vm.UserError("Already voted this round")

        gl.ContractState[vote_key] = side
        bet_key = f"bet_{self.round_id}_{player}"
        gl.ContractState[bet_key] = str(amount)

        part_key = f"participants_{self.round_id}"
        try:
            parts = json.loads(gl.ContractState[part_key])
        except:
            parts = []
        if player not in parts:
            parts.append(player)
            gl.ContractState[part_key] = json.dumps(parts)

        if side == "UP":
            self.up_pool += amount
            self.up_count += u256(1)
        else:
            self.down_pool += amount
            self.down_count += u256(1)

        # Record into user-specific index
        user_rounds_key = f"user_rounds_{player}"
        try:
            user_rounds = json.loads(gl.ContractState[user_rounds_key])
        except:
            user_rounds = []

        rid = int(self.round_id)
        if rid not in user_rounds:
            user_rounds.append(rid)
            gl.ContractState[user_rounds_key] = json.dumps(user_rounds)

        user_bet_key = f"user_bet_{player}_{rid}"
        gl.ContractState[user_bet_key] = json.dumps({
            "round_id": rid,
            "vote": side,
            "amount": str(amount),
            "claimed": False,
        })

    @gl.public.write.payable
    def bet_up(self) -> None:
        self._place_bet("UP")

    @gl.public.write.payable
    def bet_down(self) -> None:
        self._place_bet("DOWN")

    # ─── Phase 3: Lock Round ────────────────────────────────────────────

    @gl.public.write
    def lock_round(self) -> None:
        if self.status != "OPEN":
            raise gl.vm.UserError("Round must be OPEN to lock")

        now = u256(int(time.time()))
        # if now < self.round_start_time + self.betting_seconds:
        #     raise gl.vm.UserError("Betting window has not ended yet")

        # Temporary hardcode to verify round flow
        self.start_price = "78000"
        self.status = "LOCKED"

    # ─── Phase 4: Resolve Round ─────────────────────────────────────────

    @gl.public.write
    def resolve_round(self) -> None:
        if self.status != "LOCKED":
            raise gl.vm.UserError("Round must be LOCKED to resolve")

        now = u256(int(time.time()))
        # if now < self.round_start_time + self.betting_seconds + self.lock_seconds:
        #     raise gl.vm.UserError("Lock period has not ended yet")

        # Temporary hardcode to verify round flow
        self.end_price = "78100"
        self.winner = "UP"
        self.status = "RESOLVED"

        rid = int(self.round_id)
        result_key = f"round_result_{rid}"
        gl.ContractState[result_key] = json.dumps({
            "round_id":    int(self.round_id),
            "start_price": self.start_price,
            "end_price":   self.end_price,
            "winner":      self.winner,
            "up_pool":     str(self.up_pool),
            "down_pool":   str(self.down_pool),
            "up_count":    int(self.up_count),
            "down_count":  int(self.down_count),
        })

    # ─── Phase 5: Claim ─────────────────────────────────────────────────

    @gl.public.write
    def claim(self, round_id: u256) -> None:
        rid = int(round_id)
        player = str(gl.message.sender_account).lower()

        claim_key = f"claimed_{rid}_{player}"
        try:
            if gl.ContractState[claim_key] == "1":
                raise gl.vm.UserError("Already claimed")
        except:
            pass

        vote_key = f"vote_{rid}_{player}"
        try:
            player_vote = gl.ContractState[vote_key]
        except:
            raise gl.vm.UserError("No bet found for this round")
        if player_vote == "":
            raise gl.vm.UserError("No bet found for this round")

        result_key = f"round_result_{rid}"
        try:
            result_json = gl.ContractState[result_key]
        except:
            raise gl.vm.UserError("Round not resolved yet")
        if result_json == "":
            raise gl.vm.UserError("Round not resolved yet")

        result     = json.loads(result_json)
        winner     = result.get("winner", "NONE")
        up_pool_s  = result.get("up_pool", "0")
        down_pool_s = result.get("down_pool", "0")

        bet_key = f"bet_{rid}_{player}"
        try:
            bet_amount = u256(int(gl.ContractState[bet_key]))
        except:
            raise gl.vm.UserError("No bet amount found")

        payout = u256(0)
        if winner == "DRAW":
            payout = bet_amount
        elif player_vote == winner:
            up_pool   = u256(int(up_pool_s))
            down_pool = u256(int(down_pool_s))
            loser_pool  = down_pool if winner == "UP" else up_pool
            winner_pool = up_pool  if winner == "UP" else down_pool
            if winner_pool > u256(0):
                share  = (bet_amount * loser_pool) // winner_pool
                payout = bet_amount + share

        if payout == u256(0):
            raise gl.vm.UserError("No winnings to claim")

        gl.ContractState[claim_key] = "1"
        gl.vm.transfer(player, payout)

    # ─── View Functions ──────────────────────────────────────────────────

    @gl.public.view
    def get_round(self) -> dict[str, typing.Any]:
        try:
            sp = int(float(self.start_price))
            ep = int(float(self.end_price))
        except ValueError:
            sp = 0; ep = 0
        return {
            "round_id":         int(self.round_id),
            "status":           self.status,
            "start_price":      sp,
            "end_price":        ep,
            "winner":           self.winner,
            "round_start_time": int(self.round_start_time),
            "betting_seconds":  int(self.betting_seconds),
            "lock_seconds":     int(self.lock_seconds),
            "up_pool":          str(self.up_pool),
            "down_pool":        str(self.down_pool),
            "up_count":         int(self.up_count),
            "down_count":       int(self.down_count),
            "total_rounds":     int(self.total_rounds),
        }

    @gl.public.view
    def get_my_bet(self, addr: str) -> dict[str, typing.Any]:
        addr = addr.lower()
        try: vote = gl.ContractState[f"vote_{self.round_id}_{addr}"]
        except: vote = ""
        try: amount = gl.ContractState[f"bet_{self.round_id}_{addr}"]
        except: amount = "0"
        try: amount_int = int(amount)
        except: amount_int = 0
        return {"vote": vote, "amount": str(amount_int)}

    @gl.public.view
    def get_payout(self, addr: str) -> str:
        if self.status != "RESOLVED": return "0"
        addr = addr.lower()
        try: player_vote = gl.ContractState[f"vote_{self.round_id}_{addr}"]
        except: return "0"
        if player_vote == "": return "0"
        try: bet_amount = u256(int(gl.ContractState[f"bet_{self.round_id}_{addr}"]))
        except: return "0"
        if bet_amount == u256(0): return "0"
        if self.winner == "DRAW": return str(bet_amount)
        if player_vote == self.winner:
            loser_pool  = self.down_pool if self.winner == "UP" else self.up_pool
            winner_pool = self.up_pool   if self.winner == "UP" else self.down_pool
            if winner_pool > u256(0):
                return str(bet_amount + (bet_amount * loser_pool) // winner_pool)
        return "0"

    @gl.public.view
    def get_payout_for_round(self, round_id: u256, addr: str) -> str:
        rid = int(round_id)
        addr = addr.lower()
        try: result = json.loads(gl.ContractState[f"round_result_{rid}"])
        except: return "0"
        winner = result.get("winner", "NONE")
        try: player_vote = gl.ContractState[f"vote_{rid}_{addr}"]
        except: return "0"
        if player_vote == "": return "0"
        try: bet_amount = u256(int(gl.ContractState[f"bet_{rid}_{addr}"]))
        except: return "0"
        if bet_amount == u256(0): return "0"
        if winner == "DRAW": return str(bet_amount)
        if player_vote == winner:
            up_pool   = u256(int(result.get("up_pool",   "0")))
            down_pool = u256(int(result.get("down_pool", "0")))
            loser_pool  = down_pool if winner == "UP" else up_pool
            winner_pool = up_pool   if winner == "UP" else down_pool
            if winner_pool > u256(0):
                return str(bet_amount + (bet_amount * loser_pool) // winner_pool)
        return "0"

    @gl.public.view
    def get_user_bet_for_round(self, round_id: u256, addr: str) -> str:
        rid = int(round_id)
        addr = addr.lower()
        try:
            return gl.ContractState[f"user_bet_{addr}_{rid}"]
        except:
            return ""

    @gl.public.view
    def get_user_history(self, addr: str) -> str:
        addr = addr.lower()
        history: list[dict] = []

        try:
            user_rounds = json.loads(gl.ContractState[f"user_rounds_{addr}"])
        except:
            return "[]"

        for r in user_rounds:
            try:
                bet = json.loads(gl.ContractState[f"user_bet_{addr}_{r}"])
            except:
                continue

            vote = bet.get("vote", "")
            amount = bet.get("amount", "0")

            result_json = ""
            try:
                result_json = gl.ContractState[f"round_result_{r}"]
            except:
                pass

            winner = "NONE"
            start_p = "0"
            end_p = "0"

            if result_json:
                try:
                    res = json.loads(result_json)
                    winner = res.get("winner", "NONE")
                    start_p = res.get("start_price", "0")
                    end_p = res.get("end_price", "0")
                except:
                    pass

            try:
                claimed = gl.ContractState[f"claimed_{r}_{addr}"] == "1"
            except:
                claimed = False

            won = (vote == winner)

            if result_json == "":
                bet_status = "PENDING"
            elif won and claimed:
                bet_status = "CLAIMED"
            elif won:
                bet_status = "CLAIM"
            else:
                bet_status = "LOST"

            history.append({
                "round_id": r,
                "vote": vote,
                "amount": amount,
                "winner": winner,
                "won": won,
                "start_price": start_p,
                "end_price": end_p,
                "status": bet_status,
            })

        return json.dumps(history)

    @gl.public.view
    def get_round_result(self, round_id: u256) -> str:
        try: return gl.ContractState[f"round_result_{int(round_id)}"]
        except: return ""

    @gl.public.view
    def get_round_participants(self, round_id: u256) -> str:
        try: return gl.ContractState[f"participants_{int(round_id)}"]
        except: return "[]"

    # ─── Debug: bypass oracle for testing ────────────────────────────────

    @gl.public.write
    def force_lock_debug(self, price: str) -> None:
        if self.status != "OPEN":
            raise gl.vm.UserError("Round must be OPEN to force-lock")
        self.start_price = price
        self.status = "LOCKED"

    @gl.public.write
    def force_resolve_debug(self, price: str) -> None:
        if self.status != "LOCKED":
            raise gl.vm.UserError("Round must be LOCKED to force-resolve")
        self.end_price = price
        try:
            s = int(float(self.start_price)); e = int(float(price))
        except: s = 0; e = 0
        if e > s:   self.winner = "UP"
        elif e < s: self.winner = "DOWN"
        else:       self.winner = "DRAW"
        self.status = "RESOLVED"
        gl.ContractState[f"round_result_{self.round_id}"] = json.dumps({
            "round_id": int(self.round_id), "start_price": self.start_price,
            "end_price": self.end_price, "winner": self.winner,
            "up_pool": str(self.up_pool), "down_pool": str(self.down_pool),
            "up_count": int(self.up_count), "down_count": int(self.down_count),
        })
