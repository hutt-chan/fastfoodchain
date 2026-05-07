# FastFood Chain — Hệ thống quản lý & điều phối đơn hàng

Hệ thống dark kitchen / chuỗi cửa hàng thức ăn nhanh, hiện thực hoá đầy đủ 45 use case theo tài liệu đặc tả.

- **Backend**: Node.js (Express) + MySQL 8
- **Frontend**: HTML/CSS/Vanilla JS (single-file pages, no build step)
- **Auth**: JWT
- **Trạng thái đơn**: máy trạng thái hữu hạn (transitions whitelist)
- **Tích hợp**: Webhook thanh toán & vận chuyển có HMAC SHA-256

## Cấu trúc thư mục

```
database/schema.sql        — Schema MySQL (chạy 1 lần)
server/                    — Code Express
  index.js                 — App entry, mount routes, static
  db.js                    — mysql2 pool
  domain/                  — orderStatus state machine, HttpError
  middleware/              — auth (JWT), asyncHandler, errorHandler
  services/                — orderService (transitions), inventoryService (BOM), configService
  routes/                  — auth, customer, branch, kitchen, chain, warehouse, admin, webhooks, systemMeta
  utils/                   — geo (Haversine), orderCode
  lib/audit.js             — Ghi audit_logs
  seed.js                  — Tạo dữ liệu mẫu
public/                    — HTML/CSS/JS giao diện 6 vai trò
  index.html               — Đăng nhập + portal
  customer.html            — Khách hàng (UC-01 → UC-09)
  admin.html               — Admin (UC-10 → UC-14)
  chain.html               — Quản lý chuỗi (UC-15 → UC-19)
  warehouse.html           — Kho tổng (UC-20 → UC-26)
  branch.html              — Chi nhánh (UC-27 → UC-32)
  kitchen.html             — Bếp KDS (UC-33 → UC-35)
  css/styles.css           — Theme tối thống nhất
  js/api.js                — Helper fetch + token + status pipeline
```

## Chạy lần đầu

1. Cài MySQL 8+, tạo CSDL trống và sửa `.env`:

```env
DB_HOST=127.0.0.1
DB_USER=root
DB_PASSWORD=YOUR_PASSWORD
DB_NAME=fastfood_chain
PORT=3000
JWT_SECRET=mot-chuoi-bi-mat-dai-tuy-y
WEBHOOK_HMAC_SECRET=dev-hmac-secret-change-me
```

2. Cài dependency:

```bash
npm install
```

3. Tạo schema rồi seed dữ liệu mẫu:

```bash
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS fastfood_chain DEFAULT CHARACTER SET utf8mb4;"
npm run db:schema
npm run seed
```

4. Khởi động server (frontend phục vụ tĩnh cùng API):

```bash
npm start
```

Mở trình duyệt: http://localhost:3000

## Tài khoản demo (mật khẩu: `Demo@123`)

| Vai trò               | SĐT          |
|-----------------------|--------------|
| Khách hàng            | `0902000001` |
| Admin                 | `0901000001` |
| Quản lý chuỗi         | `0901000002` |
| Quản lý kho tổng      | `0901000003` |
| Quản lý chi nhánh Q1  | `0901000004` |
| Đầu bếp Q1            | `0901000005` |

Đăng nhập sẽ tự điều hướng tới portal tương ứng.

## Luồng end-to-end để test

1. Đăng nhập với `0902000001 / Demo@123` → tab "Đặt món".
2. Tọa độ mặc định đã có (Q1). Bấm **Tìm chi nhánh gần nhất** → menu hiển thị.
3. Thêm vài món, áp mã `WELCOME10`, chọn **COD** → **Đặt hàng**.
4. Đăng xuất, đăng nhập **QL Chi nhánh** `0901000004` → "Xác nhận" đơn → đơn vào AWAITING_KITCHEN.
5. Đăng nhập **Đầu bếp** `0901000005` → KDS → "Bắt đầu nấu" → "Nấu xong" → "Đã đóng gói".
6. Quay lại Chi nhánh → "Gọi ship" → đơn DELIVERING. Webhook `/api/webhooks/shipment` (status=DELIVERED) sẽ kết thúc đơn (UC-43).
7. Khách quay lại tab "Đơn của tôi" → bấm **Xem** để theo dõi pipeline trạng thái → khi đơn xong, **Đánh giá**.

