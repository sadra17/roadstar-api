// routes/auth.js  v9-supabase
"use strict";

const express = require("express");
const jwt     = require("jsonwebtoken");
const bcrypt  = require("bcryptjs");
const router  = express.Router();

const { Users, Shops } = require("../lib/db");
const adminAuth          = require("../middleware/adminAuth");
const { createAuditLog } = require("../middleware/audit");
const { ROLE_PERMISSIONS, roleSessionExpiry } = require("../middleware/adminAuth");

function buildToken(payload, expiresIn) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: expiresIn || "8h" });
}

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const ip = req.ip || req.headers["x-forwarded-for"];

  if (!email || !password) {
    return res.status(400).json({ success: false, message: "Email and password required" });
  }

  try {
    // Priority 1: Users table
    const user = await Users.findOne({ email: email.toLowerCase(), active: true, deleted: false });

    if (user) {
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        await createAuditLog(
          { shopId: user.shopId || "unknown", user: null, ip },
          { action: "login_failed", entity: "login", entityLabel: email, meta: { reason: "wrong_password" } }
        );
        return res.status(401).json({ success: false, message: "Invalid credentials" });
      }

      // Update last login
      await Users.update(user.id, {
        lastLoginAt: new Date().toISOString(),
        lastLoginIp: ip,
        loginCount:  (user.loginCount || 0) + 1,
      });

      const expiresIn = roleSessionExpiry(user.role, user.sessionExpiryHours);
      const token = buildToken({
        userId: user.id,
        shopId: user.shopId,
        email:  user.email,
        name:   user.name,
        role:   user.role,
      }, expiresIn);

      await createAuditLog(
        { shopId: user.shopId || "superadmin", user: { userId: user.id, email: user.email, name: user.name, role: user.role }, ip },
        { action: "login_success", entity: "login", entityLabel: `${user.name} (${user.role})` }
      );

      return res.json({
        success: true, token, expiresIn,
        user: { userId: user.id, shopId: user.shopId, email: user.email, name: user.name, role: user.role },
      });
    }

    // Priority 2: Shops table (legacy shop-level login = owner role)
    const shop = await Shops.findByEmail(email);
    if (shop && shop.active) {
      const valid = await bcrypt.compare(password, shop.passwordHash);
      if (!valid) return res.status(401).json({ success: false, message: "Invalid credentials" });

      const token = buildToken({ userId: shop.id, shopId: shop.shopId, email: shop.email, name: shop.name, role: "owner" }, "8h");
      return res.json({
        success: true, token, expiresIn: "8h",
        user: { userId: shop.id, shopId: shop.shopId, email: shop.email, name: shop.name, role: "owner" },
      });
    }

    // Priority 3: env vars (backward compat for Roadstar)
    if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
      const shopId = process.env.DEFAULT_SHOP_ID || "roadstar";
      const token  = buildToken({ userId: "env-admin", shopId, email, name: "Admin", role: "owner" }, "8h");
      return res.json({
        success: true, token, expiresIn: "8h",
        user: { userId: "env-admin", shopId, email, name: "Admin", role: "owner" },
      });
    }

    res.status(401).json({ success: false, message: "Invalid credentials" });
  } catch (err) {
    console.error("[Auth] Login error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── POST /api/auth/verify ─────────────────────────────────────────────────────
router.post("/verify", (req, res) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ success: false, valid: false });
  try {
    const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
    res.json({ success: true, valid: true, user: decoded });
  } catch {
    res.status(401).json({ success: false, valid: false, message: "Token expired or invalid" });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get("/me", adminAuth, async (req, res) => {
  try {
    if (req.user.userId && !["env-admin","system"].includes(req.user.userId)) {
      const user = await Users.findById(req.user.userId);
      if (user) {
        return res.json({
          success: true,
          user: {
            userId:      user.id,
            shopId:      user.shopId,
            email:       user.email,
            name:        user.name,
            role:        user.role,
            permissions: ROLE_PERMISSIONS[user.role] || [],
            lastLoginAt: user.lastLoginAt,
          },
        });
      }
    }
    res.json({ success: true, user: { ...req.user, permissions: ROLE_PERMISSIONS[req.user.role] || [] } });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post("/logout", adminAuth, async (req, res) => {
  await createAuditLog(req, { action: "logout", entity: "login", entityLabel: req.user.email });
  res.json({ success: true, message: "Logged out" });
});

module.exports = router;
