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

// TÌM VÀ THAY THẾ API POST /suppliers CŨ BẰNG ĐOẠN NÀY:
router.post('/suppliers', W, async (req, res) => {
  const { name, tax_code, contact } = req.body;
  try {
    const [ins] = await pool.execute(
      'INSERT INTO suppliers (name, tax_code, contact) VALUES (?,?,?)',
      [name, tax_code || null, contact || null]
    );
    res.json({ id: ins.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Mã số thuế đã tồn tại trong hệ thống.' });
    }
    throw err;
  }
});

// THÊM MỚI API NÀY NGAY BÊN DƯỚI: Sửa / Tạm ngưng nhà cung cấp
router.put('/suppliers/:id', W, async (req, res) => {
  const { name, tax_code, contact, is_active } = req.body;
  try {
    await pool.execute(
      'UPDATE suppliers SET name = ?, tax_code = ?, contact = ?, is_active = ? WHERE id = ?',
      [name, tax_code || null, contact || null, is_active ? 1 : 0, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Mã số thuế đã bị trùng với nhà cung cấp khác.' });
    }
    throw err;
  }
});

router.get('/ingredients', W, async (req, res) => {
  const [rows] = await pool.execute('SELECT * FROM ingredients ORDER BY name');
  res.json({ ingredients: rows });
});

// UC-21: Nhập kho từ PO với quy đổi đơn vị và Transaction + Ghi Thẻ Kho
// UC-21: Nhập kho từ PO + FEFO (Lưu lô hàng)
router.post('/purchase-orders/:id/receive', W, async (req, res) => {
  const poId = req.params.id;
  const { lines } = req.body; // Thêm exp_date từ UI
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let allReceived = true;

    for (const l of lines || []) {
      if (!l.exp_date) throw new Error('Vui lòng nhập Hạn sử dụng cho tất cả nguyên liệu');
      
      await conn.execute(
        'UPDATE purchase_order_lines SET qty_received = COALESCE(qty_received, 0) + ? WHERE purchase_order_id = ? AND ingredient_id = ?',
        [l.qty_received, poId, l.ingredient_id]
      );
      
      const [[ing]] = await conn.execute('SELECT conversion_rate FROM ingredients WHERE id = ?', [l.ingredient_id]);
      const rate = ing ? Number(ing.conversion_rate) : 1;
      const qtyBase = Number(l.qty_received) * rate;

      // 1. Cập nhật Tồn kho tổng
      const [[ci]] = await conn.execute('SELECT quantity FROM central_inventory WHERE ingredient_id = ? FOR UPDATE', [l.ingredient_id]);
      const currentQty = ci ? Number(ci.quantity) : 0;
      const newQty = currentQty + qtyBase;
      if (!ci) await conn.execute('INSERT INTO central_inventory (ingredient_id, quantity) VALUES (?, ?)', [l.ingredient_id, newQty]);
      else await conn.execute('UPDATE central_inventory SET quantity = ? WHERE ingredient_id = ?', [newQty, l.ingredient_id]);

      // 2. Ghi Thẻ kho
      await conn.execute(
        'INSERT INTO central_inventory_transactions (ingredient_id, transaction_type, reference_id, qty_change, qty_after) VALUES (?, ?, ?, ?, ?)',
        [l.ingredient_id, 'PO_RECEIVE', poId, qtyBase, newQty]
      );

      // 3. TẠO LÔ HÀNG (FEFO)
      await conn.execute(
        'INSERT INTO central_inventory_batches (ingredient_id, po_id, quantity, expiration_date) VALUES (?, ?, ?, ?)',
        [l.ingredient_id, poId, qtyBase, l.exp_date]
      );

      // Lấy toàn bộ dòng của PO từ DB để kiểm tra xem đã nhận đủ tất cả các món chưa
    const [allLines] = await conn.execute(
      'SELECT qty_ordered, qty_received FROM purchase_order_lines WHERE purchase_order_id = ?', 
      [poId]
    );

    let allReceived = true;
    for (const line of allLines) {
      if (Number(line.qty_received || 0) < Number(line.qty_ordered)) {
        allReceived = false;
        break;
      }
    }

    const status = allReceived ? 'RECEIVED' : 'PARTIAL_RECEIVED';
    }

    const status = allReceived ? 'RECEIVED' : 'PARTIAL_RECEIVED';
    await conn.execute("UPDATE purchase_orders SET status = ? WHERE id = ?", [status, poId]);
    await conn.commit();
    res.json({ ok: true, status });
  } catch (e) {
    await conn.rollback();
    res.status(400).json({ error: e.message });
  } finally { conn.release(); }
});

router.get('/purchase-orders/:id', W, async (req, res) => {
  const [[po]] = await pool.execute(
    `SELECT po.*, s.name AS supplier_name FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ?`,
    [req.params.id]
  );
  if (!po) return res.status(404).json({ error: 'Không tìm thấy' });
  
  const [lines] = await pool.execute(
    `SELECT pol.*, i.name, i.unit, i.purchase_unit, i.conversion_rate 
     FROM purchase_order_lines pol
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


router.patch('/ingredients/:id/thresholds', W, async (req, res) => {
  const { safety_stock_min, reorder_point } = req.body;
  await pool.execute(
    'UPDATE ingredients SET safety_stock_min = COALESCE(?, safety_stock_min), reorder_point = COALESCE(?, reorder_point) WHERE id = ?',
    [safety_stock_min, reorder_point, req.params.id]
  );
  res.json({ ok: true });
});

router.get('/stock-requests', W, async (req, res) => {
  const filter = req.query.filter || 'pending';
  const statusCond = filter === 'pending' 
    ? "sr.status IN ('NEEDS_MANUAL','APPROVED_AUTO','NEW')"
    : "sr.status NOT IN ('NEEDS_MANUAL','APPROVED_AUTO','NEW')";

  const [rows] = await pool.execute(
    `SELECT sr.*, b.name AS branch_name FROM stock_requests sr
     JOIN branches b ON b.id = sr.branch_id
     WHERE ${statusCond}
     ORDER BY sr.id DESC LIMIT 100` 
  );
  res.json({ requests: rows });
});

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

// UC-25: Xuất kho (FEFO: Tự động trừ lô hết hạn trước)
router.post('/outbounds/:id/ship', W, async (req, res) => {
  const { trip_code } = req.body;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[ob]] = await conn.execute('SELECT stock_request_id, status FROM stock_outbounds WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!ob || ob.status === 'SHIPPED') throw new Error('Phiếu đã xuất.');

    const [lines] = await conn.execute('SELECT ingredient_id, quantity FROM stock_outbound_lines WHERE stock_outbound_id = ?', [req.params.id]);

    for (const l of lines) {
      const q = Number(l.quantity);
      const [[ci]] = await conn.execute('SELECT quantity FROM central_inventory WHERE ingredient_id = ? FOR UPDATE', [l.ingredient_id]);
      if (!ci || Number(ci.quantity) < q) throw new Error(`Nguyên liệu ID ${l.ingredient_id} không đủ tồn.`);
      
      const newQty = Number(ci.quantity) - q;
      await conn.execute('UPDATE central_inventory SET quantity = ? WHERE ingredient_id = ?', [newQty, l.ingredient_id]);

      // Ghi thẻ kho
      await conn.execute('INSERT INTO central_inventory_transactions (ingredient_id, transaction_type, reference_id, qty_change, qty_after) VALUES (?, ?, ?, ?, ?)', [l.ingredient_id, 'OUTBOUND', req.params.id, -q, newQty]);

      // LOGIC FEFO: Quét các lô hàng còn tồn theo thứ tự Hạn sử dụng tăng dần (gần hết hạn xuất trước)
      let qtyToDeduct = q;
      const [batches] = await conn.execute(
        'SELECT id, quantity FROM central_inventory_batches WHERE ingredient_id = ? AND quantity > 0 ORDER BY expiration_date ASC FOR UPDATE',
        [l.ingredient_id]
      );

      for (const b of batches) {
        if (qtyToDeduct <= 0) break;
        const bQty = Number(b.quantity);
        const deductAmt = Math.min(bQty, qtyToDeduct);
        
        await conn.execute('UPDATE central_inventory_batches SET quantity = quantity - ? WHERE id = ?', [deductAmt, b.id]);
        qtyToDeduct -= deductAmt;
      }
      
      // Đảm bảo dữ liệu đồng bộ
      // Đảm bảo dữ liệu đồng bộ - Chấp nhận chênh lệch nếu có điều chỉnh kiểm kê tăng
      if (qtyToDeduct > 0.001) {
        console.warn(`[CẢNH BÁO FEFO] ID ${l.ingredient_id} thiếu lô hàng để trừ (Thiếu ${qtyToDeduct}). Bỏ qua để xe tiếp tục xuất bến.`);
      }
    }

    await conn.execute(`UPDATE stock_outbounds SET status = 'SHIPPED', trip_code = ?, shipped_at = NOW() WHERE id = ?`, [trip_code || null, req.params.id]);
    await conn.execute(`UPDATE stock_requests SET status = 'SHIPPING' WHERE id = ?`, [ob.stock_request_id]);

    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    res.status(400).json({ error: e.message });
  } finally { conn.release(); }
});

router.get('/stock-requests/:id', W, async (req, res) => {
  const [[sr]] = await pool.execute('SELECT * FROM stock_requests WHERE id = ?', [req.params.id]);
  if (!sr) return res.status(404).json({ error: 'Không tìm thấy phiếu' });

  // Lấy chi tiết dòng yêu cầu, JOIN thêm bảng branch_quotas để lấy Hạn mức
  const [lines] = await pool.execute(
    `SELECT srl.*, i.name, COALESCE(bq.max_qty_per_week, 0) AS quota 
     FROM stock_request_lines srl
     JOIN ingredients i ON i.id = srl.ingredient_id
     LEFT JOIN branch_quotas bq ON bq.ingredient_id = srl.ingredient_id AND bq.branch_id = ?
     WHERE srl.stock_request_id = ?`,
    [sr.branch_id, req.params.id]
  );
  res.json({ request: sr, lines });
});

function outboundCode() {
  return 'XK-' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex');
}

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

// UC-22: KIỂM KÊ TỒN KHO TRUNG TÂM (Phiên bản Thẻ Kho)
router.post('/central-inventory/adjust', W, async (req, res) => {
  const { adjustments } = req.body;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const validAdjustments = [];
    for (const adj of adjustments) {
      const [[ci]] = await conn.execute('SELECT quantity FROM central_inventory WHERE ingredient_id = ? FOR UPDATE', [adj.ingredient_id]);
      const currentQty = ci ? Number(ci.quantity) : 0;
      const delta = Number(adj.qty_counted) - currentQty;
      if (delta !== 0) validAdjustments.push({ ...adj, currentQty, delta });
    }

    if (validAdjustments.length === 0) {
      await conn.rollback();
      return res.json({ ok: true, adjustedCount: 0 });
    }

    const [insAdj] = await conn.execute(
      'INSERT INTO central_inventory_adjustments (created_by, status) VALUES (?, ?)',
      [req.user.id, 'COMPLETED']
    );
    const adjId = insAdj.insertId;

    for (const item of validAdjustments) {
      const newQty = Number(item.qty_counted);

      if (item.currentQty === 0) {
        await conn.execute('INSERT INTO central_inventory (ingredient_id, quantity) VALUES (?, ?)', [item.ingredient_id, newQty]);
      } else {
        await conn.execute('UPDATE central_inventory SET quantity = ? WHERE ingredient_id = ?', [newQty, item.ingredient_id]);
      }

      await conn.execute(
        'INSERT INTO central_inventory_adjustment_lines (adjustment_id, ingredient_id, qty_before, qty_after, delta, reason) VALUES (?, ?, ?, ?, ?, ?)',
        [adjId, item.ingredient_id, item.currentQty, newQty, item.delta, item.reason || null]
      );

      await conn.execute(
        'INSERT INTO central_inventory_transactions (ingredient_id, transaction_type, reference_id, qty_change, qty_after) VALUES (?, ?, ?, ?, ?)',
        [item.ingredient_id, 'ADJUSTMENT', adjId, item.delta, newQty]
      );
    }

    await logAudit(req.user.id, 'CENTRAL_INV_ADJUST', 'warehouse', { adjId, lines: validAdjustments.length }, req.ip);
    await conn.commit();
    res.json({ ok: true, adjustedCount: validAdjustments.length });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// UC-26: BÁO CÁO XUẤT - NHẬP - TỒN (Phiên bản Thẻ Kho)
router.get('/reports/xnt', W, async (req, res) => {
  const { start, end } = req.query; 
  if (!start || !end) return res.status(400).json({ error: 'Thiếu tham số ngày' });

  const endDateFull = `${end} 23:59:59`;
  const startDateFull = `${start} 00:00:00`;

  try {
    const [ingredients] = await pool.execute('SELECT id, name, unit FROM ingredients ORDER BY name');
    
    const [transactions] = await pool.execute(`
      SELECT 
        ingredient_id,
        SUM(CASE WHEN created_at < ? THEN qty_change ELSE 0 END) AS start_stock,
        SUM(CASE WHEN created_at BETWEEN ? AND ? AND qty_change > 0 THEN qty_change ELSE 0 END) AS total_in,
        SUM(CASE WHEN created_at BETWEEN ? AND ? AND qty_change < 0 THEN ABS(qty_change) ELSE 0 END) AS total_out
      FROM central_inventory_transactions
      WHERE created_at <= ?
      GROUP BY ingredient_id
    `, [startDateFull, startDateFull, endDateFull, startDateFull, endDateFull, endDateFull]);

    const report = ingredients.map(ing => {
      const trans = transactions.find(t => t.ingredient_id === ing.id) || {};
      const startStock = Number(trans.start_stock || 0);
      const totalIn = Number(trans.total_in || 0);
      const totalOut = Number(trans.total_out || 0);
      const endStock = startStock + totalIn - totalOut; 

      return {
        id: ing.id,
        name: ing.name,
        unit: ing.unit,
        start_stock: startStock,
        total_in: totalIn,
        total_out: totalOut,
        end_stock: endStock
      };
    });

    res.json({ report });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/outbounds/:id/cancel', W, async (req, res) => {
  const { reason } = req.body;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[ob]] = await conn.execute(
      'SELECT stock_request_id, status FROM stock_outbounds WHERE id = ? FOR UPDATE', 
      [req.params.id]
    );
    
    if (!ob) throw new Error('Không tìm thấy phiếu xuất');
    if (ob.status !== 'PENDING_PICK') throw new Error('Chỉ có thể hủy phiếu đang chờ xuất');

    // Cập nhật phiếu xuất thành CANCELLED
    await conn.execute(`UPDATE stock_outbounds SET status = 'CANCELLED' WHERE id = ?`, [req.params.id]);

    // Trả phiếu xin hàng gốc về trạng thái bị từ chối
    await conn.execute(
      `UPDATE stock_requests SET status = 'REJECTED', reject_reason = ? WHERE id = ?`, 
      [reason || 'Hủy phiếu xuất do kho tổng không đủ hàng thực tế', ob.stock_request_id]
    );

    // Xóa các dòng xuất chờ để giải phóng dữ liệu
    await conn.execute(`DELETE FROM stock_outbound_lines WHERE stock_outbound_id = ?`, [req.params.id]);

    await conn.commit();
    res.json({ ok: true, message: 'Đã hủy phiếu xuất thành công' });
  } catch (e) {
    await conn.rollback();
    res.status(400).json({ error: e.message });
  } finally {
    conn.release();
  }
});

module.exports = router;