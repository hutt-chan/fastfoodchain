-- FastFoodChain — schema theo đặc tả use case (MySQL 8+)
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS cash_shifts;
DROP TABLE IF EXISTS local_purchases;
DROP TABLE IF EXISTS food_waste_lines;
DROP TABLE IF EXISTS food_waste;
DROP TABLE IF EXISTS inventory_adjustment_lines;
DROP TABLE IF EXISTS inventory_adjustments;
DROP TABLE IF EXISTS low_stock_alerts;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS reviews;
DROP TABLE IF EXISTS payment_transactions;
DROP TABLE IF EXISTS delivery_tracking;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS order_status_history;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS cart_items;
DROP TABLE IF EXISTS vouchers;
DROP TABLE IF EXISTS stock_outbound_lines;
DROP TABLE IF EXISTS stock_outbounds;
DROP TABLE IF EXISTS stock_request_lines;
DROP TABLE IF EXISTS stock_requests;
DROP TABLE IF EXISTS purchase_order_lines;
DROP TABLE IF EXISTS purchase_orders;
DROP TABLE IF EXISTS suppliers;
DROP TABLE IF EXISTS branch_inventory;
DROP TABLE IF EXISTS central_inventory;
DROP TABLE IF EXISTS product_bom;
DROP TABLE IF EXISTS ingredients;
DROP TABLE IF EXISTS branch_menu;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS branch_staff;
DROP TABLE IF EXISTS branches;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS system_config;

SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE roles (
  id INT PRIMARY KEY AUTO_INCREMENT,
  code VARCHAR(32) NOT NULL UNIQUE,
  name_vi VARCHAR(80) NOT NULL
);

CREATE TABLE branches (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  address VARCHAR(255) NOT NULL,
  lat DECIMAL(10,7) NOT NULL,
  lng DECIMAL(10,7) NOT NULL,
  delivery_radius_km DECIMAL(6,2) NOT NULL DEFAULT 5.00,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  open_time TIME DEFAULT '08:00:00',
  close_time TIME DEFAULT '22:00:00',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  email VARCHAR(120) NULL UNIQUE,
  phone VARCHAR(20) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(120) NOT NULL,
  role_id INT NOT NULL,
  branch_id INT NULL,
  default_address VARCHAR(255) NULL,
  default_lat DECIMAL(10,7) NULL,
  default_lng DECIMAL(10,7) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  must_change_password TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (role_id) REFERENCES roles(id),
  FOREIGN KEY (branch_id) REFERENCES branches(id)
);

CREATE TABLE branch_staff (
  branch_id INT NOT NULL,
  user_id INT NOT NULL,
  kitchen_role VARCHAR(40) NULL,
  PRIMARY KEY (branch_id, user_id),
  FOREIGN KEY (branch_id) REFERENCES branches(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE system_config (
  config_key VARCHAR(64) PRIMARY KEY,
  config_value TEXT NOT NULL,
  description VARCHAR(255) NULL
);

CREATE TABLE audit_logs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NULL,
  action VARCHAR(64) NOT NULL,
  module VARCHAR(64) NULL,
  detail TEXT NULL,
  ip VARCHAR(45) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_audit_created (created_at)
);

CREATE TABLE categories (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(80) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0
);

CREATE TABLE products (
  id INT PRIMARY KEY AUTO_INCREMENT,
  category_id INT NOT NULL,
  name VARCHAR(160) NOT NULL,
  description TEXT NULL,
  image_url VARCHAR(512) NULL,
  base_price DECIMAL(12,2) NOT NULL,
  is_active_chain TINYINT(1) NOT NULL DEFAULT 1,
  is_deleted TINYINT(1) NOT NULL DEFAULT 0,           -- UC-15: soft delete
  deleted_at DATETIME NULL,
  prep_time_minutes INT NOT NULL DEFAULT 15,
  FOREIGN KEY (category_id) REFERENCES categories(id)
);

CREATE TABLE ingredients (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  unit VARCHAR(20) NOT NULL,
  unit_cost DECIMAL(12,2) NOT NULL DEFAULT 0,
  safety_stock_min DECIMAL(12,3) NOT NULL DEFAULT 0,
  reorder_point DECIMAL(12,3) NOT NULL DEFAULT 0
);

CREATE TABLE product_bom (
  product_id INT NOT NULL,
  ingredient_id INT NOT NULL,
  qty_per_unit DECIMAL(12,4) NOT NULL,
  is_optional TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, ingredient_id),
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (ingredient_id) REFERENCES ingredients(id)
);

