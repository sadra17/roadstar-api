// middleware/adminAuth.js  v9-supabase
"use strict";

const jwt = require("jsonwebtoken");

const ROLES = ["superadmin","owner","frontdesk","mechanic"];

const ROLE_PERMISSIONS = {
  superadmin: ["view:all_shops","manage:shops","switch:shop","view:bookings","manage:bookings","view:customers","manage:customers","export:customers","view:analytics","view:revenue","view:settings","manage:settings","view:users","manage:users","view:audit_log","view:live_bay","manage:live_bay","view:mechanic","manage:mechanic","manage:prices"],
  owner:      ["view:bookings","manage:bookings","view:customers","manage:customers","export:customers","view:analytics","view:revenue","view:settings","manage:settings","view:users","manage:users","view:audit_log","view:live_bay","manage:live_bay","view:mechanic","manage:mechanic","manage:prices"],
  frontdesk:  ["view:bookings","manage:bookings","view:customers","manage:customers","view:live_bay","manage:live_bay","manage:prices"],
  mechanic:   ["view:bookings","manage:bookings","view:live_bay","manage:live_bay","view:mechanic","manage:mechanic"],
};

function roleSessionExpiry(role, customHours) {
  if (customHours) return `${customHours}h`;
  return role === "mechanic" ? "24h" : "8h";
}

// ── S3: x-admin-secret is a legacy bypass — warn on startup if it is set ──────
if (process.env.ADMIN_SECRET) {
  if (process.env.NODE_ENV === "production") {
    console.warn(
      "[Security] ADMIN_SECRET is set in production. This header bypasses JWT auth entirely. " +
      "Remove it from Render env vars once all internal callers use JWT."
    );
  }
}

const adminAuth = async (req, res, next) => {
  const legacyKey  = req.headers["x-admin-secret"];
  const authHeader = req.headers["authorization"];

  // S3: Legacy secret bypass — only honoured when no Bearer token is present.
  // If a Bearer token exists, skip entirely and let JWT verification handle it
  // (avoids blocking old clients that send both headers simultaneously).
  if (legacyKey && process.env.ADMIN_SECRET && !authHeader?.startsWith("Bearer ")) {
    if (process.env.NODE_ENV === "production" && process.env.ALLOW_ADMIN_SECRET !== "true") {
      console.warn(`[Security] x-admin-secret used in production from ${req.ip} — blocked. Remove ADMIN_SECRET env var or set ALLOW_ADMIN_SECRET=true.`);
      return res.status(401).json({ success: false, message: "No token provided" });
    }
    if (legacyKey === process.env.ADMIN_SECRET) {
      req.user = { userId:"system", email:"system@internal", name:"System", role:"superadmin", shopId: req.headers["x-shop-id"] || process.env.DEFAULT_SHOP_ID || "roadstar", can:()=>true, _isSuperAdmin:true };
      req.shopId = req.user.shopId;
      req.userId = "system";
      return next();
    }
  }

  if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ success:false, message:"No token provided" });

  try {
    const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
    const perms   = ROLE_PERMISSIONS[decoded.role] || [];
    req.user = {
      userId: decoded.userId || "legacy",
      email:  decoded.email,
      name:   decoded.name || decoded.email,
      role:   decoded.role || "owner",
      shopId: decoded.shopId || process.env.DEFAULT_SHOP_ID || "roadstar",
      can:    (cap) => decoded.role === "superadmin" || perms.includes(cap),
      _isSuperAdmin: decoded.role === "superadmin",
    };
    req.shopId = req.user._isSuperAdmin && req.headers["x-shop-id"]
      ? req.headers["x-shop-id"]
      : req.user.shopId;
    req.userId = req.user.userId;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") return res.status(401).json({ success:false, message:"Session expired. Please log in again.", code:"TOKEN_EXPIRED" });
    return res.status(401).json({ success:false, message:"Invalid token" });
  }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ success:false, message:"Not authenticated" });
  if (!roles.includes(req.user.role)) return res.status(403).json({ success:false, message:`Requires role: ${roles.join(" or ")}`, code:"INSUFFICIENT_ROLE" });
  next();
};

const requirePermission = (cap) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ success:false, message:"Not authenticated" });
  if (!req.user.can(cap)) return res.status(403).json({ success:false, message:"You don't have permission for this action.", required:cap, code:"INSUFFICIENT_PERMISSION" });
  next();
};

module.exports = adminAuth;
module.exports.ROLES              = ROLES;
module.exports.ROLE_PERMISSIONS   = ROLE_PERMISSIONS;
module.exports.roleSessionExpiry  = roleSessionExpiry;
module.exports.requireRole        = requireRole;
module.exports.requirePermission  = requirePermission;
