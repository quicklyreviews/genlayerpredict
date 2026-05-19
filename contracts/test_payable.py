import genlayer as gl

@gl.contract
class TestPayable:
    def __init__(self):
        self.val = 0

    @gl.public.write
    @gl.payable
    def pay1(self):
        pass

    @gl.public.payable
    def pay2(self):
        pass

    @gl.public.write.payable
    def pay3(self):
        pass
