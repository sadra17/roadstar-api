// ─────────────────────────────────────────────────────────────────────────────
// routes/bookings.js  v7.3
//
// Changes:
//   - Soft delete: DELETE endpoint marks deleted=true/deletedAt instead of removing
//   - PATCH /api/bookings/:id/restore — restore a soft-deleted booking
//   - GET  /api/recently-deleted      — bookings deleted in last 15 days
//   - deleted: { $ne: true } on EVERY query that should ignore trashed bookings
//   - capacity checks import CAPACITY_BLOCKING_STATUS (string "confirmed")
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const express = require("express");
const { body, query, param } = require("express-validator");
const router  = express.Router();

const Booking   = require("../models/Booking");
const adminAuth = require("../middleware/adminAuth");
const { handleValidation } = require("../middleware/validate");
const {
  ALL_SERVICES, SERVICE_DEFS, HOURS, RESOURCE_POOLS,
  CAPACITY_BLOCKING_STATUS,
  resolveService, resolvedOccupation,
  computeAvailability, validateCapacity, getHoursForDate,
  display12To24, toMinutes,
} = require("../config/business");

const GOOGLE_REVIEW     = "https://g.page/r/CYPKn0GrR0t3EBM/review";
const SOFT_DELETE_DAYS  = 15; // auto-purge after 15 days

// ── Twilio ────────────────────────────────────────────────────────────────────
async function sendTwilioSMS(to, body) {
  if (!process.env.TWILIO_ACCOUNT_SID) {
    console.warn("[SMS] Twilio not configured — skipping");
    return null;
  }
  const client = require("twilio")(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  return client.messages.create({ body, from: process.env.TWILIO_PHONE_NUMBER, to });
}

function svcLabel(b) {
  return b.service === "Other" && b.customService
    ? `Other — ${b.customService}` : b.service;
}

const sms = {
  confirmed: (b) =>
    `Hi ${b.firstName}! Your Roadstar Tire appointment is CONFIRMED for ${b.date} at ${b.time} (${svcLabel(b)}). See you soon! — Roadstar Tire`,
  declined: (b) =>
    `Hi ${b.firstName}, we had to cancel your ${b.time} appointment on ${b.date}. Please call us to reschedule. — Roadstar Tire`,
  waitlist: (b) =>
    `Hi ${b.firstName}! A spot just opened at Roadstar Tire on ${b.date}. Call us to claim it! — Roadstar Tire`,
  reminder: (b) =>
    `Hi ${b.firstName}, reminder: your Roadstar Tire appointment is TODAY at ${b.time} for ${svcLabel(b)}. See you soon! — Roadstar Tire`,
  completed_review: (b) =>
    `Thanks for visiting Roadstar Tire, ${b.firstName}! We hope you love your ${svcLabel(b)}. Drive safe!\n\nClick the link to leave us a review\n${GOOGLE_REVIEW}`,
  completed_no_review: (b) =>
    `Thanks for visiting Roadstar Tire, ${b.firstName}! We hope you love your ${svcLabel(b)}. Drive safe! — Roadstar Tire`,
};

// ── GET /api/business-hours ───────────────────────────────────────────────────
router.get("/business-hours", (_req, res) => {
  res.json({
    success:       true,
    hours:         HOURS,
    services:      ALL_SERVICES,
    serviceDefs:   SERVICE_DEFS,
    resourcePools: RESOURCE_POOLS,
  });
});

// ── GET /api/availability ─────────────────────────────────────────────────────
// Returns { available, full, allSlots }
// available = bookable slots
// full      = at-capacity slots (show grayed out, not hidden)
// allSlots  = time-ordered union
router.get(
  "/availability",
  [
    query("date").trim().matches(/^\d{4}-\d{2}-\d{2}$/).withMessage("date must be YYYY-MM-DD"),
    query("service").optional().trim(),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const { date, service = "Tire Change + Installation" } = req.query;
      const result = await computeAvailability(date, service, Booking);
      res.json({ success: true, date, ...result });
    } catch (err) {
      console.error("GET /api/availability:", err);
      res.status(500).json({ success: false, message: "Could not load availability." });
    }
  }
);

