// Handlers return plain data (200) or respond(status, body, { cookies, headers }) for anything else.
const respond = (status, body, extra = {}) => ({ __response: true, status, body, ...extra });
module.exports = { respond };
