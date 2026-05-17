# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *

import json
import typing
import time


@gl.dataclass
class Prediction:
    player: Address
    direction: str  # "UP" or "DOWN"
    timestamp: u256


@gl.dataclass
class RoundData:
    round_id: u256
    open_price: str
    close_price: str
    start_time: u256
    lock_time: u256  # start_time + 5 minutes
    end_time: u256    # start_time + 10 minutes
    status: str       # "OPEN", "LOCKED", "RESOLVED", "DRAW"
    winner_side: str  # "UP", "DOWN", "DRAW", ""
    total_up: u256
    total_down: u256


class BtcPredictionGame(gl.Contract):
    """
    BTC Up/Down Prediction Game on GenLayer.
    
    Game Flow:
    - A round lasts 10 minutes.
    - First 5 minutes: players can predict UP or DOWN.
    - After 5 minutes: round is locked, no more predictions.
    - At 10 minutes: contract fetches BTC price and compares with open price.
    - If close > open: UP wins. If close < open: DOWN wins. If equal: DRAW.
    
    Note: GenLayer contracts don't run cron jobs. An off-chain bot or frontend 
    calls contract functions on schedule. The contract validates timing/state.
    """

    current_round_id: u256
    round_duration: u256      # 10 minutes in seconds = 600
    betting_duration: u256    # 5 minutes in seconds = 300

    def __init__(self):
        """Initialize the BTC Prediction Game contract."""
        self.current_round_id = u256(0)
        self.round_duration = u256(600)      # 10 minutes
        self.betting_duration = u256(300)    # 5 minutes

    # ─── Round Management ─────────────────────────────────────────────

    @gl.public.write
    def start_round(self) -> typing.Any:
        """
        Start a new prediction round.
        Called by off-chain bot or frontend.
        Fetches the current BTC price as the opening price.
        """
        round_id = self.current_round_id

        # Check if previous round exists and is resolved
        existing = self._get_round_storage(round_id)
        if existing is not None and existing["status"] not in ("RESOLVED", "DRAW", ""):
            raise gl.vm.UserError("Previous round not yet resolved")

        # Increment round
        new_round_id = u256(int(round_id) + 1)
        self.current_round_id = new_round_id

        # Fetch BTC opening price
        now = u256(int(time.time()))

        def fetch_btc_price() -> str:
            web_data = gl.nondet.web.render(
                "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
                mode="text"
            )
            task = f"""
Extract the Bitcoin USD price from the following API response.
Respond with ONLY the numeric price value (e.g., "67543.21"), nothing else.
No formatting, no currency symbols, just the number.

API Response:
{web_data}
"""
            result = gl.nondet.exec_prompt(task).strip()
            return result

        open_price = gl.eq_principle.strict_eq(fetch_btc_price)

        # Store round data
        round_key = f"round_{new_round_id}"
        lock_time = u256(int(now) + int(self.betting_duration))
        end_time = u256(int(now) + int(self.round_duration))

        self._set_round_data(new_round_id, {
            "round_id": int(new_round_id),
            "open_price": open_price,
            "close_price": "",
            "start_time": int(now),
            "lock_time": int(lock_time),
            "end_time": int(end_time),
            "status": "OPEN",
            "winner_side": "",
            "total_up": 0,
            "total_down": 0,
        })

        return {
            "round_id": int(new_round_id),
            "open_price": open_price,
            "start_time": int(now),
            "lock_time": int(lock_time),
            "end_time": int(end_time),
        }

    @gl.public.write
    def predict(self, round_id: u256, direction: str) -> typing.Any:
        """
        Place a prediction for a round.
        
        Args:
            round_id: The round to predict on
            direction: "UP" or "DOWN"
        """
        if direction not in ("UP", "DOWN"):
            raise gl.vm.UserError("Direction must be 'UP' or 'DOWN'")

        round_data = self._get_round_storage(round_id)
        if round_data is None:
            raise gl.vm.UserError("Round does not exist")

        if round_data["status"] != "OPEN":
            raise gl.vm.UserError("Round is not open for predictions")

        # Check timing - must be before lock_time
        now = int(time.time())
        if now >= round_data["lock_time"]:
            raise gl.vm.UserError("Betting period has ended")

        # Check if player already predicted this round
        player = str(gl.message.sender_account)
        pred_key = f"pred_{round_id}_{player}"
        existing_pred = gl.ContractState.get(pred_key, None)
        if existing_pred is not None:
            raise gl.vm.UserError("Already predicted for this round")

        # Record prediction
        gl.ContractState[pred_key] = direction

        # Update counts
        if direction == "UP":
            round_data["total_up"] = round_data["total_up"] + 1
        else:
            round_data["total_down"] = round_data["total_down"] + 1

        self._set_round_data(round_id, round_data)

        # Track player in round
        players_key = f"players_{round_id}"
        players = gl.ContractState.get(players_key, [])
        players.append(player)
        gl.ContractState[players_key] = players

        return {
            "round_id": int(round_id),
            "player": player,
            "direction": direction,
            "total_up": round_data["total_up"],
            "total_down": round_data["total_down"],
        }

    @gl.public.write
    def resolve_round(self, round_id: u256) -> typing.Any:
        """
        Resolve a round by fetching the closing BTC price.
        Called by off-chain bot after end_time.
        """
        round_data = self._get_round_storage(round_id)
        if round_data is None:
            raise gl.vm.UserError("Round does not exist")

        if round_data["status"] in ("RESOLVED", "DRAW"):
            raise gl.vm.UserError("Round already resolved")

        # Check timing - must be after end_time
        now = int(time.time())
        if now < round_data["end_time"]:
            raise gl.vm.UserError("Round has not ended yet")

        # Fetch closing BTC price
        def fetch_btc_close_price() -> str:
            web_data = gl.nondet.web.render(
                "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
                mode="text"
            )
            task = f"""
Extract the Bitcoin USD price from the following API response.
Respond with ONLY the numeric price value (e.g., "67543.21"), nothing else.
No formatting, no currency symbols, just the number.

API Response:
{web_data}
"""
            result = gl.nondet.exec_prompt(task).strip()
            return result

        close_price = gl.eq_principle.strict_eq(fetch_btc_close_price)

        # Compare prices
        open_price_float = float(round_data["open_price"])
        close_price_float = float(close_price)

        if close_price_float > open_price_float:
            winner_side = "UP"
            status = "RESOLVED"
        elif close_price_float < open_price_float:
            winner_side = "DOWN"
            status = "RESOLVED"
        else:
            winner_side = "DRAW"
            status = "DRAW"

        # Update round data
        round_data["close_price"] = close_price
        round_data["winner_side"] = winner_side
        round_data["status"] = status

        self._set_round_data(round_id, round_data)

        return {
            "round_id": int(round_id),
            "open_price": round_data["open_price"],
            "close_price": close_price,
            "winner_side": winner_side,
            "status": status,
            "total_up": round_data["total_up"],
            "total_down": round_data["total_down"],
        }

    # ─── View Methods ─────────────────────────────────────────────────

    @gl.public.view
    def get_round(self, round_id: u256) -> dict[str, typing.Any]:
        """Get data for a specific round."""
        round_data = self._get_round_storage(round_id)
        if round_data is None:
            return {"error": "Round does not exist"}
        return round_data

    @gl.public.view
    def get_current_round(self) -> dict[str, typing.Any]:
        """Get data for the current (latest) round."""
        if int(self.current_round_id) == 0:
            return {"error": "No rounds started yet"}
        return self.get_round(self.current_round_id)

    @gl.public.view
    def get_player_prediction(self, round_id: u256, player: str) -> dict[str, typing.Any]:
        """Get a player's prediction for a specific round."""
        pred_key = f"pred_{round_id}_{player}"
        direction = gl.ContractState.get(pred_key, None)
        if direction is None:
            return {"predicted": False, "direction": ""}
        return {"predicted": True, "direction": direction}

    @gl.public.view
    def get_round_players(self, round_id: u256) -> list:
        """Get all players who predicted in a round."""
        players_key = f"players_{round_id}"
        return gl.ContractState.get(players_key, [])

    @gl.public.view
    def get_game_stats(self) -> dict[str, typing.Any]:
        """Get overall game statistics."""
        return {
            "total_rounds": int(self.current_round_id),
            "round_duration_seconds": int(self.round_duration),
            "betting_duration_seconds": int(self.betting_duration),
        }

    # ─── Internal Helpers ─────────────────────────────────────────────

    def _get_round_storage(self, round_id: u256) -> typing.Optional[dict]:
        """Get round data from contract storage."""
        round_key = f"round_{round_id}"
        return gl.ContractState.get(round_key, None)

    def _set_round_data(self, round_id: u256, data: dict):
        """Set round data in contract storage."""
        round_key = f"round_{round_id}"
        gl.ContractState[round_key] = data
