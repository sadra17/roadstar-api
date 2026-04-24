// ─────────────────────────────────────────────────────────────────────────────
// lib/db.js
//
// Thin query helpers over the Supabase client.
// All routes import from here — never import supabase client directly in routes.
//
// Field naming convention:
//   Database uses snake_case (PostgreSQL convention)
//   JavaScript / API responses use camelCase
//   toCamel() converts DB rows to camelCase for API responses
//   toSnake() converts camelCase input to snake_case for DB writes
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const sb = require("../config/supabase");

// ── Case conversion helpers ───────────────────────────────────────────────────
function snakeToCamel(s) {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}
function camelToSnake(s) {
  return s.replace(/[A-Z]/g, c => "_" + c.toLowerCase());
}
function toCamel(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(toCamel);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[snakeToCamel(k)] = toCamel(v);
  }
  return out;
}
function toSnake(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(toSnake);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[camelToSnake(k)] = v; // do NOT recurse — values stay as-is
  }
  return out;
}

// ── Error helper ──────────────────────────────────────────────────────────────
function check(error, label) {
  if (error) {
    console.error(`[DB] ${label}:`, error.message);
    throw new Error(error.message);
  }
}

// ── BOOKINGS ──────────────────────────────────────────────────────────────────
const Bookings = {
  // Find bookings — filter is an object of snake_case field conditions
  async find(filter = {}, options = {}) {
    let q = sb.from("bookings").select(options.select || "*");
    for (const [k, v] of Object.entries(filter)) {
      if (v === null)      q = q.is(k, null);
      else if (v?.$ne !== undefined) q = q.neq(k, v.$ne);
      else if (v?.$in !== undefined) q = q.in(k, v.$in);
      else if (v?.$gte !== undefined && v?.$lte !== undefined) q = q.gte(k, v.$gte).lte(k, v.$lte);
      else if (v?.$gte !== undefined) q = q.gte(k, v.$gte);
      else if (v?.$lte !== undefined) q = q.lte(k, v.$lte);
      else q = q.eq(k, v);
    }
    if (options.orderBy) {
      const { col, asc = true } = options.orderBy;
      q = q.order(col, { ascending: asc });
    }
    if (options.limit) q = q.limit(options.limit);
    const { data, error } = await q;
    check(error, "Bookings.find");
    return (data || []).map(toCamel);
  },

  async findOne(filter = {}) {
    const rows = await Bookings.find(filter, { limit: 1 });
    return rows[0] || null;
  },

  async findById(id) {
    const { data, error } = await sb.from("bookings").select("*").eq("id", id).maybeSingle();
    check(error, "Bookings.findById");
    return data ? toCamel(data) : null;
  },

  async create(data) {
    const { data: row, error } = await sb.from("bookings").insert(toSnake(data)).select().single();
    check(error, "Bookings.create");
    return toCamel(row);
  },

  async update(id, shopId, updates) {
    const { data, error } = await sb.from("bookings")
      .update(toSnake(updates))
      .eq("id", id)
      .eq("shop_id", shopId)
      .eq("deleted", false)
      .select()
      .single();
    check(error, "Bookings.update");
    return data ? toCamel(data) : null;
  },

  // Soft delete
  async softDelete(id, shopId) {
    return Bookings.update(id, shopId, { deleted: true, deletedAt: new Date().toISOString() });
  },

  async restore(id, shopId) {
    const { data, error } = await sb.from("bookings")
      .update({ deleted: false, deleted_at: null })
      .eq("id", id)
      .eq("shop_id", shopId)
      .eq("deleted", true)
      .select()
      .single();
    check(error, "Bookings.restore");
    return data ? toCamel(data) : null;
  },

  // Capacity queries — returns minimal fields for performance
  async findConfirmedForCapacity(shopId, date, resourcePool) {
    const { data, error } = await sb.from("bookings")
      .select("time, service, service_duration, equipment_recovery_time, resource_pool, customer_quantity")
      .eq("shop_id", shopId)
      .eq("date", date)
      .eq("status", "confirmed")
      .eq("resource_pool", resourcePool)
      .eq("deleted", false);
    check(error, "Bookings.findConfirmedForCapacity");
    return (data || []).map(toCamel);
  },

  async countDocuments(filter = {}) {
    let q = sb.from("bookings").select("id", { count: "exact", head: true });
    for (const [k, v] of Object.entries(filter)) {
      if (v === null) q = q.is(k, null);
      else if (v?.$ne !== undefined) q = q.neq(k, v.$ne);
      else if (v?.$in !== undefined) q = q.in(k, v.$in);
      else q = q.eq(k, v);
    }
    const { count, error } = await q;
    check(error, "Bookings.countDocuments");
    return count || 0;
  },

  // Permanently delete (for purge cron only)
  async permanentDelete(filter = {}) {
    let q = sb.from("bookings").delete();
    for (const [k, v] of Object.entries(filter)) {
      if (v?.$lt !== undefined) q = q.lt(k, v.$lt);
      else q = q.eq(k, v);
    }
    const { error } = await q;
    check(error, "Bookings.permanentDelete");
  },

  // Append to sms_sent_at (legacy compat field)
  async markSmsSent(id) {
    const { error } = await sb.from("bookings")
      .update({ sms_sent_at: new Date().toISOString() })
      .eq("id", id);
    check(error, "Bookings.markSmsSent");
  },
};