CREATE TABLE central_inventory (
  ingredient_id INT PRIMARY KEY,
  quantity DECIMAL(14,4) NOT NULL DEFAULT 0,
  FOREIGN KEY (ingredient_id) REFERENCES ingredients(id)
);

CREATE TABLE branch_inventory (
  branch_id INT NOT NULL,
  ingredient_id INT NOT NULL,
  quantity DECIMAL(14,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (branch_id, ingredient_id),
  FOREIGN KEY (branch_id) REFERENCES branches(id),
  FOREIGN KEY (ingredient_id) REFERENCES ingredients(id)
);

CREATE TABLE branch_menu (
  branch_id INT NOT NULL,
  product_id INT NOT NULL,
  price_override DECIMAL(12,2) NULL,
  is_available TINYINT(1) NOT NULL DEFAULT 1,
  manual_off TINYINT(1) NOT NULL DEFAULT 0,
  manual_off_reason VARCHAR(255) NULL,
  manual_off_until DATETIME NULL,           -- UC-31: tự bật lại khi quá thời điểm này
  auto_off TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (branch_id, product_id),
  FOREIGN KEY (branch_id) REFERENCES branches(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE vouchers (
  id INT PRIMARY KEY AUTO_INCREMENT,
  code VARCHAR(40) NOT NULL UNIQUE,
  discount_type ENUM('PERCENT','FIXED') NOT NULL,
  discount_value DECIMAL(12,2) NOT NULL,
  min_order_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  max_uses INT NOT NULL DEFAULT 1000,
  used_count INT NOT NULL DEFAULT 0,
  branch_id INT NULL,
  valid_from DATE NOT NULL,
  valid_to DATE NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  FOREIGN KEY (branch_id) REFERENCES branches(id)
);

CREATE TABLE cart_items (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  branch_id INT NOT NULL,
  product_id INT NOT NULL,
  quantity INT NOT NULL DEFAULT 1,
  note VARCHAR(255) NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (branch_id) REFERENCES branches(id),
  FOREIGN KEY (product_id) REFERENCES products(id),
  UNIQUE KEY uq_cart (user_id, branch_id, product_id)
);

CREATE TABLE orders (
  id INT PRIMARY KEY AUTO_INCREMENT,
  order_code VARCHAR(24) NOT NULL UNIQUE,
  user_id INT NOT NULL,
  branch_id INT NOT NULL,
  status VARCHAR(40) NOT NULL,
  payment_method ENUM('COD','ONLINE') NOT NULL,
  payment_status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  subtotal DECIMAL(12,2) NOT NULL,
  discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  shipping_fee DECIMAL(12,2) NOT NULL DEFAULT 0,
  total DECIMAL(12,2) NOT NULL,
  voucher_id INT NULL,
  delivery_address VARCHAR(255) NOT NULL,
  delivery_lat DECIMAL(10,7) NULL,
  delivery_lng DECIMAL(10,7) NULL,
  cancel_reason VARCHAR(255) NULL,
  kitchen_ack_at DATETIME NULL,             -- UC-33: thời điểm bếp xác nhận nhận đơn
  kitchen_started_at DATETIME NULL,
  kitchen_finished_at DATETIME NULL,
  packaged_at DATETIME NULL,
  completed_at DATETIME NULL,
  payment_deadline DATETIME NULL,           -- UC-05: timeout chờ thanh toán
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (branch_id) REFERENCES branches(id),
  FOREIGN KEY (voucher_id) REFERENCES vouchers(id),
  INDEX idx_orders_branch_status (branch_id, status)
);

CREATE TABLE order_status_history (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_id INT NOT NULL,
  status VARCHAR(40) NOT NULL,
  note VARCHAR(255) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE order_items (
  id INT PRIMARY KEY AUTO_INCREMENT,
  order_id INT NOT NULL,
  product_id INT NOT NULL,
  product_name VARCHAR(160) NOT NULL,
  quantity INT NOT NULL,
  unit_price DECIMAL(12,2) NOT NULL,
  options_json JSON NULL,
  cook_status ENUM('PENDING','COOKING','READY') NOT NULL DEFAULT 'PENDING',  -- UC-34: per-item kitchen state
  cook_started_at DATETIME NULL,
  cook_finished_at DATETIME NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE payment_transactions (
  id INT PRIMARY KEY AUTO_INCREMENT,
  order_id INT NOT NULL,
  gateway_ref VARCHAR(64) NULL,
  status VARCHAR(32) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  raw_payload TEXT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE delivery_tracking (
  order_id INT PRIMARY KEY,
  external_shipment_id VARCHAR(64) NULL,
  status VARCHAR(40) NULL,
  last_lat DECIMAL(10,7) NULL,
  last_lng DECIMAL(10,7) NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE reviews (
  id INT PRIMARY KEY AUTO_INCREMENT,
  order_id INT NOT NULL,
  user_id INT NOT NULL,
  rating_food TINYINT NOT NULL,
  rating_delivery TINYINT NOT NULL,
  comment TEXT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_review_order (order_id),
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE suppliers (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(160) NOT NULL,
  tax_code VARCHAR(32) NULL UNIQUE,
  contact VARCHAR(255) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1
);

CREATE TABLE purchase_orders (
  id INT PRIMARY KEY AUTO_INCREMENT,
  supplier_id INT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
  total_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
);

CREATE TABLE purchase_order_lines (
  id INT PRIMARY KEY AUTO_INCREMENT,
  purchase_order_id INT NOT NULL,
  ingredient_id INT NOT NULL,
  qty_ordered DECIMAL(14,4) NOT NULL,
  unit_price DECIMAL(12,2) NOT NULL,
  qty_received DECIMAL(14,4) NULL,
  FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id),
  FOREIGN KEY (ingredient_id) REFERENCES ingredients(id)
);

CREATE TABLE stock_requests (
  id INT PRIMARY KEY AUTO_INCREMENT,
  branch_id INT NOT NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'NEW',
  is_urgent TINYINT(1) NOT NULL DEFAULT 0,
  reject_reason VARCHAR(255) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (branch_id) REFERENCES branches(id)
);

CREATE TABLE stock_request_lines (
  id INT PRIMARY KEY AUTO_INCREMENT,
  stock_request_id INT NOT NULL,
  ingredient_id INT NOT NULL,
  qty_requested DECIMAL(14,4) NOT NULL,
  qty_approved DECIMAL(14,4) NULL,
  FOREIGN KEY (stock_request_id) REFERENCES stock_requests(id),
  FOREIGN KEY (ingredient_id) REFERENCES ingredients(id)
);

CREATE TABLE stock_outbounds (
  id INT PRIMARY KEY AUTO_INCREMENT,
  stock_request_id INT NOT NULL,
  code VARCHAR(32) NOT NULL UNIQUE,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING_PICK',
  trip_code VARCHAR(64) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  shipped_at DATETIME NULL,
  FOREIGN KEY (stock_request_id) REFERENCES stock_requests(id)
);

CREATE TABLE stock_outbound_lines (
  id INT PRIMARY KEY AUTO_INCREMENT,
  stock_outbound_id INT NOT NULL,
  ingredient_id INT NOT NULL,
  quantity DECIMAL(14,4) NOT NULL,
  FOREIGN KEY (stock_outbound_id) REFERENCES stock_outbounds(id),
  FOREIGN KEY (ingredient_id) REFERENCES ingredients(id)
);

-- ===== UC mới =====

-- UC-30: Phiếu điều chỉnh tồn kho chi nhánh (cần duyệt nếu chênh lệch vượt ngưỡng)
CREATE TABLE inventory_adjustments (
  id INT PRIMARY KEY AUTO_INCREMENT,
  branch_id INT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING',  -- PENDING / AUTO_APPROVED / APPROVED / REJECTED
  reason VARCHAR(255) NULL,
  reject_reason VARCHAR(255) NULL,
  created_by INT NULL,
  reviewed_by INT NULL,
  reviewed_at DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (branch_id) REFERENCES branches(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (reviewed_by) REFERENCES users(id)
);

CREATE TABLE inventory_adjustment_lines (
  id INT PRIMARY KEY AUTO_INCREMENT,
  adjustment_id INT NOT NULL,
  ingredient_id INT NOT NULL,
  qty_before DECIMAL(14,4) NOT NULL,
  qty_after DECIMAL(14,4) NOT NULL,
  delta DECIMAL(14,4) NOT NULL,                    -- +nhập / -xuất hao
  FOREIGN KEY (adjustment_id) REFERENCES inventory_adjustments(id),
  FOREIGN KEY (ingredient_id) REFERENCES ingredients(id)
);

-- UC-39: Cảnh báo tồn kho event-driven
CREATE TABLE low_stock_alerts (
  id INT PRIMARY KEY AUTO_INCREMENT,
  scope VARCHAR(16) NOT NULL,                       -- 'CENTRAL' / 'BRANCH'
  branch_id INT NULL,
  ingredient_id INT NOT NULL,
  level VARCHAR(16) NOT NULL,                       -- 'SAFETY' / 'REORDER'
  current_qty DECIMAL(14,4) NOT NULL,
  threshold_qty DECIMAL(14,4) NOT NULL,
  acknowledged TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (branch_id) REFERENCES branches(id),
  FOREIGN KEY (ingredient_id) REFERENCES ingredients(id),
  INDEX idx_alert_branch (branch_id, acknowledged),
  INDEX idx_alert_created (created_at)
);

-- UC mới #1: Hao hụt thực phẩm (boom hàng / bể hỏng)
CREATE TABLE food_waste (
  id INT PRIMARY KEY AUTO_INCREMENT,
  branch_id INT NOT NULL,
  order_id INT NULL,                                -- gắn vào đơn nếu là đơn boom
  reason VARCHAR(64) NOT NULL,                      -- DELIVERY_FAILED / SPOILAGE / BREAKAGE / OTHER
  note VARCHAR(255) NULL,
  total_cost DECIMAL(14,2) NOT NULL DEFAULT 0,
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (branch_id) REFERENCES branches(id),
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE food_waste_lines (
  id INT PRIMARY KEY AUTO_INCREMENT,
  waste_id INT NOT NULL,
  ingredient_id INT NULL,
  product_id INT NULL,
  quantity DECIMAL(14,4) NOT NULL,
  unit_cost DECIMAL(12,2) NOT NULL DEFAULT 0,
  FOREIGN KEY (waste_id) REFERENCES food_waste(id),
  FOREIGN KEY (ingredient_id) REFERENCES ingredients(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- UC mới #2: Mua hàng dự phòng khẩn cấp (Petty cash)
CREATE TABLE local_purchases (
  id INT PRIMARY KEY AUTO_INCREMENT,
  branch_id INT NOT NULL,
  ingredient_id INT NOT NULL,
  quantity DECIMAL(14,4) NOT NULL,
  unit_price DECIMAL(12,2) NOT NULL,
  total_cost DECIMAL(14,2) NOT NULL,
  vendor VARCHAR(160) NULL,
  receipt_no VARCHAR(80) NULL,
  note VARCHAR(255) NULL,
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (branch_id) REFERENCES branches(id),
  FOREIGN KEY (ingredient_id) REFERENCES ingredients(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- UC mới #3: Đối soát tiền mặt theo ca
CREATE TABLE cash_shifts (
  id INT PRIMARY KEY AUTO_INCREMENT,
  branch_id INT NOT NULL,
  opened_by INT NOT NULL,
  closed_by INT NULL,
  opening_cash DECIMAL(14,2) NOT NULL DEFAULT 0,
  closing_cash DECIMAL(14,2) NULL,
  cod_collected DECIMAL(14,2) NULL,                 -- tổng COD thu được trong ca
  petty_cash_spent DECIMAL(14,2) NULL,              -- chi qua local purchase trong ca
  expected_cash DECIMAL(14,2) NULL,                 -- = opening + COD - petty_cash
  variance DECIMAL(14,2) NULL,                      -- = closing - expected
  status VARCHAR(16) NOT NULL DEFAULT 'OPEN',       -- OPEN / CLOSED
  note TEXT NULL,
  opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  closed_at DATETIME NULL,
  FOREIGN KEY (branch_id) REFERENCES branches(id),
  FOREIGN KEY (opened_by) REFERENCES users(id),
  FOREIGN KEY (closed_by) REFERENCES users(id),
  INDEX idx_shift_branch_status (branch_id, status)
);

INSERT INTO roles (code, name_vi) VALUES
('CUSTOMER', 'Khách hàng'),
('ADMIN', 'Quản trị viên'),
('CHAIN_MANAGER', 'Quản lý chuỗi'),
('WAREHOUSE_MANAGER', 'Quản lý kho tổng'),
('BRANCH_MANAGER', 'Quản lý chi nhánh'),
('KITCHEN_STAFF', 'Nhân viên bếp');

INSERT INTO system_config (config_key, config_value, description) VALUES
('base_shipping_fee', '20000', 'Phí ship cơ bản (VND)'),
('max_delivery_radius_km', '10', 'Bán kính tối đa'),
('order_payment_timeout_minutes', '5', 'UC-05: Timeout chờ thanh toán online (phút)'),
('branch_quota_multiplier', '500', 'Hệ số quota nguyên liệu tự duyệt (gram)'),
('inventory_adjust_auto_threshold_pct', '5', 'UC-30: % chênh lệch kiểm kê tự duyệt (>=% phải gửi QL chuỗi)'),
('dispatch_lead_time_min', '5', 'UC-36: Thời gian dự phòng cho shipper đến chi nhánh (phút)'),
('webhook_hmac_secret', 'dev-hmac-secret-change-me', 'Chữ ký webhook giả lập');
