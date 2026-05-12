const express = require('express');
const pool = require('../db');
const { auth } = require('../middleware/auth');
const { logAudit } = require('../lib/audit');
const { refreshBranchProductAvailability } = require('../services/inventoryService');

const router = express.Router();
const C = auth(['CHAIN_MANAGER', 'ADMIN']);

router.get('/branches', C, async (req, res) => {
  const [rows] = await pool.execute('SELECT id, name, address, is_active FROM branches ORDER BY id');
  res.json({ branches: rows });
});

router.get('/products/:id', C, async (req, res) => {
  const [[p]] = await pool.execute(
    `SELECT p.*, c.name AS category_name FROM products p
     JOIN categories c ON c.id = p.category_id WHERE p.id = ?`,
    [req.params.id]
  );
  if (!p) return res.status(404).json({ error: 'Không tìm thấy' });
  res.json({ product: p });
});

router.get('/categories', C, async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM categories ORDER BY sort_order');
  res.json({ categories: rows });
});

router.post('/categories', C, async (req, res) => {
  const { name, sort_order } = req.body;
  const [ins] = await pool.execute('INSERT INTO categories (name, sort_order) VALUES (?,?)', [
    name,
    sort_order || 0,
  ]);
  res.json({ id: ins.insertId });
});

// Sửa danh mục
router.patch('/categories/:id', C, async (req, res) => {
  const { name, sort_order } = req.body;
  await pool.execute(
    'UPDATE categories SET name = COALESCE(?, name), sort_order = COALESCE(?, sort_order) WHERE id = ?',
    [name, sort_order, req.params.id]
  );
  await logAudit(req.user.id, 'CATEGORY_UPDATE', 'chain', req.body, req.ip);
  res.json({ ok: true });
});

// Xóa danh mục
router.delete('/categories/:id', C, async (req, res) => {
  const [[check]] = await pool.execute('SELECT COUNT(*) AS c FROM products WHERE category_id = ? AND is_deleted = 0', [req.params.id]);
  if (check.c > 0) return res.status(400).json({ error: 'Không thể xóa danh mục đang có sản phẩm hoạt động' });
  
  await pool.execute('DELETE FROM categories WHERE id = ?', [req.params.id]);
  await logAudit(req.user.id, 'CATEGORY_DELETE', 'chain', { id: req.params.id }, req.ip);
  res.json({ ok: true });
});

// --- PHẦN NGUYÊN LIỆU (INGREDIENTS) ---

router.get('/ingredients', C, async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM ingredients ORDER BY name');
  res.json({ ingredients: rows });
});

router.post('/ingredients', C, async (req, res) => {
  // 1. Phải lấy dữ liệu từ req.body ra TRƯỚC
  const { name, unit, purchase_unit, conversion_rate, purchase_price_input, safety_stock_min, reorder_point } = req.body;
  
  // 2. Chặn lỗi thiếu thông tin cơ bản
  if (!name || !unit) {
    return res.status(400).json({ error: 'Tên và đơn vị cơ bản không được để trống' });
  }

  // 3. Kiểm tra trùng tên nguyên liệu
  const [[exist]] = await pool.execute('SELECT id FROM ingredients WHERE name = ?', [name]);
  if (exist) {
    return res.status(400).json({ error: 'Nguyên liệu này đã tồn tại trong hệ thống' });
  }
  
  // 4. Tính toán giá vốn cơ bản (unit_cost) = Giá nhập / Tỷ lệ
  const rate = Number(conversion_rate || 1);
  const base_cost = (purchase_price_input !== undefined && purchase_price_input !== null) 
    ? Number(purchase_price_input) / rate 
    : 0;

  // 5. Lưu nguyên liệu vào database
  const [ins] = await pool.execute(
    `INSERT INTO ingredients (name, unit, purchase_unit, conversion_rate, unit_cost, safety_stock_min, reorder_point) 
     VALUES (?,?,?,?,?,?,?)`,
    [name, unit, purchase_unit || null, rate, base_cost, safety_stock_min || 0, reorder_point || 0]
  );
  const iid = ins.insertId;
  
  // 6. Khởi tạo tồn kho = 0 cho kho tổng
  await pool.execute('INSERT INTO central_inventory (ingredient_id, quantity) VALUES (?,0)', [iid]);
  
  // 7. Khởi tạo tồn kho = 0 cho TẤT CẢ các chi nhánh hiện tại
  const [branches] = await pool.execute('SELECT id FROM branches');
  for (const b of branches) {
    await pool.execute(
      'INSERT INTO branch_inventory (branch_id, ingredient_id, quantity) VALUES (?,?,0)',
      [b.id, iid]
    );
  }
  
  // (Tùy chọn) Ghi log audit nếu bạn muốn
  // await logAudit(req.user.id, 'INGREDIENT_CREATE', 'chain', { id: iid, name }, req.ip);
  
  res.json({ id: iid });
});