// ── SMS LOG ───────────────────────────────────────────────────────────────────
const SmsLog = {
  async create(entry) {
    const { error } = await sb.from("sms_log").insert(toSnake(entry));
    check(error, "SmsLog.create");
  },

  async findByBooking(bookingId) {
    const { data, error } = await sb.from("sms_log")
      .select("*")
      .eq("booking_id", bookingId)
      .order("sent_at", { ascending: false });
    check(error, "SmsLog.findByBooking");
    return (data || []).map(toCamel);
  },

  // Duplicate prevention: check for recent same-type SMS
  async checkDuplicate(bookingId, messageType, withinMinutes = 5) {
    const cutoff = new Date(Date.now() - withinMinutes * 60 * 1000).toISOString();
    const { data, error } = await sb.from("sms_log")
      .select("id, sent_at, twilio_sid")
      .eq("booking_id", bookingId)
      .eq("message_type", messageType)
      .eq("status", "sent")
      .gte("sent_at", cutoff)
      .limit(1);
    check(error, "SmsLog.checkDuplicate");
    return data?.[0] || null;
  },
};

// ── SHOP SETTINGS ─────────────────────────────────────────────────────────────
const ShopSettings = {
  async getOrCreate(shopId) {
    const { data, error } = await sb.from("shop_settings")
      .select("*")
      .eq("shop_id", shopId)
      .maybeSingle();
    check(error, "ShopSettings.getOrCreate select");

    if (data) return toCamel(data);

    // Create default settings for this shop
    const { data: created, error: err2 } = await sb.from("shop_settings")
      .insert({ shop_id: shopId })
      .select()
      .single();
    check(err2, "ShopSettings.getOrCreate insert");
    console.log(`[Settings] Created default settings for shop: ${shopId}`);
    return toCamel(created);
  },

  async update(shopId, updates) {
    const { data, error } = await sb.from("shop_settings")
      .update(toSnake(updates))
      .eq("shop_id", shopId)
      .select()
      .single();
    check(error, "ShopSettings.update");
    return data ? toCamel(data) : null;
  },

  async findAll() {
    const { data, error } = await sb.from("shop_settings").select("*");
    check(error, "ShopSettings.findAll");
    return (data || []).map(toCamel);
  },
};

