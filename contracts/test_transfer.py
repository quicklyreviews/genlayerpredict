import genlayer as gl

@gl.evm.contract_interface
class _Recipient:
    class Write:
        pass

@gl.contract
class TestTransfer:
    def __init__(self):
        pass

    @gl.public.write.payable
    def deposit_and_refund(self):
        amount = gl.message.value
        if amount > u256(0):
            _Recipient(gl.message.sender_address).emit_transfer(value=amount)