// ── POST /api/book — public ───────────────────────────────────────────────────
router.post(
  "/book",
  [
    body("firstName").trim().notEmpty().withMessage("First name is required.").isLength({ max: 60 }).escape(),
    body("lastName").trim().notEmpty().withMessage("Last name is required.").isLength({ max: 60 }).escape(),
    body("phone").trim().notEmpty().matches(/^[\d\s\-\(\)\+]{7,20}$/).withMessage("Please enter a valid phone number."),
    body("service").isIn(ALL_SERVICES).withMessage("Please select a valid service."),
    body("customService").optional().trim().isLength({ max: 300 }).escape(),
    body("date")
      .trim().matches(/^\d{4}-\d{2}-\d{2}$/).withMessage("Invalid date.")
      .custom(val => {
        if (!getHoursForDate(val)) throw new Error("Roadstar Tire is closed on this day.");
        return true;
      }),
    body("time").trim().notEmpty().withMessage("Please select a time slot."),
    body("tireSize").optional().trim().isLength({ max: 50 }).escape(),
    body("doesntKnowTireSize").optional().isBoolean(),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const {
        firstName, lastName, phone,
        service, customService,
        date, time,
        tireSize, doesntKnowTireSize,
      } = req.body;

      const def = resolveService(service);

      // validateCapacity only checks CONFIRMED, non-deleted bookings in the exact pool.
      // "none" pool (Tire Purchase, Other) returns ok:true immediately.
      const cap = await validateCapacity(date, time, service, Booking, null);
      if (!cap.ok) {
        return res.status(409).json({ success: false, message: cap.reason });
      }

      const booking = await Booking.create({
        firstName, lastName, phone,
        service,
        customService:           customService || "",
        date, time,
        service_duration:        def.service_duration,
        equipment_recovery_time: def.equipment_recovery_time,
        resourcePool:            def.resourcePool,
        customer_quantity:       1,
        tireSize:                tireSize || "",
        doesntKnowTireSize:      doesntKnowTireSize === true || doesntKnowTireSize === "true",
        status:                  "pending",
        deleted:                 false,
      });

      if (req.io) {
        req.io.emit("new_booking", {
          id:                booking._id,
          customer:          booking.customer,
          service:           booking.service,
          customService:     booking.customService,
          date:              booking.date,
          time:              booking.time,
          phone:             booking.phone,
          status:            booking.status,
          resourcePool:      booking.resourcePool,
          tireSize:          booking.tireSize,
          doesntKnowTireSize:booking.doesntKnowTireSize,
        });
      }

      res.status(201).json({
        success: true,
        message: "Booking created successfully.",
        booking: {
          id:       booking._id,
          customer: booking.customer,
          service:  booking.service,
          date:     booking.date,
          time:     booking.time,
          status:   booking.status,
        },
      });
    } catch (err) {
      console.error("POST /api/book:", err);
      if (err.code === 11000) {
        return res.status(409).json({
          success: false,
          message: "That time is no longer available. Please choose another time.",
        });
      }
      res.status(500).json({
        success: false,
        message: "Something went wrong. Please try again or call us directly.",
      });
    }
  }
);

