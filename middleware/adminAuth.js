const jwt = require("jsonwebtoken");

// ── JWT middleware (used by all admin API routes) ─────────────────────────────
const adminAuth = (req, res, next) => {
  // Accept either Bearer token (JWT from login) or legacy x-admin-secret header
  const authHeader = req.headers["authorization"];
  const legacyKey  = req.headers["x-admin-secret"];

  // Legacy header support (keeps existing dashboard working during migration)
  if (legacyKey && legacyKey === process.env.ADMIN_SECRET) {
    return next();
  }

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "No token provided" });
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
};

module.exports = adminAuth;
