// ─────────────────────────────────────────────────────────────────────────────
// routes/auth.js  v8
// Login from Shop collection (multi-tenant).
// Falls back to env vars for the original single-shop if no Shop docs exist.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const express = require("express");
const jwt     = require("jsonwebtoken");
const router  = express.Router();

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: "Email and password required" });
  }

  try {
    // Try database-backed shop login first
    const Shop = require("../models/Shop");
    const shop = await Shop.findOne({ email: email.toLowerCase(), active: true });

    if (shop) {
      const valid = await shop.checkPassword(password);
      if (!valid) {
        return res.status(401).json({ success: false, message: "Invalid credentials" });
      }
      const token = jwt.sign(
        { shopId: shop.shopId, email: shop.email, role: "admin" },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || "8h" }
      );
      return res.json({ success: true, token, shopId: shop.shopId, shopName: shop.name, expiresIn: process.env.JWT_EXPIRES_IN || "8h" });
    }

    // Fallback: env-var single-shop login (keeps Roadstar working during transition)
    if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
      const shopId = process.env.DEFAULT_SHOP_ID || "roadstar";
      const token  = jwt.sign(
        { shopId, email, role: "admin" },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || "8h" }
      );
      return res.json({ success: true, token, shopId, expiresIn: process.env.JWT_EXPIRES_IN || "8h" });
    }

    res.status(401).json({ success: false, message: "Invalid credentials" });
  } catch (err) {
    console.error("[Auth] Login error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// POST /api/auth/verify
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
