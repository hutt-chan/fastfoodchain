/**
 * Chạy sau khi import schema.sql: tạo CSDL fastfood_chain rồi npm run seed
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'fastfood_chain',
    multipleStatements: true,
  });

  const hash = (p) => bcrypt.hashSync(p, 10);
  const pass = hash('Demo@123');

  console.log('Đang xóa dữ liệu cũ...');
  // Bổ sung xóa các bảng mới để tránh lỗi Foreign Key khi chạy seed lại
  await conn.execute('DELETE FROM cash_shifts');
  await conn.execute('DELETE FROM local_purchases');
  await conn.execute('DELETE FROM food_waste_lines');
  await conn.execute('DELETE FROM food_waste');
  await conn.execute('DELETE FROM inventory_adjustment_lines');
  await conn.execute('DELETE FROM inventory_adjustments');
  await conn.execute('DELETE FROM low_stock_alerts');
  
  // Xóa các bảng cũ theo thứ tự
  await conn.execute('DELETE FROM cart_items');
  await conn.execute('DELETE FROM reviews');
  await conn.execute('DELETE FROM payment_transactions');
  await conn.execute('DELETE FROM delivery_tracking');
  await conn.execute('DELETE FROM order_status_history');
  await conn.execute('DELETE FROM order_items');
  await conn.execute('DELETE FROM orders');
  await conn.execute('DELETE FROM stock_outbound_lines');
  await conn.execute('DELETE FROM stock_outbounds');
  await conn.execute('DELETE FROM stock_request_lines');
  await conn.execute('DELETE FROM stock_requests');
  await conn.execute('DELETE FROM purchase_order_lines');
  await conn.execute('DELETE FROM purchase_orders');
  await conn.execute('DELETE FROM branch_staff');
  await conn.execute('DELETE FROM vouchers');
  await conn.execute('DELETE FROM branch_menu');
  await conn.execute('DELETE FROM branch_inventory');
  await conn.execute('DELETE FROM central_inventory');
  await conn.execute('DELETE FROM product_bom');
  await conn.execute('DELETE FROM products');
  await conn.execute('DELETE FROM categories');
  await conn.execute('DELETE FROM ingredients');
  await conn.execute('DELETE FROM suppliers');
  await conn.execute('DELETE FROM users');
  await conn.execute('DELETE FROM branches');

  console.log('Đang tạo dữ liệu nhánh TP.HCM và dữ liệu nền...');
  await conn.execute(
    `INSERT INTO branches (name, address, lat, lng, delivery_radius_km) VALUES
     ('Dark Kitchen Q1', '123 Nguyễn Huệ, Q1, TP.HCM', 10.7769, 106.7009, 6),
     ('Dark Kitchen Thủ Đức', '456 Võ Văn Ngân, Thủ Đức', 10.8500, 106.7717, 5)`
  );
  const branch1 = 1;
  const branch2 = 2;

  const [roles] = await conn.execute('SELECT id, code FROM roles');
  const R = Object.fromEntries(roles.map((r) => [r.code, r.id]));

  await conn.execute(
    `INSERT INTO users (email, phone, password_hash, full_name, role_id, branch_id, default_address, default_lat, default_lng) VALUES
     ('admin@ffc.vn','0901000001',?,'Admin Hệ thống',?,NULL,NULL,NULL,NULL),
     ('chain@ffc.vn','0901000002',?,'Quản lý Chuỗi',?,NULL,NULL,NULL,NULL),
     ('kho@ffc.vn','0901000003',?,'Quản lý Kho tổng',?,NULL,NULL,NULL,NULL),
     ('cn1@ffc.vn','0901000004',?,'QL Chi nhánh Q1',?,?,'Q1',10.7769,106.7009),
     ('bep@ffc.vn','0901000005',?,'Đầu bếp Q1',?,?,'Q1',10.7769,106.7009),
     ('khach@ffc.vn','0902000001',?,'Khách Demo',?,NULL,'Q1',10.7769,106.7009)`,
    [pass, R.ADMIN, pass, R.CHAIN_MANAGER, pass, R.WAREHOUSE_MANAGER, pass, R.BRANCH_MANAGER, branch1, pass, R.KITCHEN_STAFF, branch1, pass, R.CUSTOMER]
  );

  const [[kitchenUser]] = await conn.execute("SELECT id FROM users WHERE phone='0901000005'");
  await conn.execute('INSERT INTO branch_staff (branch_id, user_id, kitchen_role) VALUES (?,?,\'CHEF\')', [
    branch1,
    kitchenUser.id,
  ]);

  await conn.execute(
    `INSERT INTO categories (name, sort_order) VALUES
     ('Món chính',1),('Đồ uống',2),('Tráng miệng',3),('Combo',4)`
  );

  await conn.execute(
    `INSERT INTO products (category_id, name, description, base_price, prep_time_minutes, image_url) VALUES
     (1,'Cơm gà xối mỡ','Cơm trắng dẻo, gà chiên giòn rụm xối mỡ thơm lừng, kèm dưa leo',45000,12,'https://images.unsplash.com/photo-1626645738196-c2a7c87a8f9e?w=480&h=360&fit=crop&auto=format'),
     (1,'Burger bò phô mai','Bánh mềm, thịt bò mọng nước, phô mai chảy béo ngậy',55000,10,'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=480&h=360&fit=crop&auto=format'),
     (1,'Gà rán giòn (3 miếng)','Gà rán da giòn vàng, sốt cay đặc biệt',69000,8,'https://images.unsplash.com/photo-1626082929543-5bab709cb6a4?w=480&h=360&fit=crop&auto=format'),
     (1,'Pizza pepperoni 7 inch','Đế giòn, sốt cà chua, pepperoni và phô mai mozzarella',89000,15,'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=480&h=360&fit=crop&auto=format'),
     (1,'Mì Ý sốt bò bằm','Mì Ý dai, sốt bolognese đậm vị thịt bò',55000,11,'https://images.unsplash.com/photo-1551183053-bf91a1d81141?w=480&h=360&fit=crop&auto=format'),
     (2,'Trà đào cam sả','Trà thơm, đào cắt lát, cam sả tươi',25000,3,'https://images.unsplash.com/photo-1556679343-c7306c1976bc?w=480&h=360&fit=crop&auto=format'),
     (2,'Coca-Cola Zero','Lon 330ml ướp lạnh',15000,1,'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=480&h=360&fit=crop&auto=format'),
     (2,'Sữa lắc dâu','Dâu tây tươi xay nhuyễn cùng sữa tươi',35000,4,'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=480&h=360&fit=crop&auto=format'),
     (3,'Khoai tây chiên size L','Khoai tây vàng giòn, chấm sốt mayonnaise',29000,5,'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=480&h=360&fit=crop&auto=format'),
     (3,'Kem socola','Kem socola Bỉ, vị đậm đà',22000,2,'https://images.unsplash.com/photo-1501443762994-82bd5dace89a?w=480&h=360&fit=crop&auto=format'),
     (4,'Combo Gà rán + Coca','3 miếng gà rán + 1 lon Coca-Cola',79000,10,'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=480&h=360&fit=crop&auto=format'),
     (4,'Combo Burger + Khoai + Coca','Burger bò + Khoai chiên L + Coca',89000,12,'https://images.unsplash.com/photo-1561758033-d89a9ad46330?w=480&h=360&fit=crop&auto=format')`
  );

  await conn.execute(
    `INSERT INTO ingredients (name, unit, unit_cost, safety_stock_min, reorder_point) VALUES
     ('Gà fillet','g',80,500,1000),
     ('Cơm trắng','g',5,2000,5000),
     ('Bánh burger','cái',15000,20,50),
     ('Thịt bò patty','g',120,300,600),
     ('Phô mai lát','g',90,200,400),
     ('Đào syrup','ml',30,500,800),
     ('Trà','ml',2,2000,4000),
     ('Bột mì pizza','g',8,1000,2500),
     ('Pepperoni','g',150,200,400),
     ('Mì Ý sợi','g',12,500,1200),
     ('Sốt bolognese','g',40,300,700),
     ('Khoai tây','g',6,2000,4000),
     ('Coca-Cola lon','lon',8000,30,80),
     ('Sữa tươi','ml',8,500,1500),
     ('Dâu tây','g',60,300,600),
     ('Kem socola','g',25,500,1200)`
  );

  await conn.execute(
    `INSERT INTO product_bom (product_id, ingredient_id, qty_per_unit, is_optional) VALUES
     (1,1,200,0),(1,2,300,0),
     (2,3,1,0),(2,4,120,0),(2,5,40,0),
     (3,1,250,0),
     (4,8,250,0),(4,9,80,0),(4,5,60,0),
     (5,10,150,0),(5,11,150,0),
     (6,6,30,0),(6,7,250,0),
     (7,13,1,0),
     (8,14,250,0),(8,15,80,0),
     (9,12,300,0),
     (10,16,150,0),
     (11,1,250,0),(11,13,1,0),
     (12,3,1,0),(12,4,120,0),(12,5,40,0),(12,12,200,0),(12,13,1,0)`
  );

  for (let i = 1; i <= 16; i++) {
    await conn.execute('INSERT INTO central_inventory (ingredient_id, quantity) VALUES (?,?)', [i, 50000]);
  }

  for (const bid of [branch1, branch2]) {
    for (let pid = 1; pid <= 12; pid++) {
      await conn.execute(
        'INSERT INTO branch_menu (branch_id, product_id, is_available, manual_off, auto_off) VALUES (?,?,1,0,0)',
        [bid, pid]
      );
    }
  }

  const branchStock = [
    [1, 5000], [2, 20000], [3, 100], [4, 3000], [5, 1000],
    [6, 2000], [7, 15000], [8, 8000], [9, 1500], [10, 4000],
    [11, 2500], [12, 6000], [13, 200], [14, 5000], [15, 1500], [16, 3000],
  ];
  for (const bid of [branch1, branch2]) {
    for (const [iid, qty] of branchStock) {
      await conn.execute(
        'INSERT INTO branch_inventory (branch_id, ingredient_id, quantity) VALUES (?,?,?)',
        [bid, iid, qty]
      );
    }
  }

  await conn.execute(
    `INSERT INTO vouchers (code, discount_type, discount_value, min_order_amount, max_uses, branch_id, valid_from, valid_to) VALUES
     ('WELCOME10','PERCENT',10,50000,100,NULL,CURDATE(),DATE_ADD(CURDATE(),INTERVAL 365 DAY)),
     ('GIAM20K','FIXED',20000,80000,50,NULL,CURDATE(),DATE_ADD(CURDATE(),INTERVAL 60 DAY))`
  );

  await conn.execute(
    `INSERT INTO suppliers (name, tax_code, contact) VALUES ('NCC Thực phẩm ABC','0123456789','contact@abc.vn')`
  );

  // =========================================================================
  // === DỮ LIỆU BỔ SUNG: CHI NHÁNH HÀ NỘI & VẬN HÀNH (ĐƯỢC SINH THÊM) ===
  // =========================================================================

  console.log('Đang tạo dữ liệu cho khu vực Hà Nội...');

  // 1. Thêm 3 chi nhánh tại Hà Nội
  await conn.execute(
    `INSERT INTO branches (name, address, lat, lng, delivery_radius_km) VALUES
     ('Dark Kitchen Cầu Giấy', '123 Xuân Thủy, Cầu Giấy, Hà Nội', 21.0378, 105.7940, 6),
     ('Dark Kitchen Đống Đa', '456 Tây Sơn, Đống Đa, Hà Nội', 21.0093, 105.8239, 5),
     ('Dark Kitchen Hoàn Kiếm', '789 Hai Bà Trưng, Hoàn Kiếm, Hà Nội', 21.0258, 105.8475, 7)`
  );
  
  // Lấy ID của các chi nhánh vừa tạo
  const branch3 = 3; // Cầu Giấy
  const branch4 = 4; // Đống Đa
  const branch5 = 5; // Hoàn Kiếm
  const hnBranches = [branch3, branch4, branch5];

  // 2. Thêm Users (Quản lý, Bếp, Khách hàng) cho khu vực Hà Nội
  await conn.execute(
    `INSERT INTO users (email, phone, password_hash, full_name, role_id, branch_id, default_address, default_lat, default_lng) VALUES
     ('cn_caugiay@ffc.vn','0903000001',?,'QL Cầu Giấy',?,?,'Cầu Giấy',21.0378,105.7940),
     ('bep_caugiay@ffc.vn','0903000002',?,'Bếp Cầu Giấy',?,?,'Cầu Giấy',21.0378,105.7940),
     ('cn_dongda@ffc.vn','0903000003',?,'QL Đống Đa',?,?,'Đống Đa',21.0093,105.8239),
     ('bep_dongda@ffc.vn','0903000004',?,'Bếp Đống Đa',?,?,'Đống Đa',21.0093,105.8239),
     ('cn_hoankiem@ffc.vn','0903000005',?,'QL Hoàn Kiếm',?,?,'Hoàn Kiếm',21.0258,105.8475),
     ('bep_hoankiem@ffc.vn','0903000006',?,'Bếp Hoàn Kiếm',?,?,'Hoàn Kiếm',21.0258,105.8475),
     ('khach_hn1@ffc.vn','0904000001',?,'Khách VIP Hà Nội',?,NULL,'Cầu Giấy',21.0378,105.7940)`,
    [
      pass, R.BRANCH_MANAGER, branch3,
      pass, R.KITCHEN_STAFF, branch3,
      pass, R.BRANCH_MANAGER, branch4,
      pass, R.KITCHEN_STAFF, branch4,
      pass, R.BRANCH_MANAGER, branch5,
      pass, R.KITCHEN_STAFF, branch5,
      pass, R.CUSTOMER
    ]
  );

  // 3. Phân quyền nhân sự Bếp (Branch Staff)
  const [bepHN] = await conn.execute("SELECT id, branch_id FROM users WHERE role_id = ? AND branch_id IN (3,4,5)", [R.KITCHEN_STAFF]);
  for (const bep of bepHN) {
    await conn.execute('INSERT INTO branch_staff (branch_id, user_id, kitchen_role) VALUES (?,?,?)', [
      bep.branch_id, bep.id, 'CHEF'
    ]);
  }

  // 4. Cấu hình Menu & Tồn kho đồng loạt cho Hà Nội
  for (const bid of hnBranches) {
    // Menu: Mở bán tất cả 12 sản phẩm
    for (let pid = 1; pid <= 12; pid++) {
      await conn.execute(
        'INSERT INTO branch_menu (branch_id, product_id, is_available, manual_off, auto_off) VALUES (?,?,1,0,0)',
        [bid, pid]
      );
    }
    // Tồn kho: Bơm 10,000 unit cho toàn bộ 16 nguyên liệu
    for (let iid = 1; iid <= 16; iid++) {
      await conn.execute(
        'INSERT INTO branch_inventory (branch_id, ingredient_id, quantity) VALUES (?,?,?)',
        [bid, iid, 10000]
      );
    }
  }

  // 5. Sinh thêm Vouchers đặc quyền theo chi nhánh
  await conn.execute(
    `INSERT INTO vouchers (code, discount_type, discount_value, min_order_amount, max_uses, branch_id, valid_from, valid_to) VALUES
     ('CAUGIAYHELLO','FIXED',30000,100000,500,3,CURDATE(),DATE_ADD(CURDATE(),INTERVAL 30 DAY)),
     ('DONGDADEAL','PERCENT',15,150000,200,4,CURDATE(),DATE_ADD(CURDATE(),INTERVAL 15 DAY))`
  );

  // 6. Sinh dữ liệu Đơn hàng (Orders & Order Items)
  const [[khachHN]] = await conn.execute("SELECT id FROM users WHERE phone='0904000001'");
  await conn.execute(
    `INSERT INTO orders (order_code, user_id, branch_id, status, payment_method, payment_status, subtotal, discount_amount, shipping_fee, total, delivery_address) VALUES
     ('ORD-HN-001', ?, ?, 'COMPLETED', 'COD', 'PAID', 124000, 0, 20000, 144000, 'Ngõ 1, Cầu Giấy'),
     ('ORD-HN-002', ?, ?, 'CANCELLED', 'ONLINE', 'REFUNDED', 55000, 0, 15000, 70000, 'Ngõ 2, Cầu Giấy'),
     ('ORD-HN-003', ?, ?, 'COOKING', 'ONLINE', 'PAID', 89000, 30000, 15000, 74000, 'Ngõ 3, Cầu Giấy')`,
    [khachHN.id, branch3, khachHN.id, branch3, khachHN.id, branch3]
  );

  const [ordersHN] = await conn.execute("SELECT id, order_code FROM orders WHERE order_code LIKE 'ORD-HN-%'");
  const ordMap = Object.fromEntries(ordersHN.map(o => [o.order_code, o.id]));

  await conn.execute(
    `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, cook_status) VALUES
     (?, 1, 'Cơm gà xối mỡ', 1, 45000, 'READY'),
     (?, 11, 'Combo Gà rán + Coca', 1, 79000, 'READY'),
     (?, 2, 'Burger bò phô mai', 1, 55000, 'PENDING'),
     (?, 4, 'Pizza pepperoni 7 inch', 1, 89000, 'COOKING')`,
    [ordMap['ORD-HN-001'], ordMap['ORD-HN-001'], ordMap['ORD-HN-002'], ordMap['ORD-HN-003']]
  );

  // 7. Sinh dữ liệu vận hành (UC Mới: Food Waste, Local Purchase, Cash Shift)
  const [[qlCauGiay]] = await conn.execute("SELECT id FROM users WHERE phone='0903000001'");
  
  // 7.1. Hao hụt nguyên liệu do hỏng tủ mát
  const [wasteRes] = await conn.execute(
    `INSERT INTO food_waste (branch_id, reason, note, total_cost, created_by) VALUES
     (?, 'SPOILAGE', 'Tủ mát hỏng làm hỏng nguyên liệu (Demo)', 120000, ?)`,
    [branch3, qlCauGiay.id]
  );
  await conn.execute(
    `INSERT INTO food_waste_lines (waste_id, ingredient_id, quantity, unit_cost) VALUES
     (?, 1, 500, 80),
     (?, 15, 300, 60)`,
    [wasteRes.insertId, wasteRes.insertId]
  );

  // 7.2. Mua hàng khẩn cấp (Local purchase)
  await conn.execute(
    `INSERT INTO local_purchases (branch_id, ingredient_id, quantity, unit_price, total_cost, vendor, note, created_by) VALUES
     (?, 13, 24, 8500, 204000, 'Tạp hóa cô Tư', 'Hết Coca đột xuất', ?)`,
    [branch3, qlCauGiay.id]
  );

  // 7.3. Mở ca làm việc & đối soát tiền
  await conn.execute(
    `INSERT INTO cash_shifts (branch_id, opened_by, opening_cash, petty_cash_spent, status, note) VALUES
     (?, ?, 2000000, 204000, 'OPEN', 'Ca sáng Cầu Giấy')`,
    [branch3, qlCauGiay.id]
  );
  // =========================================================================

  console.log('Seed xong. Đăng nhập mật khẩu: Demo@123');
  console.log('SĐT: 0902000001 (khách HCM), 0901000001 (admin), 0901000004 (QL CN HCM), 0901000005 (bếp HCM)');
  console.log('--- KHU VỰC HÀ NỘI ---');
  console.log('SĐT: 0904000001 (Khách Hà Nội)');
  console.log('SĐT: 0903000001 -> 0903000006 (Quản lý & Bếp Hà Nội)');
  await conn.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});