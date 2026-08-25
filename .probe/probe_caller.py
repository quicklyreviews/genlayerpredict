# v0.1.0 — probe caller
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *

import typing


class ProbeCaller(gl.Contract):
    vault: str
    note: str

    def __init__(self, vault_address: str):
        self.vault = vault_address
        self.note = ""

    @gl.public.write
    def push_credit(self, user: str, amount: u256) -> str:
        """Cross-contract write. The runtime exposes get_contract_at, not the
        ContractAt name the docs suggest — confirmed by listing dir(gl)."""
        v = gl.get_contract_at(Address(self.vault))
        v.emit().credit(user, amount)
        self.note = "emit-called"
        return "ok"

    @gl.public.view
    def read_vault_balance(self, user: str) -> str:
        """Cross-contract read from a view method."""
        v = gl.get_contract_at(Address(self.vault))
        return str(v.view().get_balance_of(user))

    @gl.public.view
    def get_note(self) -> str:
        return self.note
