// ─────────────────────────────────────────────────────────────────────────────
// routes/settings.js  v8
// GET  /api/settings       — returns this shop's settings
// PATCH /api/settings      — updates settings (partial update supported)
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const express = require("express");
const { body } = require("express-validator");
const router  = express.Router();

const ShopSettings = require("../models/ShopSettings");
const adminAuth    = require("../middleware/adminAuth");
const { handleValidation } = require("../middleware/validate");

// Helper — get or create settings for this shop
async function getOrCreate(shopId) {
  let settings = await ShopSettings.findOne({ shopId });
  if (!settings) {
    settings = await ShopSettings.create({ shopId });
  }
  return settings;
}

// ── GET /api/settings ────────────────────────────────────────────────────────
router.get("/settings", adminAuth, async (req, res) => {
  try {
    const settings = await getOrCreate(req.shopId);
    res.json({ success: true, settings });
  } catch (err) {
    console.error("GET /api/settings:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── PATCH /api/settings ──────────────────────────────────────────────────────
// Accepts a partial update. Only provided fields are changed.
router.patch("/settings", adminAuth, async (req, res) => {
  try {
    const allowed = [
      "shopName","phone","address","timezone",
      "hours","blackoutDates",
      "services",
      "bayCount","alignmentLaneEnabled","alignmentCapacity",
      "smsTemplates","googleReviewLink",
      "reminderEnabled","reminderMinutes",
      "logoUrl","primaryColor",
    ];

    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates[key] = req.body[key];
      }
    }

    const settings = await ShopSettings.findOneAndUpdate(
      { shopId: req.shopId },
      { $set: updates },
      { new: true, upsert: true, runValidators: true }
    );

    res.json({ success: true, settings });
  } catch (err) {
    console.error("PATCH /api/settings:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
module.exports.getOrCreate = getOrCreate;