router.patch('/ingredients/:id', C, async (req, res) => {
  // 1. Phải lấy dữ liệu từ req.body ra TRƯỚC
  const { name, unit, purchase_unit, conversion_rate, purchase_price_input, safety_stock_min, reorder_point } = req.body;
  
  // 2. SAU ĐÓ mới dùng biến 'name' để kiểm tra trùng lặp trong DB
  if (name) {
    const [[exist]] = await pool.execute(
      'SELECT id FROM ingredients WHERE name = ? AND id != ?', 
      [name, req.params.id]
    );
    if (exist) return res.status(400).json({ error: 'Tên nguyên liệu này đã bị trùng với một mã khác' });
  }

  // 3. Tính toán lại giá vốn cơ bản
  let unit_cost = null;
  if (purchase_price_input !== undefined && purchase_price_input !== null && conversion_rate) {
     unit_cost = Number(purchase_price_input) / Number(conversion_rate);
  }

  // 4. Cập nhật vào DB
  await pool.execute(
    `UPDATE ingredients SET 
      name = COALESCE(?, name), 
      unit = COALESCE(?, unit), 
      purchase_unit = COALESCE(?, purchase_unit),
      conversion_rate = COALESCE(?, conversion_rate),
      unit_cost = COALESCE(?, unit_cost),
      safety_stock_min = COALESCE(?, safety_stock_min), 
      reorder_point = COALESCE(?, reorder_point)
     WHERE id = ?`,
    [name, unit, purchase_unit, conversion_rate, unit_cost, safety_stock_min, reorder_point, req.params.id]
  );
  
  await logAudit(req.user.id, 'INGREDIENT_UPDATE', 'chain', req.body, req.ip);
  res.json({ ok: true });
});

router.delete('/ingredients/:id', C, async (req, res) => {
  try {
    // 1. Kiểm tra tồn kho (Nghiêm cấm xóa nếu còn hàng)
    const [[cStock]] = await pool.execute('SELECT SUM(quantity) as qty FROM central_inventory WHERE ingredient_id = ?', [req.params.id]);
    const [[bStock]] = await pool.execute('SELECT SUM(quantity) as qty FROM branch_inventory WHERE ingredient_id = ?', [req.params.id]);
    
    if ((cStock && Number(cStock.qty) > 0) || (bStock && Number(bStock.qty) > 0)) {
      return res.status(400).json({ error: 'Không thể xóa! Nguyên liệu này vẫn đang còn tồn kho thực tế.' });
    }

    // 2. Kiểm tra định mức BOM
    const [[checkBom]] = await pool.execute('SELECT COUNT(*) AS c FROM product_bom WHERE ingredient_id = ?', [req.params.id]);
    if (checkBom.c > 0) return res.status(400).json({ error: 'Không thể xóa! Nguyên liệu đang nằm trong BOM của món ăn.' });

    // 3. Tiến hành xóa nếu an toàn
    await pool.execute('DELETE FROM central_inventory WHERE ingredient_id = ?', [req.params.id]);
    await pool.execute('DELETE FROM branch_inventory WHERE ingredient_id = ?', [req.params.id]);
    await pool.execute('DELETE FROM ingredients WHERE id = ?', [req.params.id]);
    
    await logAudit(req.user.id, 'INGREDIENT_DELETE', 'chain', { id: req.params.id }, req.ip);
    res.json({ ok: true });

  } catch (err) {
    // 4. Bắt lỗi khóa ngoại (Đã từng nhập/xuất hàng)
    if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.errno === 1451) {
      return res.status(400).json({ error: 'Không thể xóa! Nguyên liệu đã có lịch sử giao dịch (Nhập/Xuất/Hủy).' });
    }
    console.error(err);
    res.status(500).json({ error: 'Lỗi server khi xóa nguyên liệu' });
  }
});

// --- PHẦN SẢN PHẨM & REPORT... (Giữ nguyên phần dưới) ---
router.get('/products', C, async (req, res) => {
  const includeDeleted = req.query.include_deleted === '1';
  const [rows] = await pool.execute(
    `SELECT p.*, c.name AS category_name FROM products p JOIN categories c ON c.id = p.category_id
     ${includeDeleted ? '' : 'WHERE p.is_deleted = 0'} ORDER BY p.id`
  );
  res.json({ products: rows });
});

