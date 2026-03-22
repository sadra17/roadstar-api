// ─────────────────────────────────────────────────────────────────────────────
// models/Booking.js  v5
// Backward-compatible additions:
//   • tireSize + doesntKnowTireSize
//   • usesJack (denormalised for fast queries)
//   • reminder tracking fields
//   • completedSmsVariant
//   • REMOVED unique({ date, time }) — capacity now enforced in app layer
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const mongoose = require("mongoose");
const { ALL_SERVICES } = require("../config/business");

const bookingSchema = new mongoose.Schema(
  {
    // ── Customer ─────────────────────────────────────────────────────────────
    firstName: { type: String, required: true, trim: true, maxlength: 60 },
    lastName:  { type: String, required: true, trim: true, maxlength: 60 },
    phone:     { type: String, required: true, trim: true },

    // ── Service ──────────────────────────────────────────────────────────────
    service: {
      type: String,
      required: true,
      enum: { values: ALL_SERVICES, message: "Invalid service: {VALUE}" },
    },
    customService: { type: String, trim: true, maxlength: 300, default: "" },

    // ── Scheduling ───────────────────────────────────────────────────────────
    date:     { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    time:     { type: String, required: true },     // stored as "9:00 AM"
    duration: { type: Number, required: true, default: 10 },
    usesJack: { type: Boolean, required: true, default: false },

    // ── Tire info ─────────────────────────────────────────────────────────────
    tireSize:           { type: String, trim: true, maxlength: 50, default: "" },
    doesntKnowTireSize: { type: Boolean, default: false },

    // ── Status ───────────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ["pending", "confirmed", "waitlist", "completed", "cancelled"],
      default: "pending",
    },

    // ── Notes ────────────────────────────────────────────────────────────────
    notes: { type: String, trim: true, maxlength: 1000, default: "" },

    // ── SMS tracking ─────────────────────────────────────────────────────────
    smsSentAt: { type: Date, default: null },
    // "with_review" | "without_review" | "none" | null
    completedSmsVariant: {
      type: String,
      enum: ["with_review", "without_review", "none", null],
      default: null,
    },

    // ── Reminder tracking (auto 30-min SMS) ───────────────────────────────────
    reminderSentAt: { type: Date,   default: null },
    reminderStatus: {
      type: String,
      enum: ["sent", "failed", "skipped", null],
      default: null,
    },
    reminderError: { type: String, default: null },

    // ── Lifecycle ────────────────────────────────────────────────────────────
    completedAt: { type: Date,    default: null },
    isWalkIn:    { type: Boolean, default: false },
  },
  { timestamps: true }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
// NOTE: The old unique({ date, time }) index must be DROPPED in MongoDB.
//       Run in Atlas shell:  db.bookings.dropIndex("date_1_time_1")
//       (or drop via Compass)
bookingSchema.index({ date: 1, time: 1 });           // non-unique — fast lookup
bookingSchema.index({ phone: 1 });                   // customer history
bookingSchema.index({ status: 1, date: 1 });
bookingSchema.index({ reminderStatus: 1, date: 1 }); // reminder scheduler

bookingSchema.virtual("customer").get(function () {
  return `${this.firstName} ${this.lastName}`;
});
bookingSchema.set("toJSON", { virtuals: true });

module.exports = mongoose.model("Booking", bookingSchema);
