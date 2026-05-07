const API_BASE = window.location.origin + '/api';
function getToken(){ return localStorage.getItem('ffc_token'); }
function setToken(t){ if(t) localStorage.setItem('ffc_token',t); else localStorage.removeItem('ffc_token'); }
function getUser(){ try { return JSON.parse(localStorage.getItem('ffc_user')||'null'); } catch { return null; } }
function setUser(u){ if(u) localStorage.setItem('ffc_user',JSON.stringify(u)); else localStorage.removeItem('ffc_user'); }
async function api(path, options={}) {
  const headers = Object.assign({}, options.headers || {});
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;
  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const res = await fetch(API_BASE + path, Object.assign({}, options, { headers }));
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text || res.statusText }; }
  if (!res.ok) {
    const err = new Error((data && data.error) || res.statusText);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
const STATUS_VI = {
  PENDING_PAYMENT: 'Chờ thanh toán',
  PENDING_BRANCH: 'Chờ chi nhánh xác nhận',
  AWAITING_KITCHEN: 'Chờ bếp',
  COOKING: 'Đang nấu',
  READY_PACKAGING: 'Đã nấu — chờ đóng gói',
  AWAITING_SHIPPER: 'Chờ shipper',
  DELIVERING: 'Đang giao',
  COMPLETED: 'Hoàn tất',
  CANCELLED: 'Đã hủy',
};
const ORDER_FLOW = ['PENDING_PAYMENT','PENDING_BRANCH','AWAITING_KITCHEN','COOKING','READY_PACKAGING','AWAITING_SHIPPER','DELIVERING','COMPLETED'];
function statusLabel(s){ return STATUS_VI[s] || s; }
// function vnd(n){ return Number(n||0).toLocaleString('vi-VN') + ' đ'; }
function vnd(n){ 
    return Number(n||0).toLocaleString('vi-VN', { maximumFractionDigits: 0 }) + ' đ'; 
}
function escapeHtml(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function renderStatusPipeline(status, paymentMethod) {
  if (status === 'CANCELLED') return '<div class="steps"><span class="step bad">Đã hủy</span></div>';
  const flow = paymentMethod === 'ONLINE' ? ORDER_FLOW : ORDER_FLOW.slice(1);
  const idx = flow.indexOf(status);
  return '<div class="steps">' + flow.map((s,i) => {
    const cls = i < idx ? 'done' : (i === idx ? 'cur' : '');
    return '<span class="step ' + cls + '">' + statusLabel(s) + '</span>';
  }).join('') + '</div>';
}
function showModal(html) {
  closeModal();
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.id = 'modalBack';
  back.setAttribute('role', 'dialog');
  back.setAttribute('aria-modal', 'true');
  back.innerHTML = '<div class="modal" onclick="event.stopPropagation()">' + html + '</div>';
  back.onclick = closeModal;
  document.body.appendChild(back);
  setTimeout(() => {
    const first = back.querySelector('input,select,textarea,button');
    if (first) first.focus();
  }, 50);
}
function closeModal() {
  const m = document.getElementById('modalBack');
  if (m) m.remove();
}
/** Promise-based input modal — thay thế prompt() */
function promptModal(opts) {
  return new Promise(resolve => {
    const id = 'pm_' + Date.now();
    const def = opts.defaultValue == null ? '' : escapeHtml(String(opts.defaultValue));
    const label = escapeHtml(opts.label || 'Giá trị');
    const title = escapeHtml(opts.title || 'Nhập giá trị');
    const type = opts.type || 'text';
    const multi = opts.multiline;
    const inputEl = multi
      ? '<textarea id="' + id + '" rows="3">' + def + '</textarea>'
      : '<input id="' + id + '" type="' + type + '" value="' + def + '" />';
    showModal(
      '<h3>' + title + '</h3>' +
      '<label for="' + id + '">' + label + '</label>' + inputEl +
      '<div class="row-actions" style="margin-top:1rem;justify-content:flex-end">' +
      '<button class="secondary" id="' + id + '_cancel">Hủy</button>' +
      '<button id="' + id + '_ok">Đồng ý</button></div>'
    );
    const inp = document.getElementById(id);
    const ok = () => { resolve(inp.value); closeModal(); };
    const no = () => { resolve(null); closeModal(); };
    document.getElementById(id + '_ok').onclick = ok;
    document.getElementById(id + '_cancel').onclick = no;
    if (!multi) inp.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
  });
}
function confirmModal(message, opts = {}) {
  return new Promise(resolve => {
    showModal(
      '<h3>' + escapeHtml(opts.title || 'Xác nhận') + '</h3>' +
      '<p>' + escapeHtml(message) + '</p>' +
      '<div class="row-actions" style="margin-top:1rem;justify-content:flex-end">' +
      '<button class="secondary" id="cf_no">' + escapeHtml(opts.cancelText || 'Hủy') + '</button>' +
      '<button id="cf_yes" class="' + (opts.danger ? 'danger' : '') + '">' + escapeHtml(opts.okText || 'Đồng ý') + '</button></div>'
    );
    document.getElementById('cf_yes').onclick = () => { closeModal(); resolve(true); };
    document.getElementById('cf_no').onclick = () => { closeModal(); resolve(false); };
  });
}
function alertModal(message, opts = {}) {
  return new Promise(resolve => {
    showModal(
      '<h3>' + escapeHtml(opts.title || 'Thông báo') + '</h3>' +
      '<p>' + escapeHtml(message) + '</p>' +
      '<div class="row-actions" style="margin-top:1rem;justify-content:flex-end">' +
      '<button id="al_ok">OK</button></div>'
    );
    document.getElementById('al_ok').onclick = () => { closeModal(); resolve(); };
  });
}
/** Loading overlay toàn cục */
function showLoading(label) {
  if (document.getElementById('loadingOverlay')) return;
  const div = document.createElement('div');
  div.id = 'loadingOverlay';
  div.className = 'loading-overlay';
  div.innerHTML = '<div class="loading-box"><div class="spinner"></div><div>' + escapeHtml(label || 'Đang xử lý...') + '</div></div>';
  document.body.appendChild(div);
}
function hideLoading() {
  const d = document.getElementById('loadingOverlay');
  if (d) d.remove();
}
/** Bao bọc thao tác async với loading state + xử lý lỗi tập trung */
async function withLoading(label, fn) {
  showLoading(label);
  try { return await fn(); }
  catch (e) { await alertModal(e.message, { title: 'Có lỗi xảy ra' }); throw e; }
  finally { hideLoading(); }
}
function logout() { setToken(null); setUser(null); location.href = '/'; }
function requireLogin() {
  if (!getToken()) { location.href = '/'; return null; }
  return getUser();
}
