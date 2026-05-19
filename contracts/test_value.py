import genlayer as gl

@gl.contract
class TestValue:
    def __init__(self):
        self.val = "0"

    @gl.public.write.payable
    def pay(self):
        try:
            self.val = str(gl.message.value)
        except Exception as e:
            self.val = "ERROR: " + str(e)
            
    @gl.public.view
    def get_val(self) -> str:
        return self.val
