# Hướng dẫn GenPredict

Sàn dự đoán giá và giao dịch đòn bẩy chạy trên GenLayer Studionet.
Toàn bộ tiền trong hướng dẫn này là **GEN testnet** — không phải tiền thật.

---

## Bắt đầu trong 3 phút

### Bước 1 — Mở sàn

Cần **hai cửa sổ terminal**, mở cả hai rồi để nguyên.

Cửa sổ 1 — backend và keeper (bắt buộc, không có nó thì vòng chơi không chạy):

```bash
npm run backend
```

Cửa sổ 2 — giao diện:

```bash
npx serve frontend -l 5173
```

Vào **http://localhost:5173**

> **Đóng terminal là sàn dừng.** Vòng chơi đứng cho tới khi chạy lại `npm run backend` — nó tự bắt kịp mọi vòng đang tồn đọng.

### Kiểm tra sàn đã sẵn sàng

```bash
curl http://localhost:3005/api/config
```

Phải thấy địa chỉ contract. Nếu không có gì trả về thì backend chưa chạy.

Muốn kiểm toàn tuyến trên chuỗi thật (nạp → cược → chốt → nhận → rút), mất khoảng 10 phút:

```bash
npm run smoke
```

### Bước 2 — Kết nối ví

Bấm **Connect Wallet**. Ví sẽ hỏi thêm mạng GenLayer Studio — bấm đồng ý.

Chưa có GEN thì xin ở faucet của GenLayer Studio.

### Play balance là gì

Là **tài khoản chơi nằm trong contract**, không phải ví của bạn.

Bạn nạp GEN vào một lần, sau đó mọi lệnh cược trừ thẳng từ đó — khỏi phải ký và chờ đồng thuận từng lần. Rút về ví lúc nào cũng được.

**Địa chỉ ví của bạn chính là số tài khoản.** Chỉ ví sở hữu mới chuyển được số dư đó — không khoá nào của người vận hành tiêu được.

### Nếu Play balance bỗng dưng về 0

Thường là do **contract vừa được deploy lại**. Mỗi lần deploy sinh ra một contract mới hoàn toàn, storage trống. Tiền bạn đã nạp **vẫn nằm nguyên ở contract cũ** — không tự chuyển sang, không tự về ví.

**Không mất đi đâu cả.** Ở đầu trang chủ sẽ hiện ô màu vàng: *"X GEN is waiting on an older version"*, kèm nút **Take back**. Bấm là tiền về thẳng ví — bạn tự ký, không ai chuyển hộ.

Nếu còn tiền **kẹt trong vòng chưa chốt** (contract cũ không còn ai chạy keeper), bấm **Finish round** trước rồi mới Take back được.

### Bước 3 — Nạp tiền chơi

Bấm ô **Play balance** ở góc phải trên → tab **Deposit** → nhập số GEN → xác nhận.

Chờ khoảng một phút để mạng đồng thuận. Xong là chơi được.

---

## Chơi dự đoán lên/xuống

### Cách tính thắng thua

Mỗi vòng chốt **hai mức giá**:

```
Giá KHOÁ  ──────── 5 phút ──────── Giá ĐÓNG

Đóng > Khoá  →  UP thắng
Đóng < Khoá  →  DOWN thắng
Đóng = Khoá  →  hoà, hoàn tiền đủ
```

Không có gì khác ảnh hưởng tới kết quả. Không ai nhập được giá — mỗi validator tự lấy giá từ Binance/CoinGecko/Coinbase rồi so với nhau, lệch quá 0.5% là vòng không được chốt.

### Cách đặt cược

1. Chọn một market ở trang chủ (BTC 5 phút, DOGE 1 giờ...)
2. Nhập số tiền, chọn **▲ UP** hoặc **▼ DOWN**
3. Xem phần dự tính tiền thắng rồi bấm đặt

### Tiền thắng chia thế nào