router.delete('/products/:id', C, async (req, res) => {
  await pool.execute(
    'UPDATE products SET is_deleted = 1, deleted_at = NOW(), is_active_chain = 0 WHERE id = ?',
    [req.params.id]
  );
  await pool.execute(
    'UPDATE branch_menu SET is_available = 0 WHERE product_id = ?',
    [req.params.id]
  );
  await logAudit(req.user.id, 'PRODUCT_SOFT_DELETE', 'chain', { pid: req.params.id }, req.ip);
  res.json({ ok: true });
});

router.post('/products/:id/restore', C, async (req, res) => {
  await pool.execute(
    'UPDATE products SET is_deleted = 0, deleted_at = NULL, is_active_chain = 1 WHERE id = ?',
    [req.params.id]
  );
  const [branches] = await pool.execute('SELECT id FROM branches');
  for (const b of branches) {
    await refreshBranchProductAvailability(b.id, [Number(req.params.id)]);
  }
  await logAudit(req.user.id, 'PRODUCT_RESTORE', 'chain', { pid: req.params.id }, req.ip);
  res.json({ ok: true });
});

router.post('/products', C, async (req, res) => {
  const { category_id, name, description, base_price, prep_time_minutes, image_url } = req.body;
  const [ins] = await pool.execute(
    `INSERT INTO products (category_id, name, description, base_price, prep_time_minutes, image_url) VALUES (?,?,?,?,?,?)`,
    [category_id, name, description || null, base_price, prep_time_minutes || 15, image_url || null]
  );
  const pid = ins.insertId;
  const [branches] = await pool.execute('SELECT id FROM branches');
  for (const b of branches) {
    await pool.execute(
      'INSERT INTO branch_menu (branch_id, product_id, is_available) VALUES (?,?,1)',
      [b.id, pid]
    );
  }
  await logAudit(req.user.id, 'PRODUCT_CREATE', 'chain', { pid }, req.ip);
  res.json({ id: pid });
});

router.patch('/products/:id', C, async (req, res) => {
  const f = req.body;
  const pid = req.params.id;
  try {
    await pool.execute(
      `UPDATE products SET 
         category_id = COALESCE(?, category_id), 
         name = COALESCE(?, name), 
         description = COALESCE(?, description),
         base_price = COALESCE(?, base_price), 
         prep_time_minutes = COALESCE(?, prep_time_minutes),
         is_active_chain = COALESCE(?, is_active_chain), 
         image_url = COALESCE(?, image_url)
       WHERE id = ?`,
      [
        f.category_id ?? null, f.name ?? null, f.description ?? null,
        f.base_price ?? null, f.prep_time_minutes ?? null,
        f.is_active_chain ?? null, f.image_url ?? null, pid
      ]
    );
    await logAudit(req.user.id, 'PRODUCT_UPDATE', 'chain', { pid, ...f }, req.ip);
    res.json({ ok: true });
  } catch (error) {
    console.error('Lỗi Update Product:', error);
    res.status(500).json({ error: 'Lỗi server khi cập nhật sản phẩm' });
  }
});

