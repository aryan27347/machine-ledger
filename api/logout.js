const sessions = global._sessions || (global._sessions = {});

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/sessionId=([^;]+)/);
  const sid = match?.[1];

  if (sid) {
    delete sessions[sid];
  }

  res.setHeader(
    "Set-Cookie",
    "sessionId=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax"
  );
  res.status(200).json({ success: true });
};