Toàn bộ pool trừ 3% phí, chia cho bên thắng **theo tỷ lệ tiền cược**.

| Ví dụ | |
|---|---|
| Pool UP | 10 GEN (bạn góp 2) |
| Pool DOWN | 30 GEN |
| UP thắng | Bạn nhận `2/10 × 38.8` = **7.76 GEN** |

Hệ số nhân **thay đổi liên tục** cho tới khi đóng cược — bên nào ít tiền hơn thì thắng được nhiều hơn.

### Đặt cược xong thì thấy gì

Ngay trên thẻ của vòng bạn vừa cược sẽ hiện **Your bet** — cửa nào, bao nhiêu GEN, và **đếm ngược tới lúc có kết quả**.

Khi vòng đã khoá và đang chạy, thẻ còn nói bạn đang *ahead* hay *behind* theo giá hiện tại — nhưng đó chỉ là tạm thời, **kết quả chốt theo giá lúc đóng**.

Bảng **Recent results** ngay dưới có cột **You**: không tham gia thì dấu —, thắng thì có nút nhận ngay, thua thì hiện số mất.

### Biết kết quả và nhận thưởng

Vòng chốt xong, sàn **báo ngay cho bạn**:

| Kết quả | Bạn thấy gì |
|---|---|
| **Thắng** | Thông báo xanh kèm số tiền, và banner **"X GEN waiting"** ở đầu trang |
| **Thua** | Thông báo đỏ nói rõ vòng ra bên nào và giá chạy bao nhiêu |
| **Hoàn tiền** | Thông báo kèm lý do — giá đứng yên, hoặc không ai vào cửa ngược lại |

Thắng rồi bấm **Collect** để nhận. Tiền vào Play balance, dùng cược tiếp được ngay.

Thắng nhiều vòng thì bấm **Collect all** — gom hết vào **một giao dịch**, khỏi phải ký từng vòng.

> **Tiền thắng không bao giờ mất.** Sàn dọn bớt lịch sử cũ cho nhẹ, nhưng **không bao giờ xoá vòng còn tiền chưa nhận**. Bạn để một tuần rồi quay lại vẫn nhận được.

### Xem lại lịch sử

Tab **History** lưu **mọi phiên bạn đã tham gia** — không mất và không rút gọn.

Mỗi dòng nói đủ bốn điều:

| Cột | Ý nghĩa |
|---|---|
| **When** | Phiên chạy lúc nào (di chuột vào xem giờ chính xác) |
| **Outcome** | Thắng / Thua / Hoàn tiền — kèm **lý do**: bên nào thắng và giá chạy bao nhiêu |
| **Result** | Được cộng hay mất bao nhiêu GEN |
| **Collected** | **Đã nhận chưa** — chưa thì có nút nhận ngay tại dòng, nhận rồi thì hiện giờ nhận |

Năm bộ lọc ở trên: **All · To collect · Running · Won · Lost**.
Muốn biết *còn tiền nào chưa nhận* thì bấm **To collect** — một cú click.

**Thống kê ở đầu trang:** số phiên đã chơi, tỷ lệ thắng, lãi/lỗ ròng, tiền chưa nhận, tiền đang nằm trong phiên chưa chốt.

> **Tỷ lệ thắng không tính phiên hoàn tiền.** Lấy lại tiền của chính mình vì không ai vào cửa ngược không phải là bạn đoán đúng — tính vào sẽ làm con số đẹp hơn sự thật.

### Ba điều dễ gây bực nếu không biết trước

**1. Đặt cược sớm, đừng đợi phút chót**
Mạng cần khoảng 1 phút để đồng thuận, nên sàn **đóng cược sớm 45 giây** trước giờ khoá. Đặt muộn hơn là không kịp.

**2. Market đang "ngủ" thì lệnh đầu tiên khởi động đồng hồ**
Market chưa ai cược sẽ hiện *"Your bet starts the clock"*. Bạn cược là đồng hồ bắt đầu chạy, và mọi người có đủ thời gian vào cửa ngược lại.

