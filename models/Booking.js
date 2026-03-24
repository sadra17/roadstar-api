// ─────────────────────────────────────────────────────────────────────────────
// models/Booking.js  v8
// Changes: shopId (multi-tenancy), no_show status, smsLog (message history)
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema(
  {
    // ── Multi-tenancy ─────────────────────────────────────────────────────────
    shopId: { type: String, required: true, trim: true },

    // ── Customer ──────────────────────────────────────────────────────────────
    firstName: { type: String, required: true, trim: true, maxlength: 60 },
    lastName:  { type: String, required: true, trim: true, maxlength: 60 },
    phone:     { type: String, required: true, trim: true },

    // ── Service ───────────────────────────────────────────────────────────────
    service:       { type: String, required: true, trim: true },
    customService: { type: String, trim: true, maxlength: 300, default: "" },

    // ── Scheduling ───────────────────────────────────────────────────────────
    date:                    { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    time:                    { type: String, required: true },
    service_duration:        { type: Number, required: true, default: 10 },
    equipment_recovery_time: { type: Number, default: 0 },
    resourcePool:            { type: String, enum: ["bay","alignment","none"], default: "none" },

    // ── Capacity ──────────────────────────────────────────────────────────────
    customer_quantity:       { type: Number, default: 1, min: 1 },
    capacityOverrideApplied: { type: Number, default: null },

    // ── Tire info ─────────────────────────────────────────────────────────────
    tireSize:           { type: String, trim: true, maxlength: 50, default: "" },
    doesntKnowTireSize: { type: Boolean, default: false },

    // ── Status — includes no_show for missed confirmed appointments ───────────
    status: {
      type:    String,
      enum:    ["pending","confirmed","waitlist","completed","cancelled","no_show"],
      default: "pending",
    },

    notes: { type: String, trim: true, maxlength: 1000, default: "" },

    // ── Bay assignment ────────────────────────────────────────────────────────
    bayNumber:           { type: Number, default: null },
    activeInBayAt:       { type: Date,   default: null },
    bayCheckSnoozeUntil: { type: Date,   default: null },

    // ── SMS log — full history of every message sent for this booking ─────────
    smsLog: [{
      messageType: { type: String },
      body:        { type: String },
      sentAt:      { type: Date },
      status:      { type: String, enum: ["sent","failed","skipped"] },
      twilioSid:   { type: String, default: null },
      error:       { type: String, default: null },
      _id:         false,
    }],

    // ── Legacy SMS field (backward compat) ────────────────────────────────────
    smsSentAt:           { type: Date, default: null },
    completedSmsVariant: { type: String, enum: ["with_review","without_review","none",null], default: null },

    // ── Reminder tracking ─────────────────────────────────────────────────────
    reminderSentAt: { type: Date, default: null },
    reminderStatus: { type: String, enum: ["sent","failed","skipped",null], default: null },
    reminderError:  { type: String, default: null },

    // ── Soft delete ───────────────────────────────────────────────────────────
    deleted:   { type: Boolean, default: false },
    deletedAt: { type: Date,    default: null },

    // ── Lifecycle ─────────────────────────────────────────────────────────────
    completedAt: { type: Date,    default: null },
    noShowAt:    { type: Date,    default: null },
    isWalkIn:    { type: Boolean, default: false },
  },
  { timestamps: true }
);

bookingSchema.index({ shopId: 1, date: 1, time: 1 });
bookingSchema.index({ shopId: 1, date: 1, status: 1, resourcePool: 1, deleted: 1 });
bookingSchema.index({ shopId: 1, phone: 1 });
bookingSchema.index({ shopId: 1, reminderStatus: 1, date: 1 });
bookingSchema.index({ shopId: 1, deleted: 1, deletedAt: 1 });
bookingSchema.index({ shopId: 1, date: 1, status: 1, bayNumber: 1 });

bookingSchema.virtual("customer").get(function () {
  return `${this.firstName} ${this.lastName}`;
});
bookingSchema.set("toJSON", { virtuals: true });

module.exports = mongoose.model("Booking", bookingSchema);
