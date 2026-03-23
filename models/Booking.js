// ─────────────────────────────────────────────────────────────────────────────
// models/Booking.js  v7
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

    // ── Scheduling fields (denormalised from config at booking creation) ───────
    // Stored so capacity queries work even if config changes later.
    date:                    { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    time:                    { type: String, required: true }, // "9:00 AM"
    service_duration:        { type: Number, required: true, default: 10 },  // minutes
    equipment_recovery_time: { type: Number, default: 0 },    // minutes
    resourcePool:            { type: String, enum: ["bay","alignment","none"], default: "none" },

    // ── Capacity fields ───────────────────────────────────────────────────────
    // customer_quantity: how many capacity units this booking consumes.
    // Default = 1. Hidden from customer UI. Future-safe for multi-car bookings.
    customer_quantity: { type: Number, default: 1, min: 1 },

    // Per-slot capacity override (null = use pool default)
    capacityOverrideApplied: { type: Number, default: null },

    // ── Tire info ─────────────────────────────────────────────────────────────
    tireSize:           { type: String, trim: true, maxlength: 50, default: "" },
    doesntKnowTireSize: { type: Boolean, default: false },

    // ── Status ────────────────────────────────────────────────────────────────
    status: {
      type:    String,
      enum:    ["pending","confirmed","waitlist","completed","cancelled"],
      default: "pending",
    },

    // ── Notes ─────────────────────────────────────────────────────────────────
    notes: { type: String, trim: true, maxlength: 1000, default: "" },

    // ── Bay assignment (Live at Bay) ───────────────────────────────────────────
    bayNumber:           { type: Number, default: null },  // 1, 2, 3 for normal bays
    activeInBayAt:       { type: Date,   default: null },
    bayCheckSnoozeUntil: { type: Date,   default: null },

    // ── SMS tracking ──────────────────────────────────────────────────────────
    smsSentAt: { type: Date, default: null },
    completedSmsVariant: {
      type:    String,
      enum:    ["with_review","without_review","none",null],
      default: null,
    },

    // ── Reminder tracking ─────────────────────────────────────────────────────
    reminderSentAt: { type: Date, default: null },
    reminderStatus: { type: String, enum: ["sent","failed","skipped",null], default: null },
    reminderError:  { type: String, default: null },

    // ── Lifecycle ─────────────────────────────────────────────────────────────
    completedAt: { type: Date,    default: null },
    isWalkIn:    { type: Boolean, default: false },
  },
  { timestamps: true }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
// IMPORTANT: the old unique({ date, time }) index must be dropped.
// Run: db.bookings.dropIndex("date_1_time_1")
bookingSchema.index({ date: 1, time: 1 });                                  // non-unique
bookingSchema.index({ date: 1, status: 1, resourcePool: 1 });               // capacity queries
bookingSchema.index({ phone: 1 });                                          // customer history
bookingSchema.index({ reminderStatus: 1, date: 1 });                        // reminder scheduler
bookingSchema.index({ date: 1, status: 1, bayNumber: 1 });                  // live-at-bay

bookingSchema.virtual("customer").get(function () {
  return `${this.firstName} ${this.lastName}`;
});
bookingSchema.set("toJSON", { virtuals: true });

module.exports = mongoose.model("Booking", bookingSchema);
