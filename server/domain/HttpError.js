class HttpError extends Error {
  constructor(statusCode, message, detail = null) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

module.exports = { HttpError };
