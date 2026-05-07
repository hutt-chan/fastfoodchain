const express = require('express');
const pool = require('../db');
const { auth } = require('../middleware/auth');
const { logAudit } = require('../lib/audit');
const crypto = require('crypto');

const router = express.Router();
const W = auth(['WAREHOUSE_MANAGER', 'ADMIN']);

router.get('/suppliers', W, async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM suppliers ORDER BY id');
  res.json({ suppliers: rows });
});

router.post('/suppliers', W, async (req, res) => {
  const { name, tax_code, contact } = req.body;
  const [ins] = await pool.execute(
    'INSERT INTO suppliers (name, tax_code, contact) VALUES (?,?,?)',
    [name, tax_code || null, contact || null]
  );
  res.json({ id: ins.insertId });
});

router.get('/ingredients', W, async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM ingredients ORDER BY name');
  res.json({ ingredients: rows });
});

router.get('/purchase-orders', W, async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT po.*, s.name AS supplier_name FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id ORDER BY po.id DESC LIMIT 100`
  );
  res.json({ purchase_orders: rows });
});

router.get('/purchase-orders/:id', W, async (req, res) => {
  const [[po]] = await pool.execute(
    `SELECT po.*, s.name AS supplier_name FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ?`,
    [req.params.id]
  );
  if (!po) return res.status(404).json({ error: 'Không tìm thấy' });
  const [lines] = await pool.execute(
    `SELECT pol.*, i.name, i.unit FROM purchase_order_lines pol
     JOIN ingredients i ON i.id = pol.ingredient_id WHERE pol.purchase_order_id = ?`,
    [req.params.id]
  );
  res.json({ purchase_order: po, lines });
});

router.get('/central-inventory', W, async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT ci.*, i.name, i.unit, i.safety_stock_min, i.reorder_point FROM central_inventory ci
     JOIN ingredients i ON i.id = ci.ingredient_id ORDER BY i.name`
  );
  res.json({ inventory: rows });
});

router.post('/purchase-orders', W, async (req, res) => {
  const { supplier_id, lines } = req.body;
  const [ins] = await pool.execute(
    'INSERT INTO purchase_orders (supplier_id, status, total_amount) VALUES (?,?,0)',
    [supplier_id, 'ORDERED']
  );
  const poId = ins.insertId;
  let total = 0;
  for (const l of lines || []) {
    const t = Number(l.qty_ordered) * Number(l.unit_price);
    total += t;
    await pool.execute(
      'INSERT INTO purchase_order_lines (purchase_order_id, ingredient_id, qty_ordered, unit_price) VALUES (?,?,?,?)',
      [poId, l.ingredient_id, l.qty_ordered, l.unit_price]
    );
  }
  await pool.execute('UPDATE purchase_orders SET total_amount = ? WHERE id = ?', [total, poId]);
  await logAudit(req.user.id, 'PO_CREATE', 'warehouse', { poId }, req.ip);
  res.json({ id: poId, total });
});

/** Ghi nhận nhập kho từ PO */
router.post('/purchase-orders/:id/receive', W, async (req, res) => {
  const poId = req.params.id;
  const { lines } = req.body;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const l of lines || []) {
      await conn.execute(
        'UPDATE purchase_order_lines SET qty_received = ? WHERE purchase_order_id = ? AND ingredient_id = ?',
        [l.qty_received, poId, l.ingredient_id]
      );
      await conn.execute(
        'UPDATE central_inventory SET quantity = quantity + ? WHERE ingredient_id = ?',
        [l.qty_received, l.ingredient_id]
      );
    }
    await conn.execute("UPDATE purchase_orders SET status = 'RECEIVED' WHERE id = ?", [poId]);
    await conn.commit();
    // UC-39: kiểm tra và (re)emit alert nếu các nguyên liệu vừa nhập vẫn còn dưới ngưỡng
    const { checkAndEmitLowStockAlerts } = require('../services/inventoryService');
    const ids = (lines || []).map(l => l.ingredient_id);
    if (ids.length) await checkAndEmitLowStockAlerts('CENTRAL', null, ids);
    await logAudit(req.user.id, 'PO_RECEIVE', 'warehouse', { poId }, req.ip);
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
});

