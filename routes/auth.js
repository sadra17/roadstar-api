// routes/auth.js  v9-supabase + email-OTP
"use strict";

const express = require("express");
const jwt     = require("jsonwebtoken");
const bcrypt  = require("bcryptjs");
const router  = express.Router();

const { Users, Shops } = require("../lib/db");
const adminAuth          = require("../middleware/adminAuth");
const { createAuditLog } = require("../middleware/audit");
const { ROLE_PERMISSIONS, roleSessionExpiry } = require("../middleware/adminAuth");
const { sendOtpEmail }   = require("../lib/email");

// ── Email OTP store ────────────────────────────────────────────────────────────
// In-memory; resets on server restart. OTPs are short-lived (10 min) so this
// is acceptable on Render single-process. Move to Redis for multi-process.
const _otpStore      = new Map(); // key = email → { code, expiresAt, attempts }
const OTP_EXPIRY_MS  = 10 * 60 * 1000; // 10 minutes
const OTP_MAX_TRIES  = 5;             // wrong attempts before invalidation
const OTP_RATE_LIMIT = new Map();     // key = email → { count, resetAt }

function _generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function _otpRateLimited(email) {
  const now = Date.now();
  const rec = OTP_RATE_LIMIT.get(email);
  if (!rec || now > rec.resetAt) {
    OTP_RATE_LIMIT.set(email, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return false;
  }
  rec.count++;
  return rec.count > 5; // max 5 send requests per 15 min
}

function storeOtp(email, code) {
  _otpStore.set(email, { code, expiresAt: Date.now() + OTP_EXPIRY_MS, attempts: 0 });
}

function checkOtp(email, code) {
  const rec = _otpStore.get(email);
  if (!rec) return { ok: false, reason: "No code was sent to this email. Click 'Send Code' first." };
  if (Date.now() > rec.expiresAt) {
    _otpStore.delete(email);
    return { ok: false, reason: "Code expired. Request a new one." };
  }
  rec.attempts++;
  if (rec.attempts > OTP_MAX_TRIES) {
    _otpStore.delete(email);
    return { ok: false, reason: "Too many wrong attempts. Request a new code." };
  }
  if (rec.code !== code.trim()) {
    const left = OTP_MAX_TRIES - rec.attempts;
    return { ok: false, reason: `Incorrect code. ${left} attempt${left !== 1 ? "s" : ""} remaining.` };
  }
  _otpStore.delete(email); // single-use — delete after success
  return { ok: true };
}

// ── S4: In-memory login attempt tracker ───────────────────────────────────────
// Prevents brute-force attacks. Key = email (lowercased).
// After MAX_ATTEMPTS failures within WINDOW_MS, the account is locked for LOCKOUT_MS.
// Note: this resets on server restart. For multi-process deploys, move to Redis.
const _attempts = new Map();
const MAX_ATTEMPTS = 10;
const WINDOW_MS    = 15 * 60 * 1000; // 15 minutes rolling window
const LOCKOUT_MS   = 15 * 60 * 1000; // 15 minutes lockout

function getAttempts(email) {
  const now = Date.now();
  const rec = _attempts.get(email);
  if (!rec || now > rec.resetAt) {
    _attempts.set(email, { count: 0, resetAt: now + WINDOW_MS, lockedUntil: 0 });
    return _attempts.get(email);
  }
  return rec;
}

function isLockedOut(email) {
  const rec = getAttempts(email);
  return rec.lockedUntil > Date.now();
}

function recordFailure(email) {
  const rec = getAttempts(email);
  rec.count++;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOCKOUT_MS;
    console.warn(`[Auth] Account locked after ${rec.count} failures: ${email}`);
  }
}

