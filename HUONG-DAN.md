# Hướng dẫn GenPredict

Sàn dự đoán giá và giao dịch đòn bẩy chạy trên GenLayer Studionet.
Toàn bộ tiền trong hướng dẫn này là **GEN testnet** — không phải tiền thật.

---

## Bắt đầu trong 3 phút

### Bước 1 — Mở sàn

```bash
npm run backend      # cửa sổ 1: giữ nguyên, đừng đóng
```

Mở thư mục `frontend/` bằng một web server bất kỳ, hoặc:

```bash
npx serve frontend -l 5173    # cửa sổ 2
```

Vào **http://localhost:5173**

> **Lưu ý:** đóng cửa sổ terminal là sàn dừng. Vòng chơi sẽ đứng cho tới khi bạn chạy lại `npm run backend`.

### Bước 2 — Kết nối ví

Bấm **Connect Wallet**. Ví sẽ hỏi thêm mạng GenLayer Studio — bấm đồng ý.

Chưa có GEN thì xin ở faucet của GenLayer Studio.

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

**3. Cược một chiều thì được hoàn tiền, không phải thắng**
Nếu cả vòng chỉ có mình bạn cược, không có ai bên kia để thắng — sàn **hoàn đủ tiền, không thu phí**. Trạng thái hiện là *Refunded*.

---

## Chơi không cần ký từng lệnh

Mặc định mỗi lệnh cược ví sẽ hỏi xác nhận. Trên GenLayer việc đó phiền thật sự: popup có thể sống lâu hơn cửa sổ cược.

**Bật ⚡ Instant play:** ô Play balance → tab **⚡ Instant play** → nhập số GEN → bật.

Từ đó mọi lệnh **tự ký, không popup**.

### Đổi lại là gì

Trình duyệt giữ một khoá riêng cho ví tạm này. **Bất kỳ thứ gì chạy được mã trên trang đều lấy được tiền trong ví tạm** — extension độc, lỗ hổng XSS.

Vì vậy:

- **Chỉ nạp số tiền định chơi**, coi như tiền lẻ trong túi
- Ví chính của bạn **ký đúng một lần** và không để lại quyền gì tái sử dụng được
- Mất nhiều nhất là đúng số đã nạp vào ví tạm
- Khoá **không rời khỏi trình duyệt** — không gửi lên server, người vận hành không tiêu hộ được

Chơi xong bấm **Cash out and turn off** để quét tiền về ví chính và xoá khoá.

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
