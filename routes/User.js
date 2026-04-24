// ─────────────────────────────────────────────────────────────────────────────
// models/User.js
//
// Replaces the simple Shop-based auth with a proper user/role system.
// One document per user. Multiple users can belong to the same shop.
//
// Roles:
//   superadmin  — sees all shops, manages everything, can switch context
//   owner       — full access to their own shop
//   frontdesk   — bookings, customers, SMS — no settings or analytics
//   mechanic    — mechanic view and live bay only
//
// Backward compatibility:
//   The old Shop collection + env var login still works.
//   Login tries Users first, then Shop collection, then env vars.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const mongoose = require("mongoose");
const bcrypt   = require("bcryptjs");

const ROLES = ["superadmin", "owner", "frontdesk", "mechanic"];

// ── Permissions matrix ────────────────────────────────────────────────────────
// Each role gets a set of named capabilities. Routes check req.user.can(cap).
const ROLE_PERMISSIONS = {
  superadmin: [
    "view:all_shops", "manage:shops", "switch:shop",
    "view:bookings", "manage:bookings",
    "view:customers", "manage:customers", "export:customers",
    "view:analytics", "view:revenue",
    "view:settings", "manage:settings",
    "view:users", "manage:users",
    "view:audit_log",
    "view:live_bay", "manage:live_bay",
    "view:mechanic", "manage:mechanic",
    "manage:prices",
  ],
  owner: [
    "view:bookings", "manage:bookings",
    "view:customers", "manage:customers", "export:customers",
    "view:analytics", "view:revenue",
    "view:settings", "manage:settings",
    "view:users", "manage:users",
    "view:audit_log",
    "view:live_bay", "manage:live_bay",
    "view:mechanic", "manage:mechanic",
    "manage:prices",
  ],
  frontdesk: [
    "view:bookings", "manage:bookings",
    "view:customers", "manage:customers",
    "view:live_bay",
    "manage:prices",
  ],
  mechanic: [
    "view:live_bay", "manage:live_bay",
    "view:mechanic", "manage:mechanic",
  ],
};

const userSchema = new mongoose.Schema(
  {
    // ── Tenancy ───────────────────────────────────────────────────────────────
    // superadmin users have shopId = null (they access all shops)
    shopId: { type: String, default: null, trim: true },

    // ── Identity ──────────────────────────────────────────────────────────────
    name:     { type: String, required: true, trim: true, maxlength: 100 },
    email:    { type: String, required: true, trim: true, lowercase: true },
    password: { type: String, required: true },

    // ── Access ────────────────────────────────────────────────────────────────
    role:   { type: String, enum: ROLES, required: true },
    active: { type: Boolean, default: true },

    // ── Session config ────────────────────────────────────────────────────────
    // mechanic sessions expire after 24h; admin/owner/frontdesk after 8h
    sessionExpiryHours: { type: Number, default: null }, // null = use role default

    // ── Tracking ──────────────────────────────────────────────────────────────
    lastLoginAt:  { type: Date, default: null },
    lastLoginIp:  { type: String, default: null },
    loginCount:   { type: Number, default: 0 },

    // ── Future 2FA placeholder ────────────────────────────────────────────────
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorSecret:  { type: String, default: null }, // encrypted TOTP secret

    // ── Soft delete ───────────────────────────────────────────────────────────
    deleted:   { type: Boolean, default: false },
    deletedAt: { type: Date,    default: null },
  },
  { timestamps: true }
);

// ── Unique email per shop (superadmin emails unique globally) ─────────────────
userSchema.index({ email: 1, shopId: 1 }, { unique: true });
userSchema.index({ shopId: 1, role: 1 });

// ── Password hashing ──────────────────────────────────────────────────────────
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.checkPassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

// ── Permission check ──────────────────────────────────────────────────────────
userSchema.methods.can = function (capability) {
  const perms = ROLE_PERMISSIONS[this.role] || [];
  return perms.includes(capability);
};

// ── JWT expiry by role ────────────────────────────────────────────────────────
userSchema.methods.sessionExpiry = function () {
  if (this.sessionExpiryHours) return `${this.sessionExpiryHours}h`;
  return this.role === "mechanic" ? "24h" : "8h";
};

module.exports = mongoose.model("User", userSchema);
module.exports.ROLES            = ROLES;
module.exports.ROLE_PERMISSIONS = ROLE_PERMISSIONS;