function clearAttempts(email) {
  _attempts.delete(email);
}

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

  const emailLower = email.toLowerCase();

  // S4: Check lockout before touching DB or running bcrypt
  if (isLockedOut(emailLower)) {
    return res.status(429).json({
      success: false,
      message: "Too many failed login attempts. Please try again in 15 minutes.",
      code: "ACCOUNT_LOCKED",
    });
  }

  try {
    // Priority 1: Users table
    const user = await Users.findOne({ email: emailLower, active: true, deleted: false });

    if (user) {
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        recordFailure(emailLower);
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

      clearAttempts(emailLower); // S4: reset on success
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
    const shop = await Shops.findByEmail(emailLower);
    if (shop && shop.active) {
      const valid = await bcrypt.compare(password, shop.passwordHash);
      if (!valid) {
        recordFailure(emailLower); // S4: track failure
        return res.status(401).json({ success: false, message: "Invalid credentials" });
      }
      clearAttempts(emailLower); // S4: reset on success
      // S3 note: Shops-table login creates no audit log — intentional legacy path
      const token = buildToken({ userId: shop.id, shopId: shop.shopId, email: shop.email, name: shop.name, role: "owner" }, "8h");
      return res.json({
        success: true, token, expiresIn: "8h",
        user: { userId: shop.id, shopId: shop.shopId, email: shop.email, name: shop.name, role: "owner" },
      });
    }

    // Priority 3: env vars (backward compat for Roadstar)
    if (emailLower === (process.env.ADMIN_EMAIL || "").toLowerCase() && password === process.env.ADMIN_PASSWORD) {
      clearAttempts(emailLower); // S4: reset on success
      const shopId = process.env.DEFAULT_SHOP_ID || "roadstar";
      const token  = buildToken({ userId: "env-admin", shopId, email: emailLower, name: "Admin", role: "owner" }, "8h");
      return res.json({
        success: true, token, expiresIn: "8h",
        user: { userId: "env-admin", shopId, email: emailLower, name: "Admin", role: "owner" },
      });
    }

    // No match at any priority level
    recordFailure(emailLower); // S4: track as failed attempt
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

// ── POST /api/auth/request-otp ────────────────────────────────────────────────
// Step 1 of email-OTP login. Looks up user by email, sends 6-digit code.
router.post("/request-otp", async (req, res) => {
  const { email } = req.body;
  if (!email || typeof email !== "string") {
    return res.status(400).json({ success: false, message: "Email is required." });
  }
  const emailLower = email.toLowerCase().trim();
  const ip = req.ip || req.headers["x-forwarded-for"];

  if (_otpRateLimited(emailLower)) {
    return res.status(429).json({ success: false, message: "Too many code requests. Please wait 15 minutes.", code: "OTP_RATE_LIMITED" });
  }

  try {
    // Look up user — same priority order as password login
    const user = await Users.findOne({ email: emailLower, active: true, deleted: false });
    // Don't reveal whether email exists (security: always say "if account exists…")
    const recipient = user || { email: emailLower, name: "there", shopId: "unknown" };

    if (user) {
      const code = _generateOtp();
      storeOtp(emailLower, code);
      try {
        await sendOtpEmail(emailLower, code, process.env.SHOP_NAME || "Roadstar Tire");
        console.log(`[OTP] Code sent to ${emailLower} (ip: ${ip})`);
      } catch (emailErr) {
        console.error(`[OTP] Failed to send email to ${emailLower}:`, emailErr.message);
        // Still respond OK — don't reveal email sending failure to attacker
      }
    } else {
      // Log unknown email attempts quietly
      console.warn(`[OTP] Unknown email attempted: ${emailLower} (ip: ${ip})`);
    }

    res.json({ success: true, message: "If that email is registered, a code has been sent." });
  } catch (err) {
    console.error("[OTP] request-otp error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ── POST /api/auth/verify-otp ─────────────────────────────────────────────────
// Step 2 of email-OTP login. Verifies code, returns JWT.
router.post("/verify-otp", async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) {
    return res.status(400).json({ success: false, message: "Email and code are required." });
  }
  const emailLower = email.toLowerCase().trim();
  const ip = req.ip || req.headers["x-forwarded-for"];

  const check = checkOtp(emailLower, String(code));
  if (!check.ok) {
    await createAuditLog(
      { shopId: "unknown", user: null, ip },
      { action: "otp_failed", entity: "login", entityLabel: emailLower, meta: { reason: check.reason } }
    );
    return res.status(401).json({ success: false, message: check.reason, code: "OTP_INVALID" });
  }

  try {
    const user = await Users.findOne({ email: emailLower, active: true, deleted: false });
    if (!user) {
      // Race condition: user was deactivated after OTP was issued
      return res.status(401).json({ success: false, message: "Account not found or inactive." });
    }

    await Users.update(user.id, {
      lastLoginAt: new Date().toISOString(),
      lastLoginIp: ip,
      loginCount:  (user.loginCount || 0) + 1,
    });

    const expiresIn = roleSessionExpiry(user.role, user.sessionExpiryHours);
    const token = buildToken({
      userId: user.id, shopId: user.shopId, email: user.email,
      name: user.name, role: user.role,
    }, expiresIn);

    await createAuditLog(
      { shopId: user.shopId || "superadmin", user: { userId: user.id, email: user.email, name: user.name, role: user.role }, ip },
      { action: "login_success", entity: "login", entityLabel: `${user.name} (${user.role}) via OTP` }
    );

    return res.json({
      success: true, token, expiresIn,
      user: { userId: user.id, shopId: user.shopId, email: user.email, name: user.name, role: user.role },
    });
  } catch (err) {
    console.error("[OTP] verify-otp error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

module.exports = router;
