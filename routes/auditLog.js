// routes/auditLog.js  v9-supabase
"use strict";

const express = require("express");
const router  = express.Router();

const { AuditLogs } = require("../lib/db");
const adminAuth     = require("../middleware/adminAuth");
const { requirePermission } = require("../middleware/adminAuth");

router.get("/audit-log", adminAuth, requirePermission("view:audit_log"), async (req, res) => {
  try {
    // Query values must be single strings (?page=1&page=2 arrives as an array)
    const q = k => (typeof req.query[k] === "string" ? req.query[k].trim() : "");
    const page  = Math.max(1, parseInt(q("page"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(q("limit"), 10) || 50));

    const filter = {};
    if (!req.user._isSuperAdmin) filter.shop_id = req.shopId;
    else if (q("shopId"))        filter.shop_id = q("shopId");

    // Texts are logged as action "sms_sent" on the booking (entity "booking"), so the
    // "sms_sent" filter means the action, whichever parameter it arrives in.
    if (q("entity") === "sms_sent") filter.action = "sms_sent";
    else if (q("entity")) filter.entity = q("entity");
    if (q("action"))   filter.action   = q("action");
    if (q("userId"))   filter.user_id  = q("userId");
    if (q("entityId")) filter.entity_id= q("entityId");

    if (q("from") || q("to")) {
      const from = q("from") ? new Date(q("from")) : null, to = q("to") ? new Date(q("to")) : null;
      if ((from && isNaN(from)) || (to && isNaN(to))) return res.status(400).json({ success: false, message: "Invalid from/to date" });
      filter.created_at = {};
      if (from) filter.created_at.$gte = from.toISOString();
      if (to)   filter.created_at.$lte = to.toISOString();
    }

    const { logs, total } = await AuditLogs.find(filter, page, limit);
    res.json({ success: true, page, limit, total, pages: Math.ceil(total / limit), logs });
  } catch (err) {
    console.error("GET /api/audit-log:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
