// routes/auditLog.js  v9-supabase
"use strict";

const express = require("express");
const router  = express.Router();

const { AuditLogs } = require("../lib/db");
const adminAuth     = require("../middleware/adminAuth");
const { requirePermission } = require("../middleware/adminAuth");

router.get("/audit-log", adminAuth, requirePermission("view:audit_log"), async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page  || "1", 10));
    const limit = Math.min(200, parseInt(req.query.limit || "50", 10));

    const filter = {};
    if (!req.user._isSuperAdmin) filter.shop_id = req.shopId;
    else if (req.query.shopId)   filter.shop_id = req.query.shopId;

    if (req.query.entity)   filter.entity   = req.query.entity;
    if (req.query.action)   filter.action   = req.query.action;
    if (req.query.userId)   filter.user_id  = req.query.userId;
    if (req.query.entityId) filter.entity_id= req.query.entityId;

    if (req.query.from || req.query.to) {
      filter.created_at = {};
      if (req.query.from) filter.created_at.$gte = new Date(req.query.from).toISOString();
      if (req.query.to)   filter.created_at.$lte = new Date(req.query.to).toISOString();
    }

    const { logs, total } = await AuditLogs.find(filter, page, limit);
    res.json({ success: true, page, limit, total, pages: Math.ceil(total / limit), logs });
  } catch (err) {
    console.error("GET /api/audit-log:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