**3. Khi không ai vào cửa ngược — nhà cái đứng ra đối ứng**

Tiền thắng **lấy từ tiền của bên thua**. Không ai cược ngược lại thì không có gì để thắng.

Trước đây vòng như vậy bị **hoàn tiền** — đoán đúng vẫn không ăn được gì. Giờ:

> **Nếu tới lúc khoá mà một bên vẫn trống, nhà cái tự đặt vào bên đó.**

Nhà cái đặt **bằng đúng số tiền bên kia**, nên tỷ lệ ra khoảng **1.94x** (2x trừ phí 3%) — đúng như một kèo 50/50 công bằng nên trả.

Đoán đúng thì ăn tiền của nhà cái. Đoán sai thì mất tiền cho nhà cái. Sòng phẳng hai chiều.

**Khi nào vẫn còn hoàn tiền?**

| Trường hợp | Kết quả |
|---|---|
| Giá đóng **bằng đúng** giá khoá | Hoàn tiền — không ai đoán đúng cả |
| Cược **vượt trần** nhà cái đỡ được cho mỗi vòng | Hoàn tiền |
| Quỹ đối ứng của nhà cái **đã cạn** | Hoàn tiền |

Những lúc đó sàn **nói trước ngay trên thẻ vòng**, màu vàng, chứ không để bạn phát hiện lúc đã xong. Ô dự tính tiền thắng cũng hiện đúng con số sẽ được trả.

> **Lưu ý:** tiền đối ứng này là vốn riêng của nhà cái, **không phải vốn của người góp pool**. Prediction pool ở tab Earn vẫn đúng như cam kết: không dính rủi ro thắng thua.

---

## Mỗi lệnh cược đều ký bằng ví của bạn

Đặt cược là ví hỏi xác nhận. Đây là chủ ý, không phải thiếu sót.

Contract trừ tiền từ **số dư của địa chỉ ký lệnh**. Nên người ký bắt buộc phải là người đang giữ tiền — và chỉ ví của bạn mới vừa là người ký vừa là người giữ.

> **Bản cũ từng có "Instant play"** — tạo một khoá tạm trong trình duyệt để ký hộ, khỏi popup. **Nó không thể hoạt động được**: tiền bạn nạp nằm dưới địa chỉ ví chính, còn ví tạm chỉ được cấp GEN trả phí — nó ký thì contract tra số dư của *nó*, thấy 0, và lệnh hỏng. Đã gỡ bỏ.

Nếu trước đây bạn đã nạp GEN vào ví tạm đó: **ô Play balance → tab Session wallet** sẽ hiện số còn lại kèm nút trả về ví chính.

---

## Giao dịch đòn bẩy (Perps)

Vào tab **Perps**. Ở đây bạn cược giá lên/xuống **có đòn bẩy**, và sàn là đối tác của bạn.

```
Ký quỹ 1 GEN × đòn bẩy 10x = quy mô 10 GEN
Giá chạy đúng hướng 5%  →  lãi 0.5 GEN  (50% vốn)
Giá chạy ngược 5%       →  lỗ 0.5 GEN  (50% vốn)
Ngược đủ xa             →  bị thanh lý, mất sạch ký quỹ
```

**Đòn bẩy tối đa theo độ biến động của từng coin:**

| Coin | Tối đa |
|---|---|
| BTC, ETH | 20x |
| SOL, BNB | 15x |
| LINK | 10x |
| DOGE | 8x |
| SHIB, PEPE | 5x |

Memecoin bị giới hạn thấp vì một cây nến 10% bình thường cũng đủ thổi bay vị thế đòn bẩy cao trước khi kịp thanh lý.

**Phí:** thu cả lúc mở và lúc đóng, như sàn thật.

**Có thể bị từ chối mở lệnh:** sàn giới hạn tổng quy mô theo số vốn trong pool. Không đủ vốn đỡ thì không nhận lệnh — thà từ chối trước còn hơn nhận rồi không trả nổi.

