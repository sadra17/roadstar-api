// routes/settings.js  v9-supabase
"use strict";

const express = require("express");
const router  = express.Router();

const { ShopSettings } = require("../lib/db");
const adminAuth = require("../middleware/adminAuth");
const { requirePermission } = require("../middleware/adminAuth");
const { createAuditLog }    = require("../middleware/audit");

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
  reminders:    ["reminderEnabled","reminderMinutes"],
  branding:     ["logoUrl","primaryColor"],
  email:        ["collectEmailEnabled","emailConsentText"],
};
const ALLOWED_FIELDS = Object.values(FIELD_GROUPS).flat();
function detectGroup(keys) {
  for (const [g, fs] of Object.entries(FIELD_GROUPS)) { if (keys.some(k => fs.includes(k))) return g; }
  return "settings";
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