## API tổng quan (rút gọn — đầy đủ tại `/api/system/meta`)

- `GET /api/system/meta` — máy trạng thái + danh sách endpoint
- **Auth**: `POST /api/auth/login|register`, `GET /me`, `PATCH /profile|password`
- **Khách hàng**: `GET /api/branches[/:id/menu]`, `GET/POST/PATCH/DELETE /api/cart/items`, `POST /api/vouchers/validate`, `POST /api/orders`, `GET /api/orders[/:id]`, `POST /api/orders/:id/cancel|review|after-online-pay`
- **Chi nhánh**: dashboard / orders / menu / inventory / stock-requests / reports / ingredients
  - `POST /api/branch/orders/:id/confirm|dispatch-delivery|mark-failed-delivery` *(UC-43)*
  - `POST /api/branch/inventory/adjust` + `GET /inventory/adjustments` *(UC-30)*
  - `POST /api/branch/local-purchases`, `GET /local-purchases` *(UC mới #2)*
  - `POST /api/branch/cash-shifts/open|/:id/close`, `GET /cash-shifts` *(UC mới #3)*
  - `GET /api/branch/food-waste` *(UC mới #1)*
- **Bếp**: `GET /kds`, `POST /:id/acknowledge|start|finish-cook|package` *(UC-33)*, `PATCH /:orderId/items/:itemId/cook-status` *(UC-34)*
- **QL chuỗi**: CRUD `categories|products|ingredients|vouchers`; `DELETE /products/:id` *(UC-15 soft delete)*; `POST /products/:id/restore`; BOM editor; `GET /inventory-adjustments`, `POST /:id/review` *(UC-30 duyệt)*
- **Kho tổng**: central-inventory, suppliers, stock-requests, outbounds, purchase-orders; `PATCH /ingredients/:id/thresholds`
- **Admin**: config, branches, users, audit; `POST /branches/:id/force-close` *(UC-11)*; `GET /alerts/low-stock`, `POST /alerts/:id/ack` *(UC-39)*
- **Webhook** (`x-signature: HMAC_SHA256(body)`): `payment`, `shipment` (status=`DELIVERED`/`FAILED`/`COD_FAILED` — UC-43)
- **Bảo trì**: `POST /api/system/refresh-menus`

## Use Case đã được cập nhật theo bản đặc tả mới

| UC | Thay đổi | Triển khai |
|----|----------|------------|
| 04 | Double-check số lần dùng voucher trước khi chốt đơn | `SELECT vouchers FOR UPDATE` + kiểm tra hiệu lực/lượt dùng/min_order/branch trước khi tạo đơn |
| 05 | Timeout thanh toán 15p → **5p** | `system_config.order_payment_timeout_minutes = 5`; mỗi đơn ONLINE có `payment_deadline`; auto-cancel khi quá hạn lúc liệt kê đơn |
| 11 | Đóng cửa khẩn cấp | `POST /api/admin/branches/:id/force-close` — huỷ toàn bộ đơn pending + hoàn kho + đặt is_active=0 |
| 15 | Soft delete sản phẩm | `products.is_deleted/deleted_at`; `DELETE /api/chain/products/:id` ẩn khỏi menu khách mới nhưng giữ dữ liệu cho đơn cũ |
| 16 | Phân biệt rõ BOM bắt buộc/tùy chọn | `product_bom.is_optional` đã có; UC-40 chỉ dùng `is_optional = 0` |
| 30 | Workflow duyệt khi điều chỉnh kho vượt ngưỡng | `inventory_adjustments` table; `POST /branch/inventory/adjust` tự duyệt nếu Δ% ≤ ngưỡng (config), ngược lại chuyển QL chuỗi duyệt |
| 31 | Auto-resume món | `branch_menu.manual_off_until`; `refreshBranchProductAvailability` tự bật lại khi tới hạn |
| 33 | Tách "Xác nhận nhận đơn" và "Bắt đầu nấu" | Thêm `kitchen_ack_at` + endpoint `/kitchen/orders/:id/acknowledge` |
| 34 | Chuyển từng món ra trạm chờ đóng gói | `order_items.cook_status (PENDING/COOKING/READY)`; `PATCH /:orderId/items/:itemId/cook-status`; tự chuyển đơn READY_PACKAGING khi tất cả READY |
| 36 | ETA động cho ĐVVC | Tính ETA = lead_time + max(prep_time còn lại) + queue_penalty (UC-36) |
| 39 | Event-driven low-stock alert | `low_stock_alerts` table; gọi `checkAndEmitLowStockAlerts` ngay sau mỗi `consumeBom`/`PO receive`/`outbound ship`/`local purchase`/`adjust` |
| 40 | Không tắt món chính khi chỉ hết topping | `maxServingsForProduct` filter `is_optional = 0` |
| 43 | Xử lý COD_FAILED | Webhook shipment với `status=FAILED/COD_FAILED` → đơn vào FAILED_DELIVERY, payment_status=COD_FAILED, tự ghi food_waste |

## Use Case viết mới

1. **Xử lý đơn giao thất bại & Tiêu hủy thực phẩm** — bảng `food_waste/_lines`. Endpoint `POST /branch/orders/:id/mark-failed-delivery` ghi waste + chuyển trạng thái FAILED_DELIVERY.
2. **Mua hàng dự phòng khẩn cấp (Local Purchase)** — bảng `local_purchases`. `POST /branch/local-purchases` cộng ngay vào kho chi nhánh + ghi nhận chi phí petty cash.
3. **Đối soát tiền mặt theo ca (Cash Management)** — bảng `cash_shifts`. `open` → bán hàng → `close` tự tính `expected = opening + COD - petty`, ghi `variance`.

## Mô hình dữ liệu chính

`users` (kèm role_id) · `branches` · `categories` · `products` · `ingredients` · `product_bom` · `central_inventory` / `branch_inventory` · `branch_menu` (auto_off / manual_off) · `vouchers` · `cart_items` · `orders` · `order_items` · `order_status_history` · `payment_transactions` · `delivery_tracking` · `reviews` · `suppliers` · `purchase_orders[_lines]` · `stock_requests[_lines]` · `stock_outbounds[_lines]` · `system_config` · `audit_logs`

## Trạng thái đơn (state machine)

```
PENDING_PAYMENT → PENDING_BRANCH → AWAITING_KITCHEN → COOKING
  → READY_PACKAGING → AWAITING_SHIPPER → DELIVERING → COMPLETED
(các bước trước AWAITING_KITCHEN có thể → CANCELLED)
```

Việc chuyển trạng thái dùng `transitionOrderLocked` với row-lock (`SELECT ... FOR UPDATE`) trong transaction, đảm bảo không race khi 2 vai trò đồng thời tác động.

## Các điểm đáng chú ý

- **BOM tiêu hao** khi đơn được tạo (COD) hoặc thanh toán online thành công; **hoàn trả** khi hủy đơn đã trừ kho. Sau mỗi thao tác, `refreshBranchProductAvailability` cập nhật cờ `auto_off` trên `branch_menu`.
- **Voucher** đếm `used_count` chỉ khi đơn thành công (COD) hoặc thanh toán online thành công, tránh leak khi đơn bị hủy ở bước thanh toán.
- **Webhook** xác thực HMAC SHA-256 với secret từ `.env`, dùng `crypto.timingSafeEqual` chống timing attack.
- **Audit** ghi vào `audit_logs` cho mọi hành động nhạy cảm: login, đặt/hủy đơn, đổi cấu hình, khóa user, duyệt phiếu xuất, v.v.

## License

Internal demo project.
