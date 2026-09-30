/**
 * Shared session auth middleware helper.
 * Returns the authenticated username or null.
 */
function getSession(req) {
  const sessions = global._sessions || {};
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/sessionId=([^;]+)/);
  const sid = match?.[1];
  return sid ? sessions[sid] || null : null;
}

module.exports = { getSession };
