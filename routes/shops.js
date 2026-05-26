// routes/shops.js  v9-supabase
"use strict";

const express = require("express");
const { body } = require("express-validator");
const bcrypt  = require("bcryptjs");
const router  = express.Router();

const { Shops, ShopSettings, Users, Bookings } = require("../lib/db");
const adminAuth  = require("../middleware/adminAuth");
const { requireRole }      = require("../middleware/adminAuth");
const { handleValidation } = require("../middleware/validate");
const { createAuditLog }   = require("../middleware/audit");
const sb = require("../config/supabase");

const superOnly = [adminAuth, requireRole("superadmin")];

router.get("/admin/shops", ...superOnly, async (req, res) => {
  try {
    const [shops, settings] = await Promise.all([
      Shops.findAll(),
      ShopSettings.findAll(),
    ]);
    const settingsMap = {};
    for (const s of settings) settingsMap[s.shopId] = s;
    const enriched = shops.map(s => ({
      ...s,
      passwordHash:   undefined,
      shopName:       settingsMap[s.shopId]?.shopName || s.name,
      billingStatus:  settingsMap[s.shopId]?.billingStatus || "trial",
    }));
    res.json({ success: true, count: enriched.length, shops: enriched });
  } catch (err) {
    console.error("GET /api/admin/shops:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/admin/shops", ...superOnly,
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

      const existing = await Shops.findByShopId(shopId);
      if (existing) return res.status(409).json({ success: false, message: "A shop with this shopId already exists" });

      const passwordHash = await bcrypt.hash(ownerPassword, 10);

      // EH7: create shop first, then roll back on any subsequent failure
      const shop = await Shops.create({ shopId, name, email: ownerEmail.toLowerCase(), passwordHash, active: true, plan: plan || "trial" });

      let owner;
      try {
        // Create default settings
        await ShopSettings.getOrCreate(shopId);
        await ShopSettings.update(shopId, { shop_name: name });

        // Create owner user (same password as shop login for convenience)
        owner = await Users.create({ shopId, name: ownerName, email: ownerEmail.toLowerCase(), passwordHash, role: "owner" });
      } catch (innerErr) {
        // Rollback: clean up the shop row so the shopId is not orphaned
        console.error(`[Shops] Rolling back shop "${shopId}" after inner error:`, innerErr.message);
        try { await Shops.delete(shopId); } catch (rbErr) { console.error("[Shops] Rollback failed:", rbErr.message); }
        throw innerErr; // re-throw so the outer catch returns 500
      }

      await createAuditLog(
        { shopId: "superadmin", user: req.user, ip: req.ip },
        { action: "shop_created", entity: "shop", entityId: shopId, entityLabel: name, after: { shopId, name, ownerEmail, plan } }
      );

      res.status(201).json({
        success: true,
        message: `Shop "${name}" created`,
        shop: { shopId, name, plan: shop.plan },
        owner: { email: owner.email, name: owner.name, role: owner.role },
        embedInstructions: {
          availabilityUrl: `${process.env.API_URL || "https://roadstar-api.onrender.com"}/api/availability?shopId=${shopId}`,
          businessHoursUrl: `${process.env.API_URL || "https://roadstar-api.onrender.com"}/api/business-hours?shopId=${shopId}`,
          shopIdParam: shopId,
        },
      });
    } catch (err) {
      console.error("POST /api/admin/shops:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

router.patch("/admin/shops/:shopId", ...superOnly,
  [body("name").optional().trim(), body("active").optional().isBoolean(), body("plan").optional().isIn(["trial","active","paused"])],
  handleValidation,
  async (req, res) => {
    try {
      const { shopId } = req.params;
      const shop = await Shops.findByShopId(shopId);
      if (!shop) return res.status(404).json({ success: false, message: "Shop not found" });
      const updates = {};
      if (req.body.name   !== undefined) updates.name   = req.body.name;
      if (req.body.active !== undefined) updates.active = req.body.active;
      if (req.body.plan   !== undefined) updates.plan   = req.body.plan;
      await Shops.update(shopId, updates);
      await createAuditLog({ shopId, user: req.user, ip: req.ip }, { action:"updated", entity:"shop", entityId:shopId, entityLabel:shop.name, after:updates });
      res.json({ success: true, shopId, updates });
    } catch (err) {
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

router.get("/admin/shops/:shopId/stats", ...superOnly, async (req, res) => {
  try {
    const { shopId } = req.params;
    const now     = new Date();
    const today   = now.toISOString().slice(0, 10);
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const [todayBookings, weekBookings, allBookings] = await Promise.all([
      Bookings.countDocuments({ shop_id: shopId, date: today,                          deleted: false }),
      Bookings.countDocuments({ shop_id: shopId, date: { $gte: weekAgo, $lte: today }, deleted: false }),
      Bookings.find(          { shop_id: shopId,                                        deleted: false }, { select: "phone" }),
    ]);

    // Unique customers by phone number
    const totalCustomers = new Set(allBookings.map(b => b.phone).filter(Boolean)).size;

    res.json({ success: true, shopId, todayBookings, weekBookings, totalCustomers });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
