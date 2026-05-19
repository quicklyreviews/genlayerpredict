# v0.5.0 — zero ContractState. All storage in regular fields (ContractState writes broken on GenLayer)
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

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

class BtcUpDownMarket(gl.Contract):
    round_id: u256
    status: str
    start_price: str
    end_price: str
    winner: str
    round_start_time: u256
    betting_seconds: u256
    lock_seconds: u256
    up_pool: u256
    down_pool: u256
    up_count: u256
    down_count: u256
    total_rounds: u256
    last_result: str
    all_results: str
    all_bets: str

    def __init__(self):
        self.round_id = u256(0)
        self.status = "IDLE"
        self.start_price = "0"
        self.end_price = "0"
        self.winner = "NONE"
        self.round_start_time = u256(0)
        self.betting_seconds = u256(60)
        self.lock_seconds = u256(60)
        self.up_pool = u256(0)
        self.down_pool = u256(0)
        self.up_count = u256(0)
        self.down_count = u256(0)
        self.total_rounds = u256(0)
        self.last_result = ""
        self.all_results = "[]"
        self.all_bets = "{}"

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

    @gl.public.write.payable
    def bet_up(self) -> None:
        if self.status != "OPEN":
            raise gl.vm.UserError("Betting is not open")
        now = u256(int(time.time()))
        if now > self.round_start_time + self.betting_seconds:
            raise gl.vm.UserError("Betting window closed")
        amount = gl.message.value
        if amount == u256(0):
            raise gl.vm.UserError("Bet amount must be > 0")
        player = str(gl.message.sender_address).lower()
        rid = str(int(self.round_id))
        bets: dict = {}
        try:
            bets = json.loads(self.all_bets)
        except:
            bets = {}
        user_bets: dict = bets.get(player, {})
        if rid in user_bets:
            raise gl.vm.UserError("Already voted this round")
        user_bets[rid] = {"vote": "UP", "amount": str(amount), "claimed": False}
        bets[player] = user_bets
        self.all_bets = json.dumps(bets)
        self.up_pool += amount
        self.up_count += u256(1)

    @gl.public.write.payable
    def bet_down(self) -> None:
        if self.status != "OPEN":
            raise gl.vm.UserError("Betting is not open")
        now = u256(int(time.time()))
        if now > self.round_start_time + self.betting_seconds:
            raise gl.vm.UserError("Betting window closed")
        amount = gl.message.value
        if amount == u256(0):
            raise gl.vm.UserError("Bet amount must be > 0")
        player = str(gl.message.sender_address).lower()
        rid = str(int(self.round_id))
        bets: dict = {}
        try:
            bets = json.loads(self.all_bets)
        except:
            bets = {}
        user_bets: dict = bets.get(player, {})
        if rid in user_bets:
            raise gl.vm.UserError("Already voted this round")
        user_bets[rid] = {"vote": "DOWN", "amount": str(amount), "claimed": False}
        bets[player] = user_bets
        self.all_bets = json.dumps(bets)
        self.down_pool += amount
        self.down_count += u256(1)

    @gl.public.write
    def lock_round(self, price: str) -> None:
        if self.status != "OPEN":
            raise gl.vm.UserError("Round must be OPEN to lock")
        self.start_price = price
        self.status = "LOCKED"

    @gl.public.write
    def resolve_round(self, price: str) -> None:
        if self.status != "LOCKED":
            raise gl.vm.UserError("Round must be LOCKED to resolve")
        self.end_price = price
        self.winner = "UP" if float(price) >= float(self.start_price) else "DOWN"
        self.status = "RESOLVED"
        rid = int(self.round_id)
        entry = {
            "round_id": rid,
            "start_price": str(self.start_price),
            "end_price": str(self.end_price),
            "winner": str(self.winner),
            "up_pool": str(int(self.up_pool)),
            "down_pool": str(int(self.down_pool)),
            "up_count": int(self.up_count),
            "down_count": int(self.down_count),
        }
        self.last_result = json.dumps(entry)
        try:
            results = json.loads(self.all_results)
        except:
            results = []
        results.append(entry)
        self.all_results = json.dumps(results)

    @gl.public.write
    def claim(self, round_id: u256) -> None:
        rid = int(round_id)
        player = str(gl.message.sender_address).lower()
        bets: dict = {}
        try:
            bets = json.loads(self.all_bets)
        except:
            bets = {}
        user_bets: dict = bets.get(player, {})
        bet = user_bets.get(str(rid))
        if not bet:
            raise gl.vm.UserError("No bet found for this round")
        if bet.get("claimed", False):
            raise gl.vm.UserError("Already claimed")
        player_vote = bet.get("vote", "")
        bet_amount = u256(int(bet.get("amount", "0")))
        result = None
        try:
            for r in json.loads(self.all_results):
                if r.get("round_id") == rid:
                    result = r
                    break
        except:
            pass
        if not result:
            raise gl.vm.UserError("Round not resolved yet")
        winner = result.get("winner", "NONE")
        payout = u256(0)
        if player_vote == winner:
            up_p = u256(int(result.get("up_pool", "0")))
            down_p = u256(int(result.get("down_pool", "0")))
            loser_pool = down_p if winner == "UP" else up_p
            winner_pool = up_p if winner == "UP" else down_p
            if winner_pool > u256(0):
                payout = bet_amount + (bet_amount * loser_pool) // winner_pool
        if payout == u256(0):
            raise gl.vm.UserError("No winnings to claim")
        bet["claimed"] = True
        user_bets[str(rid)] = bet
        bets[player] = user_bets
        self.all_bets = json.dumps(bets)
        
        # Transfer the payout to the winner
        _Recipient(gl.message.sender_address).emit_transfer(value=payout)

    @gl.public.view
    def get_round(self) -> dict[str, typing.Any]:
        try:
            sp = int(float(self.start_price))
            ep = int(float(self.end_price))
        except ValueError:
            sp = 0; ep = 0
        return {
            "round_id": int(self.round_id),
            "status": self.status,
            "start_price": sp,
            "end_price": ep,
            "winner": self.winner,
            "round_start_time": int(self.round_start_time),
            "betting_seconds": int(self.betting_seconds),
            "lock_seconds": int(self.lock_seconds),
            "up_pool": str(self.up_pool),
            "down_pool": str(self.down_pool),
            "up_count": int(self.up_count),
            "down_count": int(self.down_count),
            "total_rounds": int(self.total_rounds),
            "last_result": self.last_result,
        }

    @gl.public.view
    def get_past_round(self, round_id: u256) -> dict[str, typing.Any]:
        rid = int(round_id)
        try:
            for r in json.loads(self.all_results):
                if r.get("round_id") == rid:
                    return r
        except:
            pass
        return {"error": "not found"}

    @gl.public.view
    def get_my_bet(self, addr: str) -> dict[str, typing.Any]:
        addr = addr.lower()
        rid = str(int(self.round_id))
        try:
            bets = json.loads(self.all_bets)
            bet = bets.get(addr, {}).get(rid)
            if bet:
                return {"vote": bet["vote"], "amount": bet["amount"]}
        except:
            pass
        return {"vote": "", "amount": "0"}

    @gl.public.write.payable
    def fund(self) -> None:
        """Allow anyone (admin) to fund the contract with tokens"""
        pass

    @gl.public.view
    def get_payout(self, addr: str) -> str:
        if self.status != "RESOLVED":
            return "0"
        addr = addr.lower()
        rid = str(int(self.round_id))
        try:
            bets = json.loads(self.all_bets)
            bet = bets.get(addr, {}).get(rid)
            if not bet:
                return "0"
            player_vote = bet["vote"]
            bet_amount = u256(int(bet["amount"]))
        except:
            return "0"
        if bet_amount == u256(0):
            return "0"
        if self.winner == "DRAW":
            return str(bet_amount)
        if player_vote == self.winner:
            lp = self.down_pool if self.winner == "UP" else self.up_pool
            wp = self.up_pool if self.winner == "UP" else self.down_pool
            if wp > u256(0):
                return str(bet_amount + (bet_amount * lp) // wp)
        return "0"

    @gl.public.view
    def get_user_bet_for_round(self, round_id: u256, addr: str) -> str:
        rid = str(int(round_id))
        addr = addr.lower()
        try:
            bets = json.loads(self.all_bets)
            bet = bets.get(addr, {}).get(rid)
            if bet:
                return json.dumps(bet)
        except:
            pass
        return ""

    @gl.public.view
    def get_user_history(self, addr: str) -> str:
        addr = addr.lower()
        history: list[dict] = []
        results_by_round: dict = {}
        try:
            for res in json.loads(self.all_results):
                results_by_round[str(res.get("round_id", 0))] = res
        except:
            pass
        try:
            bets = json.loads(self.all_bets)
            user_bets = bets.get(addr, {})
        except:
            return "[]"
        for rid_str, bet in user_bets.items():
            vote = bet.get("vote", "")
            amount = bet.get("amount", "0")
            claimed = bet.get("claimed", False)
            res = results_by_round.get(rid_str)
            winner = "NONE"
            start_p = "0"
            end_p = "0"
            result_json = ""
            if res:
                result_json = json.dumps(res)
                winner = res.get("winner", "NONE")
                start_p = res.get("start_price", "0")
                end_p = res.get("end_price", "0")
            won = (vote == winner) or (winner == "DRAW")
            if result_json == "":
                bet_status = "PENDING"
            elif won and claimed:
                bet_status = "CLAIMED"
            elif won:
                bet_status = "CLAIM"
            else:
                bet_status = "LOST"
            history.append({
                "round_id": int(rid_str),
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
        rid = int(round_id)
        try:
            for r in json.loads(self.all_results):
                if r.get("round_id") == rid:
                    return json.dumps(r)
        except:
            pass
        return ""

    @gl.public.view
    def get_round_participants(self, round_id: u256) -> str:
        rid = str(int(round_id))
        parts: list[str] = []
        try:
            bets = json.loads(self.all_bets)
            for a, ub in bets.items():
                if rid in ub:
                    parts.append(a)
        except:
            pass
        return json.dumps(parts)

    @gl.public.write
    def force_lock_debug(self, price: str) -> None:
        if self.status != "OPEN":
            raise gl.vm.UserError("Round must be OPEN to force-lock")
        self.start_price = price
        self.status = "LOCKED"

    @gl.public.write
    def admin_reset_to_idle(self) -> None:
        self.status = "IDLE"
        self.start_price = "0"
        self.end_price = "0"
        self.winner = "NONE"
        self.up_pool = u256(0)
        self.down_pool = u256(0)
        self.up_count = u256(0)
        self.down_count = u256(0)
