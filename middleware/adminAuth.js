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

// ── Account status check ──────────────────────────────────────────────────────
// A token stays valid for hours, so look the account up (cached briefly) and refuse
// tokens of users who were deactivated or deleted since they signed in. Tokens that
// don't belong to a users row (shop-owner login → shops table, env-admin, legacy)
// keep working as before as long as that shop is still active.
const ACCOUNT_CACHE_MS = 30 * 1000;
const _accountCache = new Map(); // userId → { at, account }

function forgetAccount(userId) { if (userId) _accountCache.delete(String(userId)); }

async function loadAccount(userId) {
  const hit = _accountCache.get(userId);
  if (hit && Date.now() - hit.at < ACCOUNT_CACHE_MS) return hit.account;
  const sb = require("../config/supabase");
  let account;
  const { data: user, error } = await sb.from("users").select("id, role, shop_id, active, deleted").eq("id", userId).maybeSingle();
  if (error) throw error;
  if (user) {
    account = { kind: "user", ok: user.active !== false && user.deleted !== true, role: user.role, shopId: user.shop_id };
  } else {
    const { data: shop, error: err2 } = await sb.from("shops").select("id, active").eq("id", userId).maybeSingle();
    if (err2) throw err2;
    account = shop ? { kind: "shop", ok: shop.active !== false } : { kind: "none", ok: false };
  }
  if (_accountCache.size > 5000) _accountCache.clear();
  _accountCache.set(userId, { at: Date.now(), account });
  return account;
}

// ── Signed-out tokens ─────────────────────────────────────────────────────────
// Sign-out revokes the token until it would have expired anyway. Kept in memory
// (single Render instance); a restart forgets the list, which only re-allows
// tokens that were already near their 8h/24h expiry window.
const _revoked = new Map(); // sha256(token) → expiry ms
const tokenKey = t => require("crypto").createHash("sha256").update(t).digest("hex");
function revokeToken(token, expSeconds) {
  const now = Date.now();
  for (const [k, exp] of _revoked) if (exp < now) _revoked.delete(k);
  _revoked.set(tokenKey(token), expSeconds ? expSeconds * 1000 : now + 24 * 3600 * 1000);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  let decoded;
  try {
    decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
    if (_revoked.size && _revoked.has(tokenKey(authHeader.slice(7)))) {
      return res.status(401).json({ success:false, message:"You have signed out. Please log in again.", code:"TOKEN_REVOKED" });
    }
  } catch (err) {
    if (err.name === "TokenExpiredError") return res.status(401).json({ success:false, message:"Session expired. Please log in again.", code:"TOKEN_EXPIRED" });
    return res.status(401).json({ success:false, message:"Invalid token" });
  }

  // Database accounts (UUID ids) must still exist and be active. env-admin / legacy
  // tokens have no row to check and are left as they were.
  if (decoded.userId && UUID_RE.test(String(decoded.userId))) {
    try {
      const account = await loadAccount(String(decoded.userId));
      if (!account.ok) {
        return res.status(401).json({ success:false, message:"Your account has been deactivated. Please contact the shop owner.", code:"ACCOUNT_INACTIVE" });
      }
      // Use the current role from the database, so a demotion takes effect immediately.
      if (account.kind === "user" && account.role) decoded = { ...decoded, role: account.role };
    } catch (err) {
      // Don't lock everyone out on a transient database error — the token itself is valid.
      console.error("[Auth] Account check failed:", err.message);
    }
  }

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
module.exports.forgetAccount      = forgetAccount;
module.exports.revokeToken        = revokeToken;
