// routes/settings.js  v9-supabase
"use strict";

const express = require("express");
const router  = express.Router();

const { ShopSettings } = require("../lib/db");
const adminAuth = require("../middleware/adminAuth");
const { requirePermission } = require("../middleware/adminAuth");
const { createAuditLog }    = require("../middleware/audit");
const { isRealDate }        = require("../config/business");

async function getOrCreate(shopId) {
  return ShopSettings.getOrCreate(shopId);
}

const FIELD_GROUPS = {
  businessInfo: ["shopName","phone","address","timezone"],
  hours:        ["hours"],
  blackout:     ["blackoutDates"],
  services:     ["services"],
  capacity:     ["bayCount","alignmentLaneEnabled","alignmentCapacity"],
  sms:          ["smsTemplates"],
  review:       ["googleReviewLink"],
  reminders:    ["reminderEnabled","reminderMinutes","reminderAdvanceEnabled","reminderAdvanceHours"],
  branding:     ["logoUrl","primaryColor"],
  email:        ["collectEmailEnabled","emailConsentText"],
};
const ALLOWED_FIELDS = Object.values(FIELD_GROUPS).flat();
function detectGroup(keys) {
  for (const [g, fs] of Object.entries(FIELD_GROUPS)) { if (keys.some(k => fs.includes(k))) return g; }
  return "settings";
}

// Reject values that would break the booking form or capacity maths (a 0-minute
// service never blocks a bay; closing before opening; blank blackout dates).
// Values the shop already had stored are let through unchanged, so an older saved
// setting never blocks saving something else. Mutates updates (drops blank dates).
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
function validateSettings(updates, current) {
  if (updates.hours !== undefined) {
    const h = updates.hours;
    if (!h || typeof h !== "object") return "Business hours are not in the right format.";
    for (const [k, day] of Object.entries(h)) {
      if (!day || (!day.open && !day.close)) continue; // closed
      const prev = current.hours?.[k];
      if (prev && prev.open === day.open && prev.close === day.close) continue;
      const name = DAY_NAMES[k] || `Day ${k}`;
      if (!HHMM.test(String(day.open || "")) || !HHMM.test(String(day.close || ""))) return `${name}: please enter both an opening and a closing time.`;
      if (day.open >= day.close) return `${name}: closing time must be after opening time.`;
    }
  }
  if (updates.blackoutDates !== undefined) {
    if (!Array.isArray(updates.blackoutDates)) return "Blackout dates must be a list.";
    // Blank rows (an added row with no date picked) are dropped, not saved as ""
    const dates = updates.blackoutDates.filter(d => !(d === null || (typeof d === "string" && !d.trim())));
    const prevDates = new Set(Array.isArray(current.blackoutDates) ? current.blackoutDates : []);
    for (const d of dates) {
      if (typeof d === "string" && prevDates.has(d)) continue;
      if (typeof d !== "string" || !isRealDate(d.trim())) return "Please pick a valid date for every blackout day.";
    }
    updates.blackoutDates = [...new Set(dates.map(d => typeof d === "string" ? d.trim() : d))];
  }
  if (updates.services !== undefined) {
    if (!Array.isArray(updates.services)) return "Services must be a list.";
    const prevDur = new Map((current.services || []).map(s => [String(s?.name || "").trim(), Number(s?.serviceDuration ?? s?.service_duration)]));
    for (const svc of updates.services) {
      if (!svc || typeof svc !== "object") return "Services are not in the right format.";
      const name = String(svc.name || "").trim();
      const dur = Number(svc.serviceDuration ?? svc.service_duration ?? 30);
      if (prevDur.has(name) && prevDur.get(name) === dur) continue;
      if (!Number.isFinite(dur) || dur < 5 || dur > 600) return `"${name}" needs a duration between 5 and 600 minutes.`;
    }
  }
  return null;
}

// ── GET /api/settings ─────────────────────────────────────────────────────────
router.get("/settings", adminAuth, async (req, res) => {
  try {
    const settings = await getOrCreate(req.shopId);
    res.json({ success: true, settings });
  } catch (err) {
    console.error("GET /api/settings:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── PATCH /api/settings ───────────────────────────────────────────────────────
router.patch("/settings", adminAuth, requirePermission("manage:settings"), async (req, res) => {
  try {
    const current = await getOrCreate(req.shopId);
    const updates = {};
    const changedKeys = [];
    for (const key of ALLOWED_FIELDS) {
      if (req.body[key] !== undefined) { updates[key] = req.body[key]; changedKeys.push(key); }
    }
    if (!changedKeys.length) return res.status(400).json({ success: false, message: "No valid fields to update" });

    const invalid = validateSettings(updates, current);
    if (invalid) return res.status(400).json({ success: false, message: invalid });

    const before = {};
    for (const k of changedKeys) before[k] = current[k];

    const settings = await ShopSettings.update(req.shopId, updates);

    // Auto-update onboarding
    const ob = {};
    if (changedKeys.some(k => FIELD_GROUPS.businessInfo.includes(k))) ob.businessInfoSet = true;
    if (changedKeys.includes("hours"))          ob.hoursSet         = true;
    if (changedKeys.includes("services"))       ob.servicesReviewed = true;
    if (changedKeys.includes("smsTemplates"))   ob.smsTemplatesSet  = true;
    if (changedKeys.includes("googleReviewLink")) ob.googleReviewSet = true;
    if (Object.keys(ob).length) {
      const newOnboarding = { ...(settings.onboarding || {}), ...ob };
      await ShopSettings.update(req.shopId, { onboarding: newOnboarding });
    }

    const group = detectGroup(changedKeys);
    await createAuditLog(req, {
      action: "updated", entity: "setting", entityId: req.shopId,
      entityLabel: `Settings → ${group}`,
      field: changedKeys.length === 1 ? changedKeys[0] : group,
      before: changedKeys.length === 1 ? before[changedKeys[0]] : before,
      after:  changedKeys.length === 1 ? updates[changedKeys[0]] : updates,
    });

    if (req.io) req.io.to(`shop:${req.shopId}`).emit("settings_updated", { shopId: req.shopId });
    res.json({ success: true, settings });
  } catch (err) {
    console.error("PATCH /api/settings:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── PATCH /api/settings/onboarding ───────────────────────────────────────────
router.patch("/settings/onboarding", adminAuth, requirePermission("manage:settings"), async (req, res) => {
  try {
    const current = await getOrCreate(req.shopId);
    const allowed = ["businessInfoSet","hoursSet","servicesReviewed","smsTemplatesSet","googleReviewSet","firstBookingMade","shopifyInstalled"];
    const ob = { ...(current.onboarding || {}) };
    for (const k of allowed) { if (req.body[k] !== undefined) ob[k] = req.body[k]; }
    const allDone = allowed.slice(0,-1).every(k => ob[k] === true);
    if (allDone && !ob.completedAt) ob.completedAt = new Date().toISOString();
    const settings = await ShopSettings.update(req.shopId, { onboarding: ob });
    res.json({ success: true, onboarding: settings.onboarding });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
module.exports.getOrCreate = getOrCreate;
