// ─────────────────────────────────────────────────────────────────────────────
// routes/bookings.js  v7
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
  resolveService, effectiveOccupation,
  computeAvailability, validateCapacity, getHoursForDate,
  display12To24, toMinutes,
} = require("../config/business");

// ── Google review link ────────────────────────────────────────────────────────
const GOOGLE_REVIEW = "https://g.page/r/CYPKn0GrR0t3EBM/review";

// ── Twilio helper ─────────────────────────────────────────────────────────────
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

// ── SMS templates ─────────────────────────────────────────────────────────────
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

  // FIXED: review link at the very bottom, preceded by required sentence
  completed_review: (b) =>
    `Thanks for visiting Roadstar Tire, ${b.firstName}! We hope you love your ${svcLabel(b)}. Drive safe!\n\nClick the link to leave us a review\n${GOOGLE_REVIEW}`,

  completed_no_review: (b) =>
    `Thanks for visiting Roadstar Tire, ${b.firstName}! We hope you love your ${svcLabel(b)}. Drive safe! — Roadstar Tire`,
};

// ── GET /api/business-hours ───────────────────────────────────────────────────
router.get("/business-hours", (_req, res) => {
  res.json({
    success:     true,
    hours:       HOURS,
    services:    ALL_SERVICES,
    serviceDefs: SERVICE_DEFS,
    resourcePools: RESOURCE_POOLS,
  });
});

// ── GET /api/availability ─────────────────────────────────────────────────────
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

// ── POST /api/book ────────────────────────────────────────────────────────────
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
      .custom(val => { if (!getHoursForDate(val)) throw new Error("Roadstar Tire is closed on this day."); return true; }),
    body("time").trim().notEmpty().withMessage("Please select a time slot."),
    body("tireSize").optional().trim().isLength({ max: 50 }).escape(),
    body("doesntKnowTireSize").optional().isBoolean(),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const { firstName, lastName, phone, service, customService, date, time, tireSize, doesntKnowTireSize } = req.body;

      const def = resolveService(service);
      const occ = effectiveOccupation(def);

      // Server-side capacity re-validation (race-condition guard)
      const cap = await validateCapacity(date, time, service, Booking, null);
      if (!cap.ok) {
        // Clean user-facing message — never raw errors
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
        status: "pending",
      });

      if (req.io) {
        req.io.emit("new_booking", {
          id: booking._id, customer: booking.customer,
          service: booking.service, customService: booking.customService,
          date: booking.date, time: booking.time,
          phone: booking.phone, status: booking.status,
          resourcePool: booking.resourcePool,
          tireSize: booking.tireSize, doesntKnowTireSize: booking.doesntKnowTireSize,
        });
      }

      res.status(201).json({
        success: true,
        message: "Booking created successfully.",
        booking: { id: booking._id, customer: booking.customer, service: booking.service, date: booking.date, time: booking.time, status: booking.status },
      });
    } catch (err) {
      console.error("POST /api/book:", err);
      // Never expose raw errors to customers
      res.status(500).json({ success: false, message: "Something went wrong. Please try again or call us directly." });
    }
  }
);

// ── GET /api/bookings — admin ─────────────────────────────────────────────────
router.get("/bookings", adminAuth, async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.date)   filter.date   = req.query.date;
    const bookings = await Booking.find(filter).sort({ date: 1, time: 1 });
    res.json({ success: true, count: bookings.length, bookings });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/customers — admin ────────────────────────────────────────────────
