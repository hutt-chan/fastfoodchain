const pool = require('../db');

/**
 * UC-40: Số phần tối đa có thể làm — CHỈ tính nguyên liệu BẮT BUỘC (is_optional = 0).
 * Topping/tùy chọn hết sẽ KHÔNG làm tắt món chính.
 */
async function maxServingsForProduct(branchId, productId) {
  const [rows] = await pool.execute(
    `SELECT b.ingredient_id, b.qty_per_unit, bi.quantity AS stock
     FROM product_bom b
     JOIN branch_inventory bi ON bi.ingredient_id = b.ingredient_id AND bi.branch_id = :bid
     WHERE b.product_id = :pid AND b.is_optional = 0`,
    { bid: branchId, pid: productId }
  );
  if (rows.length === 0) return 999999;
  let min = Infinity;
  for (const r of rows) {
    const q = Number(r.stock) / Number(r.qty_per_unit);
    if (q < min) min = Math.floor(q);
  }
  return min < 0 ? 0 : min;
}

/**
 * UC-31 + UC-40: Cập nhật khả dụng món tại chi nhánh.
 * - Nếu manual_off_until đã qua → tự động bật lại.
 * - Nếu manual_off → giữ tắt; auto_off chỉ bật khi BOM bắt buộc thiếu (UC-40).
 */
async function refreshBranchProductAvailability(branchId, productIds = null) {
  // 1) Auto-resume các món đã tới hạn (UC-31)
  await pool.execute(
    `UPDATE branch_menu
     SET manual_off = 0, manual_off_until = NULL, manual_off_reason = NULL
     WHERE branch_id = ? AND manual_off = 1 AND manual_off_until IS NOT NULL AND manual_off_until <= NOW()`,
    [branchId]
  );

  let pids = productIds;
  if (!pids) {
    const [all] = await pool.execute(
      'SELECT product_id FROM branch_menu WHERE branch_id = ?',
      [branchId]
    );
    pids = all.map((x) => x.product_id);
  }
  for (const pid of pids) {
    const [bm] = await pool.execute(
      'SELECT manual_off FROM branch_menu WHERE branch_id = ? AND product_id = ?',
      [branchId, pid]
    );
    if (!bm.length) continue;
    if (bm[0].manual_off) {
      await pool.execute(
        'UPDATE branch_menu SET is_available = 0 WHERE branch_id = ? AND product_id = ?',
        [branchId, pid]
      );
      continue;
    }
    const maxS = await maxServingsForProduct(branchId, pid);
    const available = maxS > 0 ? 1 : 0;
    const autoOff = maxS <= 0 ? 1 : 0;
    await pool.execute(
      `UPDATE branch_menu SET is_available = ?, auto_off = ?
       WHERE branch_id = ? AND product_id = ? AND manual_off = 0`,
      [available, autoOff, branchId, pid]
    );
  }
}

async function aggregateBomNeed(executor, lines) {
  const need = new Map();
  for (const line of lines) {
    const [boms] = await executor.execute(
      'SELECT ingredient_id, qty_per_unit FROM product_bom WHERE product_id = ? AND is_optional = 0',
      [line.product_id]
    );
    for (const b of boms) {
      const k = b.ingredient_id;
      need.set(k, (need.get(k) || 0) + Number(b.qty_per_unit) * line.quantity);
    }
  }
  return need;
}

/** Kiểm tra đủ BOM để làm quantity phần (chỉ nguyên liệu bắt buộc) */
async function canFulfillOrder(branchId, lines) {
  const need = await aggregateBomNeed(pool, lines);
  for (const [ingId, qty] of need) {
    const [[row]] = await pool.execute(
      'SELECT quantity FROM branch_inventory WHERE branch_id = ? AND ingredient_id = ?',
      [branchId, ingId]
    );
    const have = row ? Number(row.quantity) : 0;
    if (have < qty) {
      return { ok: false, ingredient_id: ingId, need: qty, have };
    }
  }
  return { ok: true };
}

