const { HttpError } = require('../domain/HttpError');

function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }
  if (err instanceof HttpError) {
    const body = { error: err.message };
    if (err.detail != null) body.detail = err.detail;
    return res.status(err.statusCode).json(body);
  }
  console.error(err);
  res.status(500).json({ error: err.message || 'Lỗi máy chủ' });
}

module.exports = { errorHandler };
