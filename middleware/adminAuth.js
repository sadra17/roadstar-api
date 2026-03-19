// Simple token-based admin guard.
// In production replace with a proper JWT / session system.
const adminAuth = (req, res, next) => {
  const token = req.headers["x-admin-secret"];
  if (!token || token !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
};

module.exports = adminAuth;