---

## Kiếm lãi 10%/năm (Earn)

Vào tab **Earn**. Góp GEN vào pool, ăn lãi tính theo từng giây, rút lúc nào cũng được.

### Hai pool khác nhau về rủi ro

| | Prediction pool | Perps pool |
|---|---|---|
| Vốn của bạn làm gì | Không làm gì | Đỡ lãi/lỗ của trader |
| Rủi ro mất vốn | **Không** | **Có** — trader thắng thì pool teo |
| Rút tiền | Bất cứ lúc nào | Giới hạn bởi phần vốn không đang đỡ lệnh |

Bên Predict người chơi ăn tiền của nhau nên vốn ngoài chỉ nằm đó ăn lãi. Bên Perps vốn của bạn thật sự làm việc — và đó là thứ mà lãi suất đang trả công.

### Lãi 10% lấy từ đâu

**Đây là khoản trợ cấp, không phải doanh thu.** Nó trả từ quỹ thưởng do người vận hành bơm vào — phí giao dịch không đủ nuôi.

Trang Earn hiện **quỹ thưởng còn đủ trả bao lâu**. Nếu cạn: **tiền gốc vẫn trả đủ**, phần lãi trả tới đâu hay tới đó và số thiếu được ghi nhận lại, không mất.

---

## Lệnh thường dùng

```bash
npm run backend         # chạy sàn (bắt buộc)
npm run coins           # cập nhật danh sách 1000 coin từ CoinGecko
npm run deploy          # deploy lại contract dự đoán
npm run deploy:perp     # deploy lại contract perp
npm run smoke           # test luồng cược đầy đủ
npm run smoke:pool      # test luồng góp vốn ăn lãi
npm run smoke:session   # test ví tạm tự ký
```

---

## Gặp lỗi thì xem đây

**Trang trắng, không có market nào**
Backend chưa chạy. Mở terminal, chạy `npm run backend`.

**"Insufficient balance — deposit first"**
Play balance đang rỗng. Bấm ô Play balance → Deposit.

**Cược xong mà số dư không đổi**
Chờ khoảng một phút — mạng cần thời gian đồng thuận. Số sẽ tự cập nhật.

**Thắng rồi mà số dư chưa tăng**
Tiền thắng cần bấm **Collect** mới vào Play balance. Nhìn banner xanh ở đầu trang, hoặc vào **History → To collect**.

**Không nhớ đã chơi phiên nào**
Vào tab **History** — mọi phiên đều ở đó, kèm kết quả và trạng thái đã nhận tiền hay chưa.

**"Betting has closed for this round"**
Đặt muộn quá. Sàn đóng cược sớm 45 giây để lệnh kịp lên chuỗi.

**"Position too large for the vault to back"**
Pool perp không đủ vốn đỡ lệnh cỡ đó. Giảm quy mô, giảm đòn bẩy, hoặc góp thêm vốn ở tab Earn.

**Vòng đứng yên không chạy**
Backend đã tắt. Chạy lại `npm run backend` — nó sẽ tự bắt kịp mọi vòng đang tồn đọng.

**"Rate limit exceeded"**
Node cho tối đa 500 request/giờ và 5000/ngày. Đợi ít phút. Đóng bớt tab đang mở cũng giúp — tab ẩn thì tự ngừng gọi.

---

## Những điều nên biết

- **Đây là testnet.** GEN không có giá trị thật.
- **Không ai can thiệp được giá.** Contract không có hàm nào nhận giá làm tham số.
- **Tiền thắng phải bấm Collect mới nhận**, nhưng không bao giờ mất — vòng còn tiền chưa nhận sẽ không bị dọn.
- **Chỉ chạy trên Studionet.** Trỏ sang mạng khác là hệ thống từ chối chạy.
- **Tiến trình nền không sống qua phiên** — đóng terminal là phải chạy lại `npm run backend`.