async function consumeBomForOrder(conn, branchId, lines) {
  const need = await aggregateBomNeed(conn, lines);
  for (const [ingId, qty] of need) {
    await conn.execute(
      `UPDATE branch_inventory SET quantity = quantity - ? WHERE branch_id = ? AND ingredient_id = ?`,
      [qty, branchId, ingId]
    );
  }
  return [...need.keys()];
}

async function restockBomForOrder(conn, branchId, orderItemRows) {
  const lines = orderItemRows.map((it) => ({ product_id: it.product_id, quantity: it.quantity }));
  const need = await aggregateBomNeed(conn, lines);
  for (const [ingId, qty] of need) {
    await conn.execute(
      `UPDATE branch_inventory SET quantity = quantity + ? WHERE branch_id = ? AND ingredient_id = ?`,
      [qty, branchId, ingId]
    );
  }
  return [...need.keys()];
}

/**
 * UC-39: Cảnh báo tồn kho event-driven.
 * Gọi sau mỗi thao tác làm thay đổi tồn. Tạo `low_stock_alerts` mới nếu chưa có alert chưa-ack ở cùng level.
 * scope: 'CENTRAL' hoặc 'BRANCH'.
 */
async function checkAndEmitLowStockAlerts(scope, branchId, changedIngredientIds = null) {
  const isCentral = scope === 'CENTRAL';
  let rows;
  if (isCentral) {
    const inIds = changedIngredientIds && changedIngredientIds.length;
    const [r] = await pool.execute(
      `SELECT i.id AS ingredient_id, ci.quantity, i.safety_stock_min, i.reorder_point
       FROM central_inventory ci JOIN ingredients i ON i.id = ci.ingredient_id
       ${inIds ? 'WHERE i.id IN (' + changedIngredientIds.map(() => '?').join(',') + ')' : ''}`,
      inIds ? changedIngredientIds : []
    );
    rows = r;
  } else {
    const params = [branchId];
    let where = 'WHERE bi.branch_id = ?';
    if (changedIngredientIds && changedIngredientIds.length) {
      where += ' AND i.id IN (' + changedIngredientIds.map(() => '?').join(',') + ')';
      params.push(...changedIngredientIds);
    }
    const [r] = await pool.execute(
      `SELECT i.id AS ingredient_id, bi.quantity, i.safety_stock_min, i.reorder_point
       FROM branch_inventory bi JOIN ingredients i ON i.id = bi.ingredient_id ${where}`,
      params
    );
    rows = r;
  }
  for (const r of rows) {
    const q = Number(r.quantity);
    let level = null, threshold = 0;
    if (q < Number(r.safety_stock_min)) { level = 'SAFETY'; threshold = Number(r.safety_stock_min); }
    else if (q < Number(r.reorder_point)) { level = 'REORDER'; threshold = Number(r.reorder_point); }
    if (!level) continue;
    const [[existing]] = await pool.execute(
      `SELECT id FROM low_stock_alerts WHERE scope = ?
       AND ${isCentral ? 'branch_id IS NULL' : 'branch_id = ?'}
       AND ingredient_id = ? AND level = ? AND acknowledged = 0
       LIMIT 1`,
      isCentral ? [scope, r.ingredient_id, level] : [scope, branchId, r.ingredient_id, level]
    );
    if (existing) continue;
    await pool.execute(
      `INSERT INTO low_stock_alerts (scope, branch_id, ingredient_id, level, current_qty, threshold_qty)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [scope, isCentral ? null : branchId, r.ingredient_id, level, q, threshold]
    );
  }
}

module.exports = {
  maxServingsForProduct,
  refreshBranchProductAvailability,
  canFulfillOrder,
  consumeBomForOrder,
  restockBomForOrder,
  aggregateBomNeed,
  checkAndEmitLowStockAlerts,
};
