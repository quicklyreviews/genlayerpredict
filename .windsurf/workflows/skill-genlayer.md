---
description: GenLayer CLI, contract development, lint, and debugging workflow
---

## Setup

```bash
npm install -g genlayer
# Install plugin for Windsurf/Cascade IDE
/plugin install genlayer-dev@genlayerlabs
# Lint tool
pip install genvm-linter
```

## Core CLI Commands

| Command | Purpose |
|---------|---------|
| `genlayer deploy --contract file.py` | Deploy a contract |
| `genlayer call <addr> <method>` | Read (view) call |
| `genlayer write <addr> <method>` | Write transaction |
| `genlayer receipt <txHash>` | Get transaction receipt |
| `genlayer schema <addr>` | View contract ABI |
| `genlayer code <addr>` | View deployed source |

## Network Management

```bash
genlayer network set testnet-bradbury
genlayer network info
genlayer network list
# Networks: localnet, testnet-asimov, testnet-bradbury, mainnet
```

## Debugging Workflow

```bash
# 1. Get receipt with stdout/stderr
genlayer receipt <txHash> --stdout --stderr
# 2. Check schema
genlayer schema <address>
# 3. Read source
genlayer code <address>
# 4. Try read call
genlayer call <address> <view_method>
# 5. Appeal failed tx
genlayer appeal <txHash>
```

## Account Management

```bash
genlayer account create --name dev1
genlayer account use dev1
genlayer account list
genlayer account send 0x123...abc 10gen
```

## Contract Skeleton

```python
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *

@gl.contract
class MyContract:
    owner: Address
    items: TreeMap[str, str]

    def __init__(self):
        self.owner = gl.message.sender_account

    @gl.public.view
    def get_item(self, item_id: str) -> dict:
        return {"id": item_id}

    @gl.public.write
    def set_item(self, item_id: str, value: str):
        if gl.message.sender_account != self.owner:
            raise gl.UserError("Only owner")
```

## Runner Dependencies

| Contract Type | Dependency |
|--------------|-----------|
| Single-file Python | `py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6` |
| Multi-file Python package | `py-genlayer-multi:06zyvrlivjga0d5jlpdbprksc0pa6jmllxvp8s20hq1l512vh5yk` |

> **Always pin a specific hash. Never use `test`, `latest`, or unversioned aliases.**

## Equivalence Principle

```python
# Deterministic calls → strict_eq
result = gl.eq_principle.strict_eq(my_deterministic_fn)

# LLM/web non-deterministic → custom validator
def validator(leader, validator):
    try:
        return abs(int(leader) - int(validator)) <= 100
    except:
        return False
result = gl.eq_principle.get(fetch_price, validator)
```

## Storage Rules

| Use | Instead of |
|-----|-----------|
| `TreeMap[K, V]` | `dict` |
| `DynArray[T]` | `list` |
| `u256` for money | `float` / `int` |

## GenLayer Web Oracle Pattern

```python
def _fetch_btc_price(self) -> str:
    def fetch_price() -> str:
        web_data = gl.nondet.web.render(
            "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
            mode="text"
        )
        task = f"""Extract the Bitcoin USD price as integer only.\n\n{web_data}"""
        return gl.nondet.exec_prompt(task).strip()
    return gl.eq_principle.strict_eq(fetch_price)
```

## Anti-Patterns

- `test`, `latest`, or unversioned runner dependencies
- `strict_eq()` for LLM calls (non-deterministic)
- `dict` / `list` for contract storage
- `float` for money amounts
- Modifying state inside `@gl.public.view`
- Inserting fields in middle of dataclass — always append at END

## Lint

```bash
genvm-lint check contracts/my_contract.py --json
genvm-lint lint contracts/my_contract.py
genvm-lint validate contracts/my_contract.py
genvm-lint schema contracts/my_contract.py
```

Exit codes: `0` = ok, `1` = errors, `2` = file not found, `3` = SDK error

## Direct Tests (fast, no server)

```python
def test_flow(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contracts/btc_updown_market.py")
    direct_vm.sender = direct_alice
    direct_vm.mock_web(r"coingecko", '{"bitcoin":{"usd":77000}}')
    contract.start_round()
    result = contract.get_round()
    assert result["status"] == "OPEN"
```

```bash
pytest tests/direct/ -v
```

## Integration Tests (full consensus)

```python
from gltest import get_contract_factory
from gltest.assertions import tx_execution_succeeded

def test_deploy():
    factory = get_contract_factory("BtcUpDownMarket")
    contract = factory.deploy(args=[])
    receipt = contract.start_round(args=[]).transact()
    assert tx_execution_succeeded(receipt)
```

```bash
gltest tests/integration/ -v -s --network localnet
gltest tests/integration/ -v -s --network testnet_bradbury
```

## Error Classification

| Type | Validator Behavior |
|------|------------------|
| `[EXPECTED]` — Business logic errors | Validators agree, tx fails cleanly |
| `[EXTERNAL]` — Web/API failures | Retry logic, may appeal |
| `[TRANSIENT]` — Temporary failures | Auto-retry |
| `[LLM_ERROR]` — Model issues | Appeal or retry |

## This Project

- **Network**: GenLayer Studio — `https://studio.genlayer.com/api` (Chain ID: 61999)
- **Contract v3**: `0x0505108a6052880e6de352e3800C1b005c8083a9`
- **Deploy**: `npx tsx deploy/deployScript.ts`
- **Backend proxy**: `node scripts/backend-proxy.js` (includes cron job for round automation)
- **Frontend**: `npx serve frontend -p 3000`
