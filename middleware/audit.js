// middleware/audit.js  v9-supabase
"use strict";

const { AuditLogs } = require("../lib/db");

async function createAuditLog(req, { action, entity, entityId=null, entityLabel=null, field=null, before=null, after=null, meta=null }) {
  try {
    await AuditLogs.create({
      shopId:     req.shopId     || "unknown",
      userId:     req.user?.userId   || null,
      userEmail:  req.user?.email    || null,
      userName:   req.user?.name     || null,
      userRole:   req.user?.role     || null,
      action, entity,
      entityId:   entityId    ? String(entityId) : null,
      entityLabel,
      field,
      before,
      after,
      meta,
      ip:        req.ip || req.headers?.["x-forwarded-for"] || null,
      userAgent: req.headers?.["user-agent"] || null,
    });
  } catch (err) {
    console.error("[AuditLog] Failed:", err.message, { action, entity });
  }
}

module.exports = { createAuditLog };
