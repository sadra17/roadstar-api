const jwt = require("jsonwebtoken");

// Exports a single middleware FUNCTION — not an object
const adminAuth = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const legacyKey  = req.headers["x-admin-secret"];

  // Legacy header (keeps old dashboard working)
  if (legacyKey && legacyKey === process.env.ADMIN_SECRET) {
    return next();
  }

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "No token provided" });
  }

  try {
    const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
};

module.exports = adminAuth;   // <-- plain function, NOT { adminAuth }
