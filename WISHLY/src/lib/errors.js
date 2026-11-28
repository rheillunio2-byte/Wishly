class HttpError extends Error {
  constructor(status, message, field, headers) {
    super(message);
    this.status = status;
    this.field = field;
    this.headers = headers;
  }
}
module.exports = { HttpError };
