// ─────────────────────────────────────────────────────────────────────────────
// models/Booking.js  v7.3
// Adds: deleted (soft delete), deletedAt
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const mongoose = require("mongoose");
const { ALL_SERVICES } = require("../config/business");

const bookingSchema = new mongoose.Schema(
  {
    // ── Customer ──────────────────────────────────────────────────────────────
    firstName: { type: String, required: true, trim: true, maxlength: 60 },
    lastName:  { type: String, required: true, trim: true, maxlength: 60 },
    phone:     { type: String, required: true, trim: true },

    // ── Service ───────────────────────────────────────────────────────────────
    service: {
      type: String,
      required: true,
      enum: { values: ALL_SERVICES, message: "Invalid service: {VALUE}" },
    },
    customService: { type: String, trim: true, maxlength: 300, default: "" },

    // ── Scheduling ───────────────────────────────────────────────────────────
    date:                    { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    time:                    { type: String, required: true },
    service_duration:        { type: Number, required: true, default: 10 },
    equipment_recovery_time: { type: Number, default: 0 },
    resourcePool:            { type: String, enum: ["bay", "alignment", "none"], default: "none" },

    // ── Capacity ──────────────────────────────────────────────────────────────
    customer_quantity:       { type: Number, default: 1, min: 1 },
    capacityOverrideApplied: { type: Number, default: null },

    // ── Tire info ─────────────────────────────────────────────────────────────
    tireSize:           { type: String, trim: true, maxlength: 50, default: "" },
    doesntKnowTireSize: { type: Boolean, default: false },

    // ── Status ────────────────────────────────────────────────────────────────
    status: {
      type:    String,
      enum:    ["pending", "confirmed", "waitlist", "completed", "cancelled"],
      default: "pending",
    },

    // ── Notes ─────────────────────────────────────────────────────────────────
    notes: { type: String, trim: true, maxlength: 1000, default: "" },

    // ── Bay assignment ────────────────────────────────────────────────────────
    bayNumber:           { type: Number, default: null },
    activeInBayAt:       { type: Date,   default: null },
    bayCheckSnoozeUntil: { type: Date,   default: null },

    // ── SMS tracking ──────────────────────────────────────────────────────────
    smsSentAt: { type: Date, default: null },
    completedSmsVariant: {
      type:    String,
      enum:    ["with_review", "without_review", "none", null],
      default: null,
    },

    // ── Reminder tracking ─────────────────────────────────────────────────────
    reminderSentAt: { type: Date, default: null },
    reminderStatus: { type: String, enum: ["sent", "failed", "skipped", null], default: null },
    reminderError:  { type: String, default: null },

    // ── Soft delete ───────────────────────────────────────────────────────────
    // deleted = true means the booking was "trashed" by admin.
    // It is NOT permanently removed — it stays for 15 days then auto-purged.
    // All capacity checks, live queue, live-at-bay, and availability
    // MUST filter deleted: { $ne: true } to ignore these records.
    deleted:   { type: Boolean, default: false },
    deletedAt: { type: Date,    default: null },

    // ── Lifecycle ─────────────────────────────────────────────────────────────
    completedAt: { type: Date,    default: null },
    isWalkIn:    { type: Boolean, default: false },
  },
  { timestamps: true }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
bookingSchema.index({ date: 1, time: 1 });
bookingSchema.index({ date: 1, status: 1, resourcePool: 1, deleted: 1 }); // capacity queries
bookingSchema.index({ phone: 1 });
bookingSchema.index({ reminderStatus: 1, date: 1 });
bookingSchema.index({ date: 1, status: 1, bayNumber: 1 });
bookingSchema.index({ deleted: 1, deletedAt: 1 });  // recently-deleted + cleanup queries

bookingSchema.virtual("customer").get(function () {
  return `${this.firstName} ${this.lastName}`;
});
bookingSchema.set("toJSON", { virtuals: true });

module.exports = mongoose.model("Booking", bookingSchema);
