# v0.1.0 — probe vault
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *

import json
import typing


class ProbeVault(gl.Contract):
    ledger_json: str
    last_caller: str

    def __init__(self):
        self.ledger_json = "{}"
        self.last_caller = ""

    @gl.public.write
    def credit(self, user: str, amount: u256) -> None:
        """Called by another contract. Records who called so we can see whether the
        sender seen by the vault is the calling contract or the original wallet."""
        self.last_caller = str(gl.message.sender_address).lower()
        try:
            ledger = json.loads(self.ledger_json)
        except Exception:
            ledger = {}
        u = user.lower()
        ledger[u] = str(int(ledger.get(u, "0")) + int(amount))
        self.ledger_json = json.dumps(ledger)

    @gl.public.write.payable
    def deposit(self) -> None:
        self.last_caller = str(gl.message.sender_address).lower()
        try:
            ledger = json.loads(self.ledger_json)
        except Exception:
            ledger = {}
        u = str(gl.message.sender_address).lower()
        ledger[u] = str(int(ledger.get(u, "0")) + int(gl.message.value))
        self.ledger_json = json.dumps(ledger)

    @gl.public.view
    def get_ledger(self) -> str:
        return self.ledger_json

    @gl.public.view
    def get_last_caller(self) -> str:
        return self.last_caller

    @gl.public.view
    def get_balance_of(self, user: str) -> str:
        try:
            return json.loads(self.ledger_json).get(user.lower(), "0")
        except Exception:
            return "0"
