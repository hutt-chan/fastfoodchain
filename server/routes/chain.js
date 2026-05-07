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

// --- PHẦN DANH MỤC (CATEGORIES) ---

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
  // Kiểm tra xem danh mục có đang chứa sản phẩm nào không
  const [[check]] = await pool.execute('SELECT COUNT(*) AS c FROM products WHERE category_id = ? AND is_deleted = 0', [req.params.id]);
  if (check.c > 0) return res.status(400).json({ error: 'Không thể xóa danh mục đang có sản phẩm hoạt động' });
  
  await pool.execute('DELETE FROM categories WHERE id = ?', [req.params.id]);
  await logAudit(req.user.id, 'CATEGORY_DELETE', 'chain', { id: req.params.id }, req.ip);
  res.json({ ok: true });
});

// --- PHẦN NGUYÊN LIỆU (INGREDIENTS) ---

// Sửa nguyên liệu
router.patch('/ingredients/:id', C, async (req, res) => {
  const { name, unit, unit_cost, safety_stock_min, reorder_point } = req.body;
  await pool.execute(
    `UPDATE ingredients SET 
      name = COALESCE(?, name), unit = COALESCE(?, unit), unit_cost = COALESCE(?, unit_cost),
      safety_stock_min = COALESCE(?, safety_stock_min), reorder_point = COALESCE(?, reorder_point)
     WHERE id = ?`,
    [name, unit, unit_cost, safety_stock_min, reorder_point, req.params.id]
  );
  await logAudit(req.user.id, 'INGREDIENT_UPDATE', 'chain', req.body, req.ip);
  res.json({ ok: true });
});

// Xóa nguyên liệu
router.delete('/ingredients/:id', C, async (req, res) => {
  // Kiểm tra xem nguyên liệu có đang được dùng trong BOM sản phẩm nào không
  const [[check]] = await pool.execute('SELECT COUNT(*) AS c FROM product_bom WHERE ingredient_id = ?', [req.params.id]);
  if (check.c > 0) return res.status(400).json({ error: 'Nguyên liệu đang được sử dụng trong BOM, không thể xóa' });

  // Xóa kho liên quan trước khi xóa nguyên liệu
  await pool.execute('DELETE FROM central_inventory WHERE ingredient_id = ?', [req.params.id]);
  await pool.execute('DELETE FROM branch_inventory WHERE ingredient_id = ?', [req.params.id]);
  await pool.execute('DELETE FROM ingredients WHERE id = ?', [req.params.id]);
  
  await logAudit(req.user.id, 'INGREDIENT_DELETE', 'chain', { id: req.params.id }, req.ip);
  res.json({ ok: true });
});

router.get('/products', C, async (req, res) => {
  const includeDeleted = req.query.include_deleted === '1';
  const [rows] = await pool.execute(
    `SELECT p.*, c.name AS category_name FROM products p JOIN categories c ON c.id = p.category_id
     ${includeDeleted ? '' : 'WHERE p.is_deleted = 0'} ORDER BY p.id`
  );
  res.json({ products: rows });
});

/** UC-15: Soft-delete sản phẩm — ẩn với khách mới, giữ dữ liệu cho đơn cũ */
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

