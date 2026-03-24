// ─────────────────────────────────────────────────────────────────────────────
// middleware/adminAuth.js  v8
// Extracts shopId from JWT and attaches to req.shopId.
// Falls back to env-based super-admin (x-admin-secret) for backward compat.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const jwt = require("jsonwebtoken");

const adminAuth = async (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const legacyKey  = req.headers["x-admin-secret"];

  // Legacy super-admin key — for the original single-shop setup
  // Also used by the super-admin shop-creation endpoint
  if (legacyKey && legacyKey === process.env.ADMIN_SECRET) {
    req.shopId = req.headers["x-shop-id"] || process.env.DEFAULT_SHOP_ID || "roadstar";
    req.admin  = { role: "superadmin" };
    return next();
  }

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "No token provided" });
  }

  try {
    const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
    req.admin  = decoded;
    req.shopId = decoded.shopId || process.env.DEFAULT_SHOP_ID || "roadstar";
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
};

module.exports = adminAuth;
