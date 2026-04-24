// ─────────────────────────────────────────────────────────────────────────────
// routes/shops.js  v9
//
// Superadmin-only route for managing shops (tenants).
//
// GET    /api/admin/shops          list all shops
// POST   /api/admin/shops          create new shop + owner user + default settings
// PATCH  /api/admin/shops/:shopId  update shop (name, plan, active)
// GET    /api/admin/shops/:shopId/stats  booking counts, revenue for this shop
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const express   = require("express");
const { body }  = require("express-validator");
const router    = express.Router();

const User         = require("../models/User");
const Shop         = require("../models/Shop");
const ShopSettings = require("../models/ShopSettings");
const Booking      = require("../models/Booking");
const adminAuth    = require("../middleware/adminAuth");
const { requireRole }      = require("../middleware/adminAuth");
const { handleValidation } = require("../middleware/validate");
const { createAuditLog }   = require("../middleware/audit");

// All routes require superadmin
const superOnly = [adminAuth, requireRole("superadmin")];

// ── GET /api/admin/shops ──────────────────────────────────────────────────────
router.get("/admin/shops", ...superOnly, async (req, res) => {
  try {
    const [shops, settings] = await Promise.all([
      Shop.find({}).sort({ createdAt: -1 }).lean(),
      ShopSettings.find({}, "shopId shopName billingStatus onboarding").lean(),
    ]);

    const settingsMap = {};
    for (const s of settings) settingsMap[s.shopId] = s;

    const enriched = shops.map(s => ({
      ...s,
      password: undefined,
      shopName:       settingsMap[s.shopId]?.shopName || s.name,
      billingStatus:  settingsMap[s.shopId]?.billingStatus || "trial",
      onboardingDone: settingsMap[s.shopId]?.onboarding?.completedAt ? true : false,
    }));

    res.json({ success: true, count: enriched.length, shops: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── POST /api/admin/shops ─────────────────────────────────────────────────────
// Creates: Shop doc + default ShopSettings + owner User
router.post(
  "/admin/shops",
  ...superOnly,
  [
    body("shopId").trim().notEmpty().matches(/^[a-z0-9\-_]+$/).withMessage("shopId must be lowercase letters, numbers, hyphens only"),
    body("name").trim().notEmpty().isLength({ max: 100 }),
    body("ownerEmail").trim().isEmail(),
    body("ownerName").trim().notEmpty(),
    body("ownerPassword").isLength({ min: 8 }),
    body("plan").optional().isIn(["trial","active","paused"]),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const { shopId, name, ownerEmail, ownerName, ownerPassword, plan } = req.body;

      // Check shopId is unique
      const existingShop = await Shop.findOne({ shopId });
      if (existingShop) {
        return res.status(409).json({ success: false, message: "A shop with this shopId already exists" });
      }

      // Create in sequence to allow rollback if needed
      const shop = await Shop.create({
        shopId, name,
        email: ownerEmail.toLowerCase(),
        password: ownerPassword, // hashed by pre-save hook
        active: true,
        plan: plan || "trial",
      });

      // Default settings
      const settings = await ShopSettings.create({ shopId, shopName: name });

      // Owner user
      const owner = await User.create({
        shopId,
        name:     ownerName,
        email:    ownerEmail,
        password: ownerPassword, // hashed by pre-save hook
        role:     "owner",
        active:   true,
      });

      await createAuditLog(
        { shopId: "superadmin", user: req.user, ip: req.ip },
        { action: "shop_created", entity: "shop", entityId: shopId, entityLabel: name,
          after: { shopId, name, ownerEmail, plan } }
      );

      res.status(201).json({
        success: true,
        message: `Shop "${name}" created with shopId "${shopId}"`,
        shop: { shopId, name, plan: shop.plan },
        owner: { email: owner.email, name: owner.name, role: owner.role },
        settings: { shopId: settings.shopId },
        // Embedding instructions
        embedInstructions: {
          shopifyApiUrl: `https://roadstar-api.onrender.com/api/business-hours?shopId=${shopId}`,
          availabilityUrl: `https://roadstar-api.onrender.com/api/availability?shopId=${shopId}&date=YYYY-MM-DD&service=SERVICE_NAME`,
          shopIdParam: shopId,
          note: "Pass shopId as ?shopId= query param on all public Shopify form API calls",
        },
      });
    } catch (err) {
      console.error("POST /api/admin/shops:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ── PATCH /api/admin/shops/:shopId ────────────────────────────────────────────
router.patch(
  "/admin/shops/:shopId",
  ...superOnly,
  [
    body("name").optional().trim().notEmpty(),
    body("active").optional().isBoolean(),
    body("plan").optional().isIn(["trial","active","paused"]),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const { shopId } = req.params;
      const { name, active, plan } = req.body;

      const shop = await Shop.findOne({ shopId });
      if (!shop) return res.status(404).json({ success: false, message: "Shop not found" });

      const before = { name: shop.name, active: shop.active, plan: shop.plan };
      const updates = {};
      if (name   !== undefined) updates.name   = name;
      if (active !== undefined) updates.active = active;
      if (plan   !== undefined) updates.plan   = plan;

      await Shop.findOneAndUpdate({ shopId }, { $set: updates });

      const actionLabel = active === false ? "shop_paused"
        : active === true ? "shop_activated"
        : "updated";

      await createAuditLog(
        { shopId, user: req.user, ip: req.ip },
        { action: actionLabel, entity: "shop", entityId: shopId, entityLabel: shop.name, before, after: updates }
      );

      res.json({ success: true, shopId, updates });
    } catch (err) {
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ── GET /api/admin/shops/:shopId/stats ────────────────────────────────────────
router.get("/admin/shops/:shopId/stats", ...superOnly, async (req, res) => {
  try {
    const { shopId } = req.params;
    const [bookingCount, recentBookings, userCount] = await Promise.all([
      Booking.countDocuments({ shopId, deleted: { $ne: true } }),
      Booking.find({ shopId, deleted: { $ne: true } }).sort({ createdAt: -1 }).limit(3).lean(),
      User.countDocuments({ shopId, deleted: { $ne: true } }),
    ]);
    res.json({ success: true, shopId, bookingCount, userCount, recentBookings });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
