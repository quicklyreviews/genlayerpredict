"""
Direct tests for the BTC Up/Down Prediction Market contract.

Covers:
- Start round successfully
- User vote UP successfully
- User vote twice rejected
- Vote after betting window rejected
- Lock before 5 minutes rejected
- Resolve before 10 minutes rejected
- UP wins when close > open
- DOWN wins when close < open
- DRAW when close == open
"""

import pytest
from genlayer_test import DirectVM

CONTRACT_PATH = "contracts/btc_updown_market.py"

BTC_PRICE_PATTERN = r".*coingecko.*simple/price.*"


def mock_btc_price(direct_vm: DirectVM, price: int):
    """Helper to mock the CoinGecko BTC price API response."""
    direct_vm.clear_mocks()
    direct_vm.mock_web(
        BTC_PRICE_PATTERN,
        {"status": 200, "body": f'{{"bitcoin":{{"usd":{price}}}}}'},
    )


@pytest.fixture
def setup():
    """Create a DirectVM instance and deploy the contract."""
    direct_vm = DirectVM()
    mock_btc_price(direct_vm, 65000)

    contract = direct_vm.deploy(CONTRACT_PATH, args=[])
    return direct_vm, contract


# ─── Basic Round Lifecycle ──────────────────────────────────────────


def test_start_round(setup):
    """Start round should set status to OPEN and record the opening price."""
    direct_vm, contract = setup
    mock_btc_price(direct_vm, 65000)

    contract.start_round()

    state = contract.get_round()
    assert state["status"] == "OPEN"
    assert int(state["round_id"]) == 1
    assert int(state["start_price"]) == 65000


def test_vote_up(setup):
    """User should be able to vote UP during betting window."""
    direct_vm, contract = setup
    mock_btc_price(direct_vm, 65000)
    contract.start_round()

    contract.bet_up()

    state = contract.get_round()
    assert int(state["up_count"]) == 1
    assert int(state["down_count"]) == 0


def test_vote_down(setup):
    """User should be able to vote DOWN during betting window."""
    direct_vm, contract = setup
    mock_btc_price(direct_vm, 65000)
    contract.start_round()

    contract.bet_down()

    state = contract.get_round()
    assert int(state["up_count"]) == 0
    assert int(state["down_count"]) == 1


def test_double_vote_rejected(setup):
    """User should not be able to vote twice in the same round."""
    direct_vm, contract = setup
    mock_btc_price(direct_vm, 65000)
    contract.start_round()

    contract.bet_up()

    with pytest.raises(Exception, match="Already voted"):
        contract.bet_down()


# ─── Timing Guards ──────────────────────────────────────────────────


def test_lock_too_early_rejected(setup):
    """Lock should fail if called before 5 minutes."""
    direct_vm, contract = setup
    mock_btc_price(direct_vm, 65000)
    contract.start_round()

    with pytest.raises(Exception, match="Too early to lock"):
        contract.lock_round()


def test_resolve_too_early_rejected(setup):
    """Resolve should fail if called before 10 minutes."""
    direct_vm, contract = setup
    mock_btc_price(direct_vm, 65000)
    contract.start_round()

    # Even if we lock, resolve should fail if < 10 minutes
    with pytest.raises(Exception, match="Too early"):
        contract.resolve_round()


# ─── Winner Determination ───────────────────────────────────────────


def test_up_wins(setup):
    """If close price > open price, UP should win."""
    direct_vm, contract = setup

    # Start at 65000
    mock_btc_price(direct_vm, 65000)
    contract.start_round()
    contract.bet_up()

    # Advance time past betting window and lock
    direct_vm.advance_time(301)
    contract.lock_round()

    # Advance time to resolve and set higher price
    direct_vm.advance_time(301)
    mock_btc_price(direct_vm, 65500)
    contract.resolve_round()

    state = contract.get_round()
    assert state["status"] == "RESOLVED"
    assert state["winner"] == "UP"
    assert int(state["end_price"]) == 65500


def test_down_wins(setup):
    """If close price < open price, DOWN should win."""
    direct_vm, contract = setup

    mock_btc_price(direct_vm, 65000)
    contract.start_round()
    contract.bet_down()

    direct_vm.advance_time(301)
    contract.lock_round()

    direct_vm.advance_time(301)
    mock_btc_price(direct_vm, 64500)
    contract.resolve_round()

    state = contract.get_round()
    assert state["status"] == "RESOLVED"
    assert state["winner"] == "DOWN"


def test_draw(setup):
    """If close price == open price, result should be DRAW."""
    direct_vm, contract = setup

    mock_btc_price(direct_vm, 65000)
    contract.start_round()

    direct_vm.advance_time(301)
    contract.lock_round()

    direct_vm.advance_time(301)
    mock_btc_price(direct_vm, 65000)
    contract.resolve_round()

    state = contract.get_round()
    assert state["status"] == "RESOLVED"
    assert state["winner"] == "DRAW"


# ─── State Guards ───────────────────────────────────────────────────


def test_start_while_active_rejected(setup):
    """Cannot start a new round while one is active."""
    direct_vm, contract = setup
    mock_btc_price(direct_vm, 65000)
    contract.start_round()

    with pytest.raises(Exception, match="Round already active"):
        contract.start_round()


def test_bet_after_resolve(setup):
    """Cannot bet on a resolved round."""
    direct_vm, contract = setup

    mock_btc_price(direct_vm, 65000)
    contract.start_round()

    direct_vm.advance_time(301)
    contract.lock_round()

    direct_vm.advance_time(301)
    mock_btc_price(direct_vm, 65100)
    contract.resolve_round()

    with pytest.raises(Exception, match="Betting is not open"):
        contract.bet_up()


def test_new_round_after_resolve(setup):
    """Should be able to start a new round after resolving."""
    direct_vm, contract = setup

    # Round 1
    mock_btc_price(direct_vm, 65000)
    contract.start_round()
    direct_vm.advance_time(301)
    contract.lock_round()
    direct_vm.advance_time(301)
    mock_btc_price(direct_vm, 65100)
    contract.resolve_round()

    # Round 2
    mock_btc_price(direct_vm, 66000)
    contract.start_round()

    state = contract.get_round()
    assert int(state["round_id"]) == 2
    assert state["status"] == "OPEN"
    assert int(state["start_price"]) == 66000