// ── USERS ─────────────────────────────────────────────────────────────────────
const Users = {
  async findOne(filter = {}) {
    let q = sb.from("users").select("*");
    for (const [k, v] of Object.entries(filter)) {
      if (v?.$ne !== undefined) q = q.neq(k, v.$ne);
      else q = q.eq(k, v);
    }
    q = q.maybeSingle();
    const { data, error } = await q;
    check(error, "Users.findOne");
    return data ? toCamel(data) : null;
  },

  async findById(id) {
    const { data, error } = await sb.from("users").select("*").eq("id", id).maybeSingle();
    check(error, "Users.findById");
    return data ? toCamel(data) : null;
  },

  async find(filter = {}) {
    let q = sb.from("users").select("id, shop_id, name, email, role, active, last_login_at, login_count, created_at");
    for (const [k, v] of Object.entries(filter)) {
      if (v?.$ne !== undefined) q = q.neq(k, v.$ne);
      else q = q.eq(k, v);
    }
    q = q.order("role").order("name");
    const { data, error } = await q;
    check(error, "Users.find");
    return (data || []).map(toCamel);
  },

  async create(data) {
    const { data: row, error } = await sb.from("users")
      .insert(toSnake(data))
      .select("id, shop_id, name, email, role, active, created_at")
      .single();
    check(error, "Users.create");
    return toCamel(row);
  },

  async update(id, updates) {
    const { data, error } = await sb.from("users")
      .update(toSnake(updates))
      .eq("id", id)
      .select("id, shop_id, name, email, role, active, last_login_at")
      .single();
    check(error, "Users.update");
    return data ? toCamel(data) : null;
  },
};

// ── SHOPS ─────────────────────────────────────────────────────────────────────
const Shops = {
  async findByEmail(email) {
    const { data, error } = await sb.from("shops").select("*").eq("email", email.toLowerCase()).maybeSingle();
    check(error, "Shops.findByEmail");
    return data ? toCamel(data) : null;
  },

  async findByShopId(shopId) {
    const { data, error } = await sb.from("shops").select("*").eq("shop_id", shopId).maybeSingle();
    check(error, "Shops.findByShopId");
    return data ? toCamel(data) : null;
  },

  async findAll() {
    const { data, error } = await sb.from("shops").select("id, shop_id, name, email, active, plan, created_at").order("created_at", { ascending: false });
    check(error, "Shops.findAll");
    return (data || []).map(toCamel);
  },

  async create(data) {
    const { data: row, error } = await sb.from("shops").insert(toSnake(data)).select().single();
    check(error, "Shops.create");
    return toCamel(row);
  },

  async update(shopId, updates) {
    const { data, error } = await sb.from("shops").update(toSnake(updates)).eq("shop_id", shopId).select().single();
    check(error, "Shops.update");
    return data ? toCamel(data) : null;
  },
};

// ── AUDIT LOGS ────────────────────────────────────────────────────────────────
const AuditLogs = {
  async create(entry) {
    const { error } = await sb.from("audit_logs").insert({
      shop_id:      entry.shopId,
      user_id:      entry.userId || null,
      user_email:   entry.userEmail || null,
      user_name:    entry.userName || null,
      user_role:    entry.userRole || null,
      action:       entry.action,
      entity:       entry.entity,
      entity_id:    entry.entityId   ? String(entry.entityId) : null,
      entity_label: entry.entityLabel || null,
      field:        entry.field      || null,
      before_value: entry.before !== undefined ? entry.before : null,
      after_value:  entry.after  !== undefined ? entry.after  : null,
      meta:         entry.meta       || null,
      ip:           entry.ip         || null,
      user_agent:   entry.userAgent  || null,
    });
    if (error) console.error("[AuditLog] Write failed:", error.message);
  },

  async find(filter = {}, page = 1, limit = 50) {
    const skip = (page - 1) * limit;
    let q = sb.from("audit_logs").select("*", { count: "exact" });
    for (const [k, v] of Object.entries(filter)) {
      if (v?.$gte && v?.$lte) q = q.gte(k, v.$gte).lte(k, v.$lte);
      else q = q.eq(k, v);
    }
    q = q.order("created_at", { ascending: false }).range(skip, skip + limit - 1);
    const { data, count, error } = await q;
    check(error, "AuditLogs.find");
    return { logs: (data || []).map(toCamel), total: count || 0 };
  },
};

module.exports = { Bookings, SmsLog, ShopSettings, Users, Shops, AuditLogs, toCamel, toSnake };