// ── GET /api/bookings — admin ─────────────────────────────────────────────────
// Never returns soft-deleted bookings (use /api/recently-deleted for those)
router.get("/bookings", adminAuth, async (req, res) => {
  try {
    const filter = { deleted: { $ne: true } }; // exclude soft-deleted
    if (req.query.status) filter.status = req.query.status;
    if (req.query.date)   filter.date   = req.query.date;

    const bookings = await Booking.find(filter).sort({ date: 1, time: 1 });

    // Enrich old records where service_duration was saved as schema default (10)
    const enriched = bookings.map(b => {
      const obj = b.toJSON();
      const def = resolveService(b.service);
      const needsEnrich =
        !b.service_duration
        || (b.service_duration === 10 && b.service !== "Tire Purchase")
        || !b.resourcePool
        || (b.resourcePool === "none" && def.resourcePool !== "none");
      if (needsEnrich) {
        obj.service_duration        = def.service_duration;
        obj.equipment_recovery_time = b.equipment_recovery_time !== undefined
          ? b.equipment_recovery_time : def.equipment_recovery_time;
        obj.resourcePool            = def.resourcePool;
      }
      return obj;
    });

    res.json({ success: true, count: enriched.length, bookings: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/recently-deleted — admin ────────────────────────────────────────
// Returns soft-deleted bookings from the last 15 days, newest first.
router.get("/recently-deleted", adminAuth, async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - SOFT_DELETE_DAYS * 24 * 60 * 60 * 1000);
    const bookings = await Booking.find({
      deleted:   true,
      deletedAt: { $gte: cutoff },
    }).sort({ deletedAt: -1 }).lean();

    res.json({ success: true, count: bookings.length, bookings });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/customers — admin ────────────────────────────────────────────────
router.get("/customers", adminAuth, async (req, res) => {
  try {
    const { search } = req.query;
    const query = { deleted: { $ne: true } }; // exclude soft-deleted
    if (search) {
      const re = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      query.$or = [{ firstName: re }, { lastName: re }, { phone: re }];
    }
    const bookings = await Booking.find(query).sort({ createdAt: -1 }).lean();
    const map = {};
    for (const b of bookings) {
      const key = b.phone;
      if (!map[key]) {
        map[key] = {
          phone: b.phone, firstName: b.firstName, lastName: b.lastName,
          visitCount: 0, bookings: [], tireSizes: new Set(), services: new Set(), lastVisit: b.date,
        };
      }
      const c = map[key];
      c.visitCount++;
      c.bookings.push(b);
      c.services.add(b.service);
      if (b.tireSize) c.tireSizes.add(b.tireSize);
      if (b.doesntKnowTireSize && !b.tireSize) c.tireSizes.add("Doesn't know size");
      if (b.date > c.lastVisit) c.lastVisit = b.date;
    }
    const customers = Object.values(map)
      .map(c => ({ ...c, tireSizes: [...c.tireSizes], services: [...c.services] }))
      .sort((a, b) => b.visitCount - a.visitCount);
    res.json({ success: true, count: customers.length, customers });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/live-bay — admin ─────────────────────────────────────────────────
router.get("/live-bay", adminAuth, async (req, res) => {
  try {
    const { DateTime } = require("luxon");
    const { TZ } = require("../config/business");
    const now      = DateTime.now().setZone(TZ);
    const todayStr = now.toISODate();
    const nowMins  = now.hour * 60 + now.minute;

    const todayConfirmed = await Booking.find({
      date:    todayStr,
      status:  "confirmed",
      deleted: { $ne: true }, // exclude soft-deleted
    }).sort({ time: 1 }).lean();

    const active   = [];
    const upcoming = [];

    for (const b of todayConfirmed) {
      if (b.resourcePool === "none") continue;
      const s24 = display12To24(b.time);
      if (!s24) continue;
      const startM = toMinutes(s24);
      const occ    = resolvedOccupation(b);
      const endM   = startM + occ;

      if (nowMins >= startM && nowMins < endM) {
        active.push({ ...b, minutesRemaining: endM - nowMins, _resolvedDuration: occ });
      } else if (startM > nowMins) {
        upcoming.push(b);
      }
    }

    let normalBayCounter = 1;
    const activeBays = active.map(b => {
      if (b.resourcePool === "alignment") return { ...b, assignedBay: "alignment" };
      const bn = b.bayNumber || normalBayCounter++;
      return { ...b, assignedBay: bn };
    });

    res.json({ success: true, active: activeBays, upcoming: upcoming.slice(0, 6), now: now.toISO() });
  } catch (err) {
    console.error("GET /api/live-bay:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── PATCH /api/bookings/:id/bay-snooze ───────────────────────────────────────
router.patch("/bookings/:id/bay-snooze", adminAuth, async (req, res) => {
  try {
    const { DateTime } = require("luxon");
    const { TZ } = require("../config/business");
    const snoozeUntil = DateTime.now().setZone(TZ).plus({ minutes: 10 }).toJSDate();
    const updated = await Booking.findOneAndUpdate(
      { _id: req.params.id, deleted: { $ne: true } },
      { $set: { bayCheckSnoozeUntil: snoozeUntil } },
      { new: true }
    );
    if (!updated) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, booking: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── PATCH /api/bookings/:id — admin ──────────────────────────────────────────
router.patch(
  "/bookings/:id",
  adminAuth,
  [
    param("id").isMongoId(),
    body("status").optional().isIn(["pending","confirmed","waitlist","completed","cancelled"]),
    body("notes").optional().trim().isLength({ max: 1000 }).escape(),
    body("time").optional().trim(),
    body("date").optional().matches(/^\d{4}-\d{2}-\d{2}$/),
    body("sendSMS").optional().isBoolean(),
    body("completedSmsVariant").optional().isIn(["with_review","without_review","none"]),
    body("tireSize").optional().trim().isLength({ max: 50 }).escape(),
    body("doesntKnowTireSize").optional().isBoolean(),
    body("bayNumber").optional().isInt({ min: 1, max: 3 }),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const { id } = req.params;
      const {
        status, notes, time, date, sendSMS: triggerSMS,
        completedSmsVariant, tireSize, doesntKnowTireSize, bayNumber,
      } = req.body;

      if (time || date) {
        const current = await Booking.findOne({ _id: id, deleted: { $ne: true } });
        if (!current) return res.status(404).json({ success: false, message: "Booking not found." });
        const newDate = date || current.date;
        const newTime = time || current.time;
        const cap = await validateCapacity(newDate, newTime, current.service, Booking, id);
        if (!cap.ok) return res.status(409).json({ success: false, message: cap.reason });
      }

      const updates = {};
      if (status    !== undefined) updates.status = status;
      if (notes     !== undefined) updates.notes  = notes;
      if (time      !== undefined) updates.time   = time;
      if (date      !== undefined) updates.date   = date;
      if (tireSize  !== undefined) updates.tireSize = tireSize;
      if (doesntKnowTireSize !== undefined) updates.doesntKnowTireSize = doesntKnowTireSize;
      if (completedSmsVariant !== undefined) updates.completedSmsVariant = completedSmsVariant;
      if (bayNumber !== undefined) updates.bayNumber = bayNumber;
      if (status === "completed") updates.completedAt = new Date();

      const updated = await Booking.findOneAndUpdate(
        { _id: id, deleted: { $ne: true } },
        { $set: updates },
        { new: true, runValidators: true }
      );
      if (!updated) return res.status(404).json({ success: false, message: "Booking not found." });

      // Auto-SMS
      let smsSent = false;
      if (status && triggerSMS !== false) {
        let msg = null;
        if (status === "confirmed") msg = sms.confirmed(updated);
        if (status === "cancelled") msg = sms.declined(updated);
        if (status === "completed") {
          if (completedSmsVariant === "with_review")         msg = sms.completed_review(updated);
          else if (completedSmsVariant === "without_review") msg = sms.completed_no_review(updated);
        }
        if (msg) {
          try {
            await sendTwilioSMS(updated.phone, msg);
            await Booking.findByIdAndUpdate(id, { $set: { smsSentAt: new Date() } });
            smsSent = true;
            console.log(`[SMS] Sent (${status}/${completedSmsVariant||""}) to ${updated.phone}`);
          } catch (smsErr) {
            console.error("[SMS] Failed:", smsErr.message);
          }
        }
      }

      if (req.io) req.io.emit("booking_updated", { id, booking: updated });
      res.json({ success: true, booking: updated, smsSent });
    } catch (err) {
      console.error("PATCH /api/bookings/:id:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ── DELETE /api/bookings/:id — soft delete ────────────────────────────────────
// Does NOT permanently remove. Sets deleted=true and deletedAt=now.
// Booking moves to Recently Deleted section and auto-purges after 15 days.
router.delete(
  "/bookings/:id",
  adminAuth,
  [param("id").isMongoId()],
  handleValidation,
  async (req, res) => {
    try {
      const updated = await Booking.findOneAndUpdate(
        { _id: req.params.id, deleted: { $ne: true } },
        { $set: { deleted: true, deletedAt: new Date() } },
        { new: true }
      );
      if (!updated) return res.status(404).json({ success: false, message: "Not found" });

      if (req.io) req.io.emit("booking_deleted", { id: req.params.id });
      res.json({ success: true, message: "Booking moved to Recently Deleted." });
    } catch (err) {
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ── PATCH /api/bookings/:id/restore — restore from trash ─────────────────────
router.patch(
  "/bookings/:id/restore",
  adminAuth,
  [param("id").isMongoId()],
  handleValidation,
  async (req, res) => {
    try {
      const updated = await Booking.findOneAndUpdate(
        { _id: req.params.id, deleted: true },
        { $set: { deleted: false, deletedAt: null } },
        { new: true }
      );
      if (!updated) return res.status(404).json({ success: false, message: "Not found or not deleted." });

      if (req.io) req.io.emit("booking_restored", { id: req.params.id, booking: updated });
      res.json({ success: true, message: "Booking restored.", booking: updated });
    } catch (err) {
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ── POST /api/bookings/:id/sms — manual ──────────────────────────────────────
router.post(
  "/bookings/:id/sms",
  adminAuth,
  [
    param("id").isMongoId(),
    body("messageType").isIn(["confirmed","declined","waitlist","reminder","completed_review","completed_no_review"]),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const booking = await Booking.findOne({ _id: req.params.id, deleted: { $ne: true } });
      if (!booking) return res.status(404).json({ success: false, message: "Not found" });
      if (!process.env.TWILIO_ACCOUNT_SID)
        return res.status(503).json({ success: false, message: "Twilio not configured." });
      const fn = sms[req.body.messageType];
      if (!fn) return res.status(400).json({ success: false, message: "Invalid message type." });
      const msg     = fn(booking);
      const message = await sendTwilioSMS(booking.phone, msg);
      await Booking.findByIdAndUpdate(req.params.id, { $set: { smsSentAt: new Date() } });
      res.json({ success: true, message: `SMS sent to ${booking.phone}`, sid: message?.sid });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || "SMS failed" });
    }
  }
);

// ── GET /api/queue — public ───────────────────────────────────────────────────
router.get("/queue", async (req, res) => {
  try {
    const { date, bookingId } = req.query;
    if (!date || !bookingId)
      return res.status(400).json({ success: false, message: "date and bookingId required" });
    const active = await Booking.find(
      { date, status: { $in: ["pending","confirmed","waitlist"] }, deleted: { $ne: true } },
      { time: 1, _id: 1 }
    ).sort({ time: 1 });
    const idx = active.findIndex(b => b._id.toString() === bookingId);
    if (idx === -1) return res.json({ success: true, position: 0, waitMinutes: 0, message: "You are next!" });
    res.json({
      success: true, position: idx, waitMinutes: idx * 40, totalInQueue: active.length,
      message: idx === 0 ? "You are next!" : `${idx} customer${idx>1?"s":""} ahead — est. wait: ${idx*40} min`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── Cleanup: permanently purge bookings deleted > 15 days ago ─────────────────
async function purgeOldDeletedBookings() {
  try {
    const cutoff = new Date(Date.now() - SOFT_DELETE_DAYS * 24 * 60 * 60 * 1000);
    const result = await Booking.deleteMany({
      deleted:   true,
      deletedAt: { $lt: cutoff },
    });
    if (result.deletedCount > 0) {
      console.log(`[Cleanup] Purged ${result.deletedCount} bookings deleted > ${SOFT_DELETE_DAYS} days ago`);
    }
  } catch (err) {
    console.error("[Cleanup] Error:", err.message);
  }
}

// Export cleanup so index.js can call it on startup + schedule it
module.exports = router;
module.exports.purgeOldDeletedBookings = purgeOldDeletedBookings;