router.get('/products/:id/bom', C, async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT b.*, i.name AS ingredient_name, i.unit FROM product_bom b
     JOIN ingredients i ON i.id = b.ingredient_id WHERE b.product_id = ?`,
    [req.params.id]
  );
  res.json({ bom: rows });
});

router.post('/products/:id/bom', C, async (req, res) => {
  const { lines } = req.body;
  const pid = req.params.id;
  await pool.execute('DELETE FROM product_bom WHERE product_id = ?', [pid]);
  for (const l of lines || []) {
    await pool.execute(
      'INSERT INTO product_bom (product_id, ingredient_id, qty_per_unit, is_optional) VALUES (?,?,?,?)',
      [pid, l.ingredient_id, l.qty_per_unit, l.is_optional ? 1 : 0]
    );
  }
  const [branches] = await pool.execute('SELECT id FROM branches');
  for (const b of branches) {
    await refreshBranchProductAvailability(b.id);
  }
  await logAudit(req.user.id, 'BOM_UPDATE', 'chain', { pid }, req.ip);
  res.json({ ok: true });
});

router.get('/vouchers', C, async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM vouchers ORDER BY id DESC');
  res.json({ vouchers: rows });
});

router.post('/vouchers', C, async (req, res) => {
  const { code, discount_type, discount_value, min_order_amount, max_uses, branch_id, valid_from, valid_to } = req.body;
  await pool.execute(
    `INSERT INTO vouchers (code, discount_type, discount_value, min_order_amount, max_uses, branch_id, valid_from, valid_to)
     VALUES (?,?,?,?,?,?,?,?)`,
    [code, discount_type, discount_value, min_order_amount || 0, max_uses || 1000, branch_id || null, valid_from, valid_to]
  );
  res.json({ ok: true });
});

// UC-17: Bật / Tắt tạm dừng Voucher
router.patch('/vouchers/:id/toggle', C, async (req, res) => {
  const { is_active } = req.body;
  await pool.execute(
    'UPDATE vouchers SET is_active = ? WHERE id = ?',
    [is_active ? 1 : 0, req.params.id]
  );
  await logAudit(req.user.id, 'VOUCHER_TOGGLE', 'chain', { id: req.params.id, is_active }, req.ip);
  res.json({ ok: true });
});

router.get('/reports/summary', C, async (req, res) => {
  const from = req.query.from || '1970-01-01';
  const to = req.query.to || '2099-12-31';
  const type = req.query.type || 'day';
  const branchId = req.query.branch_id;

  let branchFilter = '';
  const params = [from, to];
  if (branchId && branchId !== 'all') {
    branchFilter = ' AND branch_id = ?';
    params.push(branchId);
  }

  const [[rev]] = await pool.execute(
    `SELECT COALESCE(SUM(total),0) AS revenue, COUNT(*) AS order_count FROM orders
     WHERE status NOT IN ('CANCELLED','PENDING_PAYMENT') AND DATE(created_at) BETWEEN ? AND ?${branchFilter}`,
    params
  );

  const [top] = await pool.execute(
    `SELECT oi.product_name, SUM(oi.quantity) AS qty FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.status = 'COMPLETED' AND DATE(o.created_at) BETWEEN ? AND ?${branchFilter}
     GROUP BY oi.product_name ORDER BY qty DESC LIMIT 10`,
    params
  );

  const [[cancel]] = await pool.execute(
    `SELECT COUNT(*) AS c FROM orders WHERE status = 'CANCELLED' AND DATE(created_at) BETWEEN ? AND ?${branchFilter}`,
    params
  );

  let dateFormatSQL = '';
  if (type === 'day') dateFormatSQL = 'DATE_FORMAT(created_at, "%Y-%m-%d")';
  else if (type === 'month') dateFormatSQL = 'DATE_FORMAT(created_at, "%Y-%m")';
  else if (type === 'year') dateFormatSQL = 'DATE_FORMAT(created_at, "%Y")';

  const [details] = await pool.execute(
    `SELECT ${dateFormatSQL} AS label, COALESCE(SUM(total),0) AS revenue, COUNT(*) AS orders 
     FROM orders WHERE status = 'COMPLETED' AND DATE(created_at) BETWEEN ? AND ?${branchFilter}
     GROUP BY label ORDER BY label DESC`,
    params
  );

  res.json({ revenue: rev, top_products: top, cancelled: cancel.c, details: details });
});

router.get('/inventory-adjustments', C, async (req, res) => {
  const status = req.query.status || 'PENDING';
  const [rows] = await pool.execute(
    `SELECT a.*, b.name AS branch_name, u.full_name AS creator_name
     FROM inventory_adjustments a
     JOIN branches b ON b.id = a.branch_id
     LEFT JOIN users u ON u.id = a.created_by
     WHERE a.status = ? ORDER BY a.id DESC LIMIT 100`,
    [status]
  );
  res.json({ adjustments: rows });
});

router.get('/inventory-adjustments/:id', C, async (req, res) => {
  const [[adj]] = await pool.execute(
    `SELECT a.*, b.name AS branch_name FROM inventory_adjustments a
     JOIN branches b ON b.id = a.branch_id WHERE a.id = ?`,
    [req.params.id]
  );
  if (!adj) return res.status(404).json({ error: 'Không tìm thấy' });
  const [lines] = await pool.execute(
    `SELECT l.*, i.name AS ingredient_name, i.unit FROM inventory_adjustment_lines l
     JOIN ingredients i ON i.id = l.ingredient_id WHERE l.adjustment_id = ?`,
    [req.params.id]
  );
  res.json({ adjustment: adj, lines });
});

router.post('/inventory-adjustments/:id/review', C, async (req, res) => {
  const { approve, reason } = req.body;
  const id = req.params.id;
  const conn = await pool.getConnection();
  const { checkAndEmitLowStockAlerts } = require('../services/inventoryService');
  try {
    await conn.beginTransaction();
    const [[adj]] = await conn.execute('SELECT * FROM inventory_adjustments WHERE id = ? FOR UPDATE', [id]);
    if (!adj) { await conn.rollback(); return res.status(404).json({ error: 'Không tìm thấy' }); }
    if (adj.status !== 'PENDING') {
      await conn.rollback(); return res.status(400).json({ error: 'Phiếu đã được xử lý' });
    }
    if (!approve) {
      await conn.execute(
        `UPDATE inventory_adjustments SET status='REJECTED', reject_reason=?, reviewed_by=?, reviewed_at=NOW() WHERE id=?`,
        [reason || 'QL chuỗi từ chối', req.user.id, id]
      );
      await conn.commit();
      await logAudit(req.user.id, 'INV_ADJUST_REJECT', 'chain', { id }, req.ip);
      return res.json({ ok: true, status: 'REJECTED' });
    }
    const [lines] = await conn.execute(
      'SELECT ingredient_id, qty_after FROM inventory_adjustment_lines WHERE adjustment_id = ?',
      [id]
    );
    for (const l of lines) {
      await conn.execute(
        'UPDATE branch_inventory SET quantity = ? WHERE branch_id = ? AND ingredient_id = ?',
        [l.qty_after, adj.branch_id, l.ingredient_id]
      );
    }
    await conn.execute(
      `UPDATE inventory_adjustments SET status='APPROVED', reviewed_by=?, reviewed_at=NOW() WHERE id=?`,
      [req.user.id, id]
    );
    await conn.commit();
    await checkAndEmitLowStockAlerts('BRANCH', adj.branch_id, lines.map(l => l.ingredient_id));
    await logAudit(req.user.id, 'INV_ADJUST_APPROVE', 'chain', { id }, req.ip);
    res.json({ ok: true, status: 'APPROVED' });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
});

// --- UC-18: ĐỐI SOÁT THANH TOÁN (LOCAL SIMULATION) ---
router.post('/reconcile', C, async (req, res) => {
  // partner_data là mảng các object đối tác gửi. VD: [{ order_code: 'ORD-123', partner_amount: 150000 }]
  const { partner_data, payment_method } = req.body;
  if (!partner_data || !partner_data.length) return res.status(400).json({ error: 'Dữ liệu trống' });

  const codes = partner_data.map(d => d.order_code);
  const [orders] = await pool.execute(
    `SELECT id, order_code, total, payment_method, payment_status FROM orders WHERE order_code IN (${codes.map(() => '?').join(',')})`,
    codes
  );

  const results = { matched: [], mismatched: [], not_found: [] };
  const toUpdate = [];

  for (const p of partner_data) {
    const local = orders.find(o => o.order_code === p.order_code);

    // Lỗi 1: Không tìm thấy đơn trên hệ thống
    if (!local) {
      results.not_found.push({ code: p.order_code, partner_amount: p.partner_amount });
      continue;
    }

    // Lỗi: Đơn đã được đối soát/thanh toán từ trước
    if (local.payment_status === 'PAID' || local.payment_status === 'COMPLETED') {
      results.mismatched.push({ 
        code: p.order_code, 
        local_total: local.total, 
        partner_amount: p.partner_amount, 
        reason: 'Đơn đã được đối soát trước đó' 
      });
      continue;
    }
    
    // Lỗi 2: Sai phương thức thanh toán
    if (local.payment_method !== payment_method) {
        results.mismatched.push({ code: p.order_code, local_total: local.total, partner_amount: p.partner_amount, reason: 'Sai phương thức (' + local.payment_method + ')' });
        continue;
    }
    
    // Lỗi 3: Lệch tiền
    if (Number(local.total) !== Number(p.partner_amount)) {
      results.mismatched.push({ code: p.order_code, local_total: local.total, partner_amount: p.partner_amount, reason: 'Lệch tiền' });
      continue;
    }
    
    // Khớp hoàn toàn
    results.matched.push(p.order_code);
    toUpdate.push(local.id);
  }

  // Tự động cập nhật các đơn khớp thành công
  if (toUpdate.length > 0) {
    await pool.execute(`UPDATE orders SET payment_status = 'PAID' WHERE id IN (${toUpdate.map(() => '?').join(',')})`, toUpdate);
  }
  
  await logAudit(req.user.id, 'RECONCILE_EXECUTE', 'chain', { matched: toUpdate.length }, req.ip);
  res.json(results);
});

module.exports = router;