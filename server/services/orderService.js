const pool = require('../db');
const { HttpError } = require('../domain/HttpError');
const { canTransition, STATUS_TIMESTAMPS } = require('../domain/orderStatus');

/**
 * Ghi lịch sử trạng thái đơn (audit luồng UC-06).
 */
async function appendStatusHistory(conn, orderId, status, note) {
  await conn.execute('INSERT INTO order_status_history (order_id, status, note) VALUES (?,?,?)', [
    orderId,
    status,
    note || null,
  ]);
}

/**
 * Khóa đơn, kiểm tra chuyển trạng thái, cập nhật DB + history.
 * @param {import('mysql2/promise').PoolConnection} conn — phải đang trong transaction
 * @param {object} orderRow — hàng orders hiện tại (đã FOR UPDATE)
 * @param {string} nextStatus — OrderStatus
 * @param {string} [note]
 */
async function transitionOrderLocked(conn, orderRow, nextStatus, note) {
  if (!canTransition(orderRow.status, nextStatus)) {
    throw new HttpError(400, `Không thể chuyển trạng thái: ${orderRow.status} → ${nextStatus}`, {
      from: orderRow.status,
      to: nextStatus,
    });
  }
  const ts = STATUS_TIMESTAMPS[nextStatus];
  const extra = ts ? `, ${ts}` : '';
  await conn.execute(`UPDATE orders SET status = ?${extra} WHERE id = ?`, [nextStatus, orderRow.id]);
  await appendStatusHistory(conn, orderRow.id, nextStatus, note);
}

/**
 * Lấy đơn kèm khóa hàng (tránh race khi hai thao tác cùng đổi trạng thái).
 */
async function lockOrderById(conn, orderId) {
  const [[row]] = await conn.execute('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
  return row || null;
}

/**
 * Chuyển trạng thái đơn (một transaction): khóa → kiểm tra phạm vi chi nhánh → cập nhật.
 * @param {object} options
 * @param {string} [options.note]
 * @param {number|null} [options.branchId] — chi nhánh người gọi; null nếu ADMIN xem toàn chuỗi
 * @param {string} [options.role] — JWT role (ADMIN được phép không gán branchId)
 */
async function transitionOrder(orderId, nextStatus, options = {}) {
  const { note, branchId, role } = options;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const o = await lockOrderById(conn, orderId);
    if (!o) {
      throw new HttpError(404, 'Không tìm thấy đơn');
    }
    const isAdmin = role === 'ADMIN';
    if (!isAdmin) {
      if (branchId == null || Number(o.branch_id) !== Number(branchId)) {
        throw new HttpError(403, 'Đơn không thuộc chi nhánh bạn quản lý');
      }
    } else if (branchId != null && Number(o.branch_id) !== Number(branchId)) {
      throw new HttpError(403, 'Đơn không thuộc chi nhánh đã chọn');
    }
    await transitionOrderLocked(conn, o, nextStatus, note);
    await conn.commit();
    return o;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Cập nhật trạng thái thanh toán kèm đơn (dùng sau webhook UC-45).
 */
async function setPaymentStatus(conn, orderId, paymentStatus) {
  await conn.execute('UPDATE orders SET payment_status = ? WHERE id = ?', [paymentStatus, orderId]);
}

module.exports = {
  appendStatusHistory,
  transitionOrderLocked,
  lockOrderById,
  transitionOrder,
  setPaymentStatus,
};