router.get("/customers", adminAuth, async (req, res) => {
  try {
    const { search } = req.query;
    const query = {};
    if (search) {
      const re = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      query.$or = [{ firstName: re }, { lastName: re }, { phone: re }];
    }
    const bookings = await Booking.find(query).sort({ createdAt: -1 }).lean();
    const map = {};
    for (const b of bookings) {
      const key = b.phone;
      if (!map[key]) map[key] = { phone: b.phone, firstName: b.firstName, lastName: b.lastName, visitCount: 0, bookings: [], tireSizes: new Set(), services: new Set(), lastVisit: b.date };
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
      date: todayStr, status: "confirmed",
    }).sort({ time: 1 }).lean();

    const active = [];
    const upcoming = [];

    for (const b of todayConfirmed) {
      if (b.resourcePool === "none") continue;
      const s24 = display12To24(b.time);
      if (!s24) continue;
      const startM = toMinutes(s24);
      const occ    = (b.service_duration || 10) + (b.equipment_recovery_time || 0);
      const endM   = startM + occ;

      if (nowMins >= startM && nowMins < endM) {
        active.push({ ...b, minutesRemaining: endM - nowMins });
      } else if (startM > nowMins) {
        upcoming.push(b);
      }
    }

    // Assign bay numbers chronologically (stable sort by time)
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

// ── PATCH /api/bookings/:id/bay-snooze — admin ────────────────────────────────
router.patch("/bookings/:id/bay-snooze", adminAuth, async (req, res) => {
  try {
    const { DateTime } = require("luxon");
    const { TZ } = require("../config/business");
    const snoozeUntil = DateTime.now().setZone(TZ).plus({ minutes: 10 }).toJSDate();
    const updated = await Booking.findByIdAndUpdate(
      req.params.id,
      { $set: { bayCheckSnoozeUntil: snoozeUntil } },
      { new: true }
    );
    if (!updated) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, booking: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── PATCH /api/bookings/:id — admin ───────────────────────────────────────────
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
    body("notes").optional().trim().isLength({ max: 1000 }).escape(),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status, notes, time, date, sendSMS: triggerSMS, completedSmsVariant, tireSize, doesntKnowTireSize, bayNumber } = req.body;

      // Capacity check when rescheduling
      if (time || date) {
        const current = await Booking.findById(id);
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

      const updated = await Booking.findByIdAndUpdate(id, { $set: updates }, { new: true, runValidators: true });
      if (!updated) return res.status(404).json({ success: false, message: "Booking not found." });

      // ── Auto-SMS ─────────────────────────────────────────────────────────────
      let smsSent = false;
      if (status && triggerSMS !== false) {
        let msg = null;
        if (status === "confirmed") msg = sms.confirmed(updated);
        if (status === "cancelled") msg = sms.declined(updated);

        // FIXED: completedSmsVariant mapping — covers both "with_review" and "without_review"
        if (status === "completed") {
          if (completedSmsVariant === "with_review")    msg = sms.completed_review(updated);
          else if (completedSmsVariant === "without_review") msg = sms.completed_no_review(updated);
          // "none" → no SMS, intentional
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

// ── DELETE /api/bookings/:id — admin ──────────────────────────────────────────
router.delete(
  "/bookings/:id",
  adminAuth,
  [param("id").isMongoId()],
  handleValidation,
  async (req, res) => {
    try {
      const deleted = await Booking.findByIdAndDelete(req.params.id);
      if (!deleted) return res.status(404).json({ success: false, message: "Not found" });
      if (req.io) req.io.emit("booking_deleted", { id: req.params.id });
      res.json({ success: true, message: "Booking deleted" });
    } catch (err) {
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ── POST /api/bookings/:id/sms — admin (manual) ───────────────────────────────
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
      const booking = await Booking.findById(req.params.id);
      if (!booking) return res.status(404).json({ success: false, message: "Not found" });
      if (!process.env.TWILIO_ACCOUNT_SID)
        return res.status(503).json({ success: false, message: "Twilio not configured." });

      const fn = sms[req.body.messageType];
      if (!fn) return res.status(400).json({ success: false, message: "Invalid message type." });

      const msg     = fn(booking);
      const message = await sendTwilioSMS(booking.phone, msg);
      await Booking.findByIdAndUpdate(req.params.id, { $set: { smsSentAt: new Date() } });
      console.log(`[SMS] Manual (${req.body.messageType}) → ${booking.phone} SID:${message?.sid}`);
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
      { date, status: { $in: ["pending","confirmed","waitlist"] } },
      { time: 1, _id: 1 }
    ).sort({ time: 1 });
    const idx = active.findIndex(b => b._id.toString() === bookingId);
    if (idx === -1) return res.json({ success: true, position: 0, waitMinutes: 0, message: "You are next!" });
    const waitMinutes = idx * 40;
    res.json({ success: true, position: idx, waitMinutes, totalInQueue: active.length,
      message: idx === 0 ? "You are next!" : `${idx} customer${idx>1?"s":""} ahead — est. wait: ${waitMinutes} min` });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
