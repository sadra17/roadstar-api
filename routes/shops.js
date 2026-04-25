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

      // Create shop
      const shop = await Shops.create({ shopId, name, email: ownerEmail.toLowerCase(), passwordHash, active: true, plan: plan || "trial" });

      // Create default settings
      await ShopSettings.getOrCreate(shopId);
      // Update shop name in settings
      await ShopSettings.update(shopId, { shop_name: name });

      // Create owner user
      const ownerHash = await bcrypt.hash(ownerPassword, 10);
      const owner = await Users.create({ shopId, name: ownerName, email: ownerEmail.toLowerCase(), passwordHash: ownerHash, role: "owner" });

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
          availabilityUrl: `https://roadstar-api.onrender.com/api/availability?shopId=${shopId}`,
          businessHoursUrl: `https://roadstar-api.onrender.com/api/business-hours?shopId=${shopId}`,
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
    const [bookingCount, userCount] = await Promise.all([
      Bookings.countDocuments({ shop_id: shopId, deleted: false }),
      (async () => { const u = await Users.find({ shop_id: shopId, deleted: false }); return u.length; })(),
    ]);
    res.json({ success: true, shopId, bookingCount, userCount });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
