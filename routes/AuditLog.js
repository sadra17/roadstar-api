// ─────────────────────────────────────────────────────────────────────────────
// models/AuditLog.js
//
// Immutable audit trail. Documents are never updated or deleted.
//
// Entity types: booking | customer | setting | user | service | hours |
//               blackout | capacity | sms_template | price | login
//
// Action types: created | updated | deleted | restored | status_changed |
//               confirmed | cancelled | completed | no_show | sms_sent |
//               login_success | login_failed | password_changed | role_changed |
//               shop_created | shop_paused | shop_activated
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema(
  {
    // ── Context ───────────────────────────────────────────────────────────────
    shopId: { type: String, required: true },

    // ── Actor ─────────────────────────────────────────────────────────────────
    userId:    { type: String, default: null }, // null for system events
    userEmail: { type: String, default: null },
    userName:  { type: String, default: null },
    userRole:  { type: String, default: null },

    // ── Event ─────────────────────────────────────────────────────────────────
    action:     { type: String, required: true }, // e.g. "updated", "status_changed"
    entity:     { type: String, required: true }, // e.g. "booking", "setting"
    entityId:   { type: String, default: null  }, // MongoDB _id of affected document
    entityLabel:{ type: String, default: null  }, // human label, e.g. "John Smith — 9:00 AM"

    // ── Change detail ─────────────────────────────────────────────────────────
    field:      { type: String, default: null }, // which field changed, e.g. "status"
    before:     { type: mongoose.Schema.Types.Mixed, default: null }, // previous value
    after:      { type: mongoose.Schema.Types.Mixed, default: null }, // new value
    meta:       { type: mongoose.Schema.Types.Mixed, default: null }, // extra context

    // ── Request context ───────────────────────────────────────────────────────
    ip:        { type: String, default: null },
    userAgent: { type: String, default: null },
  },
  {
    timestamps: true,
    // Audit logs are never updated
    // Use createdAt as the event timestamp
  }
);

// Compound indexes for dashboard filter queries
auditLogSchema.index({ shopId: 1, createdAt: -1 });
auditLogSchema.index({ shopId: 1, entity: 1, createdAt: -1 });
auditLogSchema.index({ shopId: 1, userId: 1, createdAt: -1 });
auditLogSchema.index({ shopId: 1, entityId: 1, createdAt: -1 });

// TTL: optionally auto-delete old audit logs after 365 days
// Uncomment to enable:
// auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

module.exports = mongoose.model("AuditLog", auditLogSchema);
