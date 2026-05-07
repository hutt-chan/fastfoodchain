/**
 * Trạng thái đơn hàng — khớp luồng UC-04 → UC-07, UC-27, UC-33–35, UC-36, UC-43, webhook giao.
 */

const OrderStatus = Object.freeze({
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  PENDING_BRANCH: 'PENDING_BRANCH',
  AWAITING_KITCHEN: 'AWAITING_KITCHEN',
  COOKING: 'COOKING',
  READY_PACKAGING: 'READY_PACKAGING',
  AWAITING_SHIPPER: 'AWAITING_SHIPPER',
  DELIVERING: 'DELIVERING',
  COMPLETED: 'COMPLETED',
  FAILED_DELIVERY: 'FAILED_DELIVERY',  // UC-43: khách boom hàng / không nhận
  CANCELLED: 'CANCELLED',
});

const PaymentStatus = Object.freeze({
  PENDING: 'PENDING',
  PAID: 'PAID',
  COD_PENDING: 'COD_PENDING',
  COD_COLLECTED: 'COD_COLLECTED',
  COD_FAILED: 'COD_FAILED',          // UC-43: COD không thu được
  REFUND_PENDING: 'REFUND_PENDING',
  REFUNDED: 'REFUNDED',
});

/** Chuyển trạng thái được phép (máy trạng thái hữu hạn) */
const ORDER_TRANSITIONS = Object.freeze({
  [OrderStatus.PENDING_PAYMENT]: [OrderStatus.PENDING_BRANCH, OrderStatus.CANCELLED],
  [OrderStatus.PENDING_BRANCH]: [OrderStatus.AWAITING_KITCHEN, OrderStatus.CANCELLED],
  [OrderStatus.AWAITING_KITCHEN]: [OrderStatus.COOKING, OrderStatus.CANCELLED],
  [OrderStatus.COOKING]: [OrderStatus.READY_PACKAGING],
  [OrderStatus.READY_PACKAGING]: [OrderStatus.AWAITING_SHIPPER],
  [OrderStatus.AWAITING_SHIPPER]: [OrderStatus.DELIVERING],
  [OrderStatus.DELIVERING]: [OrderStatus.COMPLETED, OrderStatus.FAILED_DELIVERY],
  [OrderStatus.COMPLETED]: [],
  [OrderStatus.FAILED_DELIVERY]: [],
  [OrderStatus.CANCELLED]: [],
});

const STATUS_TIMESTAMPS = Object.freeze({
  [OrderStatus.COOKING]: 'kitchen_started_at = NOW()',
  [OrderStatus.READY_PACKAGING]: 'kitchen_finished_at = NOW()',
  [OrderStatus.AWAITING_SHIPPER]: 'packaged_at = NOW()',
  [OrderStatus.COMPLETED]: 'completed_at = NOW()',
});

function canTransition(fromStatus, toStatus) {
  const next = ORDER_TRANSITIONS[fromStatus];
  return Array.isArray(next) && next.includes(toStatus);
}

module.exports = {
  OrderStatus,
  PaymentStatus,
  ORDER_TRANSITIONS,
  STATUS_TIMESTAMPS,
  canTransition,
};
