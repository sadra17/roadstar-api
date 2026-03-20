const express = require("express");
const jwt     = require("jsonwebtoken");
const router  = express.Router();

// ── POST /api/auth/login ──────────────────────────────────────────────────────
// Validates admin credentials, returns a signed JWT
router.post("/login", (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: "Email and password required" });
  }

  // Compare against env vars (no database needed for single admin)
  if (
    email    !== process.env.ADMIN_EMAIL    ||
    password !== process.env.ADMIN_PASSWORD
  ) {
    return res.status(401).json({ success: false, message: "Invalid credentials" });
  }

  const token = jwt.sign(
    { email, role: "admin" },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "8h" }
  );

  res.json({
    success: true,
    token,
    expiresIn: process.env.JWT_EXPIRES_IN || "8h",
  });
});

// ── POST /api/auth/verify ─────────────────────────────────────────────────────
// Dashboard calls this on load to check if stored token is still valid
router.post("/verify", (req, res) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, valid: false });
  }
  try {
    const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
    res.json({ success: true, valid: true, admin: decoded });
  } catch {
    res.status(401).json({ success: false, valid: false, message: "Token expired" });
  }
});

module.exports = router;