router.patch('/ingredients/:id/thresholds', W, async (req, res) => {
  const { safety_stock_min, reorder_point } = req.body;
  await pool.execute(
    'UPDATE ingredients SET safety_stock_min = COALESCE(?, safety_stock_min), reorder_point = COALESCE(?, reorder_point) WHERE id = ?',
    [safety_stock_min, reorder_point, req.params.id]
  );
  res.json({ ok: true });
});

// --- 1. Cập nhật API lấy Phiếu xin hàng ---
router.get('/stock-requests', W, async (req, res) => {
  const filter = req.query.filter || 'pending';
  // Nếu là pending thì lấy các phiếu mới/chờ duyệt. Nếu là history thì lấy các phiếu Đã duyệt/Từ chối.
  const statusCond = filter === 'pending' 
    ? "sr.status IN ('NEEDS_MANUAL','APPROVED_AUTO','NEW')"
    : "sr.status NOT IN ('NEEDS_MANUAL','APPROVED_AUTO','NEW')";

  const [rows] = await pool.execute(
    `SELECT sr.*, b.name AS branch_name FROM stock_requests sr
     JOIN branches b ON b.id = sr.branch_id
     WHERE ${statusCond}
     ORDER BY sr.id DESC LIMIT 100` // Thêm Limit để tránh nặng máy khi lịch sử quá dài
  );
  res.json({ requests: rows });
});

// --- 2. Cập nhật API lấy Phiếu xuất hàng ---
// (Lưu ý: Mình đã đổi tên đường dẫn từ /outbounds/pending thành /outbounds cho chuẩn)
router.get('/outbounds', W, async (req, res) => {
  const filter = req.query.filter || 'pending';
  const statusCond = filter === 'pending'
    ? "o.status = 'PENDING_PICK'"
    : "o.status != 'PENDING_PICK'";

  const [rows] = await pool.execute(
    `SELECT o.*, sr.branch_id FROM stock_outbounds o
     JOIN stock_requests sr ON sr.id = o.stock_request_id
     WHERE ${statusCond} ORDER BY o.id DESC LIMIT 100`
  );
  res.json({ outbounds: rows });
});

// Lấy chi tiết phiếu xuất kho
router.get('/outbounds/:id', W, async (req, res) => {
  const [[ob]] = await pool.execute(
    `SELECT o.*, sr.branch_id, b.name AS branch_name FROM stock_outbounds o
     JOIN stock_requests sr ON sr.id = o.stock_request_id
     JOIN branches b ON b.id = sr.branch_id
     WHERE o.id = ?`,
    [req.params.id]
  );
  if (!ob) return res.status(404).json({ error: 'Không tìm thấy' });
  
  const [lines] = await pool.execute(
    `SELECT sol.*, i.name, i.unit FROM stock_outbound_lines sol
     JOIN ingredients i ON i.id = sol.ingredient_id WHERE sol.stock_outbound_id = ?`,
    [req.params.id]
  );
  res.json({ outbound: ob, lines });
});

router.get('/stock-requests/:id', W, async (req, res) => {
  const [lines] = await pool.execute(
    `SELECT srl.*, i.name FROM stock_request_lines srl
     JOIN ingredients i ON i.id = srl.ingredient_id WHERE srl.stock_request_id = ?`,
    [req.params.id]
  );
  const [[sr]] = await pool.execute('SELECT * FROM stock_requests WHERE id = ?', [req.params.id]);
  res.json({ request: sr, lines });
});

function outboundCode() {
  return 'XK-' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex');
}