// router.put('/products/:id', C, async (req, res) => {
//   const f = req.body;
//   await pool.execute(
//     `UPDATE products SET name = COALESCE(?, name), description = COALESCE(?, description),
//      base_price = COALESCE(?, base_price), prep_time_minutes = COALESCE(?, prep_time_minutes),
//      is_active_chain = COALESCE(?, is_active_chain), image_url = COALESCE(?, image_url)
//      WHERE id = ?`,
//     [f.name, f.description, f.base_price, f.prep_time_minutes, f.is_active_chain, f.image_url, req.params.id]
//   );
//   await logAudit(req.user.id, 'PRODUCT_UPDATE', 'chain', req.body, req.ip);
//   res.json({ ok: true });
// });
// Đổi thành router.patch để khớp với Frontend
router.patch('/products/:id', C, async (req, res) => {
  const f = req.body;
  const pid = req.params.id;

  try {
    // Sử dụng COALESCE để chỉ cập nhật những trường được gửi lên, giữ nguyên nếu null/undefined
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
        f.category_id ?? null,
        f.name ?? null,
        f.description ?? null,
        f.base_price ?? null,
        f.prep_time_minutes ?? null,
        f.is_active_chain ?? null,
        f.image_url ?? null,
        pid
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

router.get('/ingredients', C, async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM ingredients ORDER BY name');
  res.json({ ingredients: rows });
});

router.post('/ingredients', C, async (req, res) => {
  const { name, unit, unit_cost, safety_stock_min, reorder_point } = req.body;
  const [ins] = await pool.execute(
    `INSERT INTO ingredients (name, unit, unit_cost, safety_stock_min, reorder_point) VALUES (?,?,?,?,?)`,
    [name, unit, unit_cost || 0, safety_stock_min || 0, reorder_point || 0]
  );
  const iid = ins.insertId;
  await pool.execute('INSERT INTO central_inventory (ingredient_id, quantity) VALUES (?,0)', [iid]);
  const [branches] = await pool.execute('SELECT id FROM branches');
  for (const b of branches) {
    await pool.execute(
      'INSERT INTO branch_inventory (branch_id, ingredient_id, quantity) VALUES (?,?,0)',
      [b.id, iid]
    );
  }
  res.json({ id: iid });
});

router.get('/vouchers', C, async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM vouchers ORDER BY id DESC');
  res.json({ vouchers: rows });
});

router.post('/vouchers', C, async (req, res) => {
  const {
    code,
    discount_type,
    discount_value,
    min_order_amount,
    max_uses,
    branch_id,
    valid_from,
    valid_to,
  } = req.body;
  await pool.execute(
    `INSERT INTO vouchers (code, discount_type, discount_value, min_order_amount, max_uses, branch_id, valid_from, valid_to)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      code,
      discount_type,
      discount_value,
      min_order_amount || 0,
      max_uses || 1000,
      branch_id || null,
      valid_from,
      valid_to,
    ]
  );
  res.json({ ok: true });
});

// router.get('/reports/summary', C, async (req, res) => {
//   const from = req.query.from || '1970-01-01';
//   const to = req.query.to || '2099-12-31';
//   const [[rev]] = await pool.execute(
//     `SELECT COALESCE(SUM(total),0) AS revenue, COUNT(*) AS order_count FROM orders
//      WHERE status NOT IN ('CANCELLED','PENDING_PAYMENT') AND DATE(created_at) BETWEEN ? AND ?`,
//     [from, to]
//   );
//   const [top] = await pool.execute(
//     `SELECT oi.product_name, SUM(oi.quantity) AS qty FROM order_items oi
//      JOIN orders o ON o.id = oi.order_id
//      WHERE o.status = 'COMPLETED' AND DATE(o.created_at) BETWEEN ? AND ?
//      GROUP BY oi.product_name ORDER BY qty DESC LIMIT 10`,
//     [from, to]
//   );
//   const [[cancel]] = await pool.execute(
//     `SELECT COUNT(*) AS c FROM orders WHERE status = 'CANCELLED' AND DATE(created_at) BETWEEN ? AND ?`,
//     [from, to]
//   );
//   res.json({ revenue: rev, top_products: top, cancelled: cancel.c });
// });

router.get('/reports/summary', C, async (req, res) => {
  const from = req.query.from || '1970-01-01';
  const to = req.query.to || '2099-12-31';
  const type = req.query.type || 'day';
  const branchId = req.query.branch_id;

  // Xây dựng câu điều kiện WHERE cho chi nhánh (nếu có chọn)
  let branchFilter = '';
  const params = [from, to];
  if (branchId && branchId !== 'all') {
    branchFilter = ' AND branch_id = ?';
    params.push(branchId);
  }

  // 1. Tổng quan Doanh thu & Số đơn
  const [[rev]] = await pool.execute(
    `SELECT COALESCE(SUM(total),0) AS revenue, COUNT(*) AS order_count FROM orders
     WHERE status NOT IN ('CANCELLED','PENDING_PAYMENT') AND DATE(created_at) BETWEEN ? AND ?${branchFilter}`,
    params
  );

  // 2. Top sản phẩm bán chạy
  const [top] = await pool.execute(
    `SELECT oi.product_name, SUM(oi.quantity) AS qty FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.status = 'COMPLETED' AND DATE(o.created_at) BETWEEN ? AND ?${branchFilter}
     GROUP BY oi.product_name ORDER BY qty DESC LIMIT 10`,
    params
  );

  // 3. Đơn hủy
  const [[cancel]] = await pool.execute(
    `SELECT COUNT(*) AS c FROM orders WHERE status = 'CANCELLED' AND DATE(created_at) BETWEEN ? AND ?${branchFilter}`,
    params
  );

  // 4. Chi tiết doanh thu theo Ngày/Tháng/Năm
  let dateFormatSQL = '';
  if (type === 'day') dateFormatSQL = 'DATE_FORMAT(created_at, "%Y-%m-%d")';
  else if (type === 'month') dateFormatSQL = 'DATE_FORMAT(created_at, "%Y-%m")';
  else if (type === 'year') dateFormatSQL = 'DATE_FORMAT(created_at, "%Y")';

  const [details] = await pool.execute(
    `SELECT 
        ${dateFormatSQL} AS label, 
        COALESCE(SUM(total),0) AS revenue, 
        COUNT(*) AS orders 
     FROM orders
     WHERE status = 'COMPLETED' AND DATE(created_at) BETWEEN ? AND ?${branchFilter}
     GROUP BY label
     ORDER BY label DESC`,
    params
  );

  res.json({ revenue: rev, top_products: top, cancelled: cancel.c, details: details });
});

/** UC-30: QL chuỗi xem & duyệt phiếu điều chỉnh tồn kho do chi nhánh tạo */
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
      await conn.rollback();
      return res.status(400).json({ error: 'Phiếu đã được xử lý' });
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
    // Áp dụng các dòng vào branch_inventory
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

module.exports = router;