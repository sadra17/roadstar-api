// ─────────────────────────────────────────────────────────────────────────────
// models/ShopSettings.js
//
// One document per shop. Contains everything a shop owner can configure
// without needing a developer:
//   - business info (name, phone, timezone)
//   - business hours per weekday
//   - blackout dates (holidays / closures)
//   - services (name, duration, recovery, resource pool, active)
//   - capacity (bay count, alignment on/off)
//   - SMS templates (editable per message type)
//   - Google review link
//   - branding (logo, colour)
//   - reminder settings (enabled, minutes before)
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const mongoose = require("mongoose");

// ── Sub-schemas ───────────────────────────────────────────────────────────────
const DayHoursSchema = new mongoose.Schema({
  open:   { type: String, default: null }, // "09:00" or null = closed
  close:  { type: String, default: null },
}, { _id: false });

const ServiceDefSchema = new mongoose.Schema({
  name:                   { type: String, required: true, trim: true },
  service_duration:       { type: Number, required: true, default: 30 },
  equipment_recovery_time:{ type: Number, default: 0 },
  resourcePool:           { type: String, enum: ["bay","alignment","none"], default: "none" },
  active:                 { type: Boolean, default: true },
}, { _id: false });

const SmsTemplatesSchema = new mongoose.Schema({
  confirmed:          { type: String, default: "Hi {firstName}! Your {shopName} appointment is CONFIRMED for {date} at {time} ({service}). See you soon! — {shopName}" },
  declined:           { type: String, default: "Hi {firstName}, we had to cancel your {time} appointment on {date}. Please call us to reschedule. — {shopName}" },
  waitlist:           { type: String, default: "Hi {firstName}! A spot just opened at {shopName} on {date}. Call us to claim it! — {shopName}" },
  reminder:           { type: String, default: "Hi {firstName}, reminder: your {shopName} appointment is TODAY at {time} for {service}. See you soon! — {shopName}" },
  completed_review:   { type: String, default: "Thanks for visiting {shopName}, {firstName}! We hope you love your {service}. Drive safe!\n\nClick the link to leave us a review\n{reviewLink}" },
  completed_no_review:{ type: String, default: "Thanks for visiting {shopName}, {firstName}! We hope you love your {service}. Drive safe! — {shopName}" },
}, { _id: false });

// ── Main schema ───────────────────────────────────────────────────────────────
const shopSettingsSchema = new mongoose.Schema(
  {
    shopId: { type: String, required: true, unique: true, trim: true },

    // ── Business info ─────────────────────────────────────────────────────────
    shopName:  { type: String, default: "My Shop" },
    phone:     { type: String, default: "" },
    address:   { type: String, default: "" },
    timezone:  { type: String, default: "America/Toronto" },

    // ── Hours — 0=Sun … 6=Sat, null open/close = closed ─────────────────────
    hours: {
      0: { type: DayHoursSchema, default: () => ({ open: null,    close: null   }) },
      1: { type: DayHoursSchema, default: () => ({ open: "09:00", close: "18:00"}) },
      2: { type: DayHoursSchema, default: () => ({ open: "09:30", close: "18:00"}) },
      3: { type: DayHoursSchema, default: () => ({ open: "09:30", close: "18:00"}) },
      4: { type: DayHoursSchema, default: () => ({ open: "09:30", close: "18:00"}) },
      5: { type: DayHoursSchema, default: () => ({ open: "09:30", close: "18:00"}) },
      6: { type: DayHoursSchema, default: () => ({ open: "09:30", close: "16:00"}) },
    },

    // ── Blackout dates — YYYY-MM-DD strings ──────────────────────────────────
    blackoutDates: [{ type: String }],

    // ── Services ──────────────────────────────────────────────────────────────
    services: {
      type:    [ServiceDefSchema],
      default: () => [
        { name:"Tire Change + Installation", service_duration:40, equipment_recovery_time:0, resourcePool:"bay",       active:true },
        { name:"Flat Tire Repair",           service_duration:15, equipment_recovery_time:0, resourcePool:"bay",       active:true },
        { name:"Tire Rotation",              service_duration:20, equipment_recovery_time:0, resourcePool:"bay",       active:true },
        { name:"Wheel Alignment",            service_duration:60, equipment_recovery_time:0, resourcePool:"alignment", active:true },
        { name:"Tire Purchase",              service_duration:10, equipment_recovery_time:0, resourcePool:"none",      active:true },
        { name:"Other",                      service_duration:30, equipment_recovery_time:0, resourcePool:"none",      active:true },
      ],
    },

    // ── Capacity ──────────────────────────────────────────────────────────────
    bayCount:             { type: Number, default: 3, min: 1, max: 20 },
    alignmentLaneEnabled: { type: Boolean, default: true },
    alignmentCapacity:    { type: Number, default: 1, min: 1 },

    // ── SMS ───────────────────────────────────────────────────────────────────
    smsTemplates:   { type: SmsTemplatesSchema, default: () => ({}) },
    googleReviewLink: { type: String, default: "" },

    // ── Reminders ─────────────────────────────────────────────────────────────
    reminderEnabled: { type: Boolean, default: true },
    reminderMinutes: { type: Number,  default: 30 },

    // ── Branding ──────────────────────────────────────────────────────────────
    logoUrl:      { type: String, default: "" },
    primaryColor: { type: String, default: "#2563EB" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ShopSettings", shopSettingsSchema);
