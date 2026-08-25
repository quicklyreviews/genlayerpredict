# v0.1.0 — introspect
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *

import json


class Introspect(gl.Contract):
    note: str

    def __init__(self):
        self.note = ""

    @gl.public.view
    def gl_attrs(self) -> str:
        """What the runtime actually exposes, so cross-contract options can be
        judged from the deployed SDK rather than from documentation."""
        return json.dumps(sorted(a for a in dir(gl) if not a.startswith("_")))

    @gl.public.view
    def evm_attrs(self) -> str:
        try:
            return json.dumps(sorted(a for a in dir(gl.evm) if not a.startswith("_")))
        except Exception as e:
            return f"error: {e}"