/** Duyệt thủ công / điều chỉnh số lượng */
router.post('/stock-requests/:id/resolve', W, async (req, res) => {
  const { approve, lines } = req.body;
  const id = req.params.id;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[sr]] = await conn.execute('SELECT * FROM stock_requests WHERE id = ? FOR UPDATE', [id]);
    if (!sr) {
      await conn.rollback();
      return res.status(404).json({ error: 'Không tìm thấy' });
    }
    if (!approve) {
      await conn.execute(
        `UPDATE stock_requests SET status = 'REJECTED', reject_reason = ? WHERE id = ?`,
        [req.body.reason || 'Từ chối', id]
      );
      await conn.commit();
      return res.json({ ok: true, status: 'REJECTED' });
    }
    for (const l of lines || []) {
      await conn.execute(
        'UPDATE stock_request_lines SET qty_approved = ? WHERE stock_request_id = ? AND ingredient_id = ?',
        [l.qty_approved, id, l.ingredient_id]
      );
    }
    await conn.execute(`UPDATE stock_requests SET status = 'APPROVED_MANUAL' WHERE id = ?`, [id]);
    const [outLines] = await conn.execute(
      'SELECT ingredient_id, qty_approved AS qty FROM stock_request_lines WHERE stock_request_id = ? AND qty_approved > 0',
      [id]
    );
    const [insOut] = await conn.execute(
      'INSERT INTO stock_outbounds (stock_request_id, code, status) VALUES (?,?,?)',
      [id, outboundCode(), 'PENDING_PICK']
    );
    const oid = insOut.insertId;
    for (const ol of outLines) {
      const q = Number(ol.qty);
      if (q <= 0) continue;
      const [[ci]] = await conn.execute(
        'SELECT quantity FROM central_inventory WHERE ingredient_id = ? FOR UPDATE',
        [ol.ingredient_id]
      );
      if (!ci || Number(ci.quantity) < q) {
        await conn.rollback();
        return res.status(400).json({ error: 'Tồn kho tổng không đủ', ingredient_id: ol.ingredient_id });
      }
      await conn.execute(
        'INSERT INTO stock_outbound_lines (stock_outbound_id, ingredient_id, quantity) VALUES (?,?,?)',
        [oid, ol.ingredient_id, q]
      );
    }
    await conn.commit();
    await logAudit(req.user.id, 'STOCK_REQUEST_APPROVE', 'warehouse', { id, outbound_id: oid }, req.ip);
    res.json({ ok: true, outbound_id: oid });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
});

router.post('/outbounds/:id/ship', W, async (req, res) => {
  const { trip_code } = req.body;
  await pool.execute(
    `UPDATE stock_outbounds SET status = 'SHIPPED', trip_code = ?, shipped_at = NOW() WHERE id = ?`,
    [trip_code || null, req.params.id]
  );
  const [[ob]] = await pool.execute('SELECT stock_request_id FROM stock_outbounds WHERE id = ?', [
    req.params.id,
  ]);
  const [lines] = await pool.execute(
    'SELECT ingredient_id, quantity FROM stock_outbound_lines WHERE stock_outbound_id = ?',
    [req.params.id]
  );
  const [[sr]] = await pool.execute('SELECT branch_id FROM stock_requests WHERE id = ?', [
    ob.stock_request_id,
  ]);
  for (const l of lines) {
    const q = Number(l.quantity);
    const [[ci]] = await pool.execute(
      'SELECT quantity FROM central_inventory WHERE ingredient_id = ?',
      [l.ingredient_id]
    );
    if (!ci || Number(ci.quantity) < q) {
      return res.status(400).json({ error: 'Ton kho tong khong du de xuat', ingredient_id: l.ingredient_id });
    }
    await pool.execute(
      'UPDATE central_inventory SET quantity = quantity - ? WHERE ingredient_id = ?',
      [q, l.ingredient_id]
    );
    await pool.execute(
      'UPDATE branch_inventory SET quantity = quantity + ? WHERE branch_id = ? AND ingredient_id = ?',
      [q, sr.branch_id, l.ingredient_id]
    );
  }
  await pool.execute(`UPDATE stock_requests SET status = 'FULFILLED' WHERE id = ?`, [ob.stock_request_id]);
  const inv = require('../services/inventoryService');
  await inv.refreshBranchProductAvailability(sr.branch_id);
  // UC-39: emit alerts cho cả kho tổng (vừa trừ) và chi nhánh (vừa cộng)
  const ingIds = lines.map(l => l.ingredient_id);
  await inv.checkAndEmitLowStockAlerts('CENTRAL', null, ingIds);
  await inv.checkAndEmitLowStockAlerts('BRANCH', sr.branch_id, ingIds);
  res.json({ ok: true });
});

module.exports = router;
