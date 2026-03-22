// ─────────────────────────────────────────────────────────────────────────────
// routes/bookings.js  v5
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const express = require("express");
const { body, query, param } = require("express-validator");
const router  = express.Router();

const Booking   = require("../models/Booking");
const adminAuth = require("../middleware/adminAuth");
const { handleValidation } = require("../middleware/validate");
const {
  ALL_SERVICES,
  SERVICE_DEFS,
  HOURS,
  resolveService,
  computeAvailability,
  validateCapacity,
  getHoursForDate,
} = require("../config/business");

// Google review link (short — keep under 160 chars with rest of message)
const GOOGLE_REVIEW =
  "https://g.page/r/CYPKn0GrR0t3EBM/review";

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
  return client.messages.create({
    body,
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
  });
}

// ── SMS templates ─────────────────────────────────────────────────────────────
const sms = {
  confirmed: (b) =>
    `Hi ${b.firstName}! Your Roadstar Tire appt is CONFIRMED for ${b.date} at ${b.time} (${b.service}). See you soon! — Roadstar Tire`,

  declined: (b) =>
    `Hi ${b.firstName}, we had to cancel your ${b.time} appt on ${b.date}. Please call us to reschedule. — Roadstar Tire`,

  waitlist: (b) =>
    `Hi ${b.firstName}! A spot just opened at Roadstar Tire on ${b.date}. Call us to claim it! — Roadstar Tire`,

  reminder: (b) =>
    `Hi ${b.firstName}, reminder: your Roadstar Tire appt is TODAY at ${b.time} for ${b.service}. See you soon! — Roadstar Tire`,

  // completed WITH review link
  completed_review: (b) =>
    `Thanks for visiting Roadstar Tire, ${b.firstName}! We hope you love your ${b.service}. ` +
    `A quick Google review means the world to us: ${GOOGLE_REVIEW} — Roadstar Tire`,

  // completed WITHOUT review link
  completed_no_review: (b) =>
    `Thanks for visiting Roadstar Tire, ${b.firstName}! We hope you love your ${b.service}. Drive safe! — Roadstar Tire`,
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/business-hours
// Returns the weekly schedule and full service catalog.
// Used by Shopify booking form to render service cards and calendar.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/business-hours", (_req, res) => {
  res.json({
    success:     true,
    hours:       HOURS,
    services:    ALL_SERVICES,
    serviceDefs: SERVICE_DEFS,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/availability?date=YYYY-MM-DD&service=...
// Returns available 12h display slots for a given date + service.
// Capacity-aware: respects jack count and overlapping durations.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/availability",
  [
    query("date")
      .trim()
      .matches(/^\d{4}-\d{2}-\d{2}$/)
      .withMessage("date must be YYYY-MM-DD"),
    query("service").optional().trim(),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const { date, service = "Tire Change" } = req.query;
      const result = await computeAvailability(date, service, Booking);
      res.json({
        success: true,
        date,
        available:     result.available,
        businessHours: result.businessHours,
        duration:      result.duration,
        usesJack:      result.usesJack,
      });
    } catch (err) {
      console.error("GET /api/availability:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/queue
// ─────────────────────────────────────────────────────────────────────────────
router.get("/queue", async (req, res) => {
  try {
    const { date, bookingId } = req.query;
    if (!date || !bookingId)
      return res.status(400).json({ success: false, message: "date and bookingId required" });

    const active = await Booking.find(
      { date, status: { $in: ["pending", "confirmed", "waitlist"] } },
      { time: 1, _id: 1 }
    ).sort({ time: 1 });

    const myIndex = active.findIndex((b) => b._id.toString() === bookingId);
    if (myIndex === -1)
      return res.json({ success: true, position: 0, waitMinutes: 0, message: "You are next!" });

    const waitMinutes = myIndex * 40;
    res.json({
      success:      true,
      position:     myIndex,
      waitMinutes,
      totalInQueue: active.length,
      message:
        myIndex === 0
          ? "You are next!"
          : `${myIndex} customer${myIndex > 1 ? "s" : ""} ahead · Est. wait: ${waitMinutes} min`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/book  — public
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/book",
  [
    body("firstName")
      .trim().notEmpty().withMessage("First name required")
      .isLength({ max: 60 }).escape(),
    body("lastName")
      .trim().notEmpty().withMessage("Last name required")
      .isLength({ max: 60 }).escape(),
    body("phone")
      .trim().notEmpty()
      .matches(/^[\d\s\-\(\)\+]{7,20}$/).withMessage("Invalid phone number"),
    body("service")
      .isIn(ALL_SERVICES).withMessage("Invalid service"),
    body("customService").optional().trim().isLength({ max: 300 }).escape(),
    body("date")
      .trim()
      .matches(/^\d{4}-\d{2}-\d{2}$/).withMessage("Date must be YYYY-MM-DD")
      .custom((val) => {
        if (!getHoursForDate(val))
          throw new Error("Roadstar Tire is closed on this day.");
        return true;
      }),
    body("time").trim().notEmpty().withMessage("Time slot required"),
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

      const { duration, usesJack } = resolveService(service);

      // Server-side capacity re-validation (prevents race-condition overbooking)
      const cap = await validateCapacity(date, time, service, Booking, null);
      if (!cap.ok) {
        return res.status(409).json({ success: false, message: cap.reason });
      }

      const booking = await Booking.create({
        firstName, lastName, phone,
        service,
        customService: customService || "",
        date, time, duration, usesJack,
        tireSize:           tireSize || "",
        doesntKnowTireSize: doesntKnowTireSize === true || doesntKnowTireSize === "true",
        status: "pending",
      });

      // Emit Socket.io event
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
          tireSize:          booking.tireSize,
          doesntKnowTireSize: booking.doesntKnowTireSize,
        });
      }

      res.status(201).json({
        success: true,
        message: "Booking created",
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
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/bookings  — admin
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/customers  — admin: grouped customer history
// ─────────────────────────────────────────────────────────────────────────────
router.get("/customers", adminAuth, async (req, res) => {
  try {
    const { search } = req.query;
    const query = {};

    if (search) {
      const re = new RegExp(
        search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i"
      );
      query.$or = [{ firstName: re }, { lastName: re }, { phone: re }];
    }

    const bookings = await Booking.find(query)
      .sort({ createdAt: -1 })
      .lean();

    // Group by phone → customer profile
    const map = {};
    for (const b of bookings) {
      const key = b.phone;
      if (!map[key]) {
        map[key] = {
          phone:       b.phone,
          firstName:   b.firstName,
          lastName:    b.lastName,
          visitCount:  0,
          bookings:    [],
          tireSizes:   new Set(),
          services:    new Set(),
          lastVisit:   b.date,
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
      .map((c) => ({
        ...c,
        tireSizes: [...c.tireSizes],
        services:  [...c.services],
      }))
      .sort((a, b) => b.visitCount - a.visitCount);

    res.json({ success: true, count: customers.length, customers });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/bookings/:id  — admin
// ─────────────────────────────────────────────────────────────────────────────
router.patch(
  "/bookings/:id",
  adminAuth,
  [
    param("id").isMongoId(),
    body("status")
      .optional()
      .isIn(["pending", "confirmed", "waitlist", "completed", "cancelled"]),
    body("notes").optional().trim().isLength({ max: 1000 }).escape(),
    body("time").optional().trim(),
    body("date").optional().matches(/^\d{4}-\d{2}-\d{2}$/),
    body("sendSMS").optional().isBoolean(),
    body("completedSmsVariant")
      .optional()
      .isIn(["with_review", "without_review", "none"]),
    body("tireSize").optional().trim().isLength({ max: 50 }).escape(),
    body("doesntKnowTireSize").optional().isBoolean(),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const { id } = req.params;
      const {
        status,
        notes,
        time,
        date,
        sendSMS: triggerSMS,
        completedSmsVariant,
        tireSize,
        doesntKnowTireSize,
      } = req.body;

      // Validate capacity if rescheduling
      if (time || date) {
        const current = await Booking.findById(id);
        if (!current)
          return res.status(404).json({ success: false, message: "Booking not found" });

        const newDate = date || current.date;
        const newTime = time || current.time;
        const cap = await validateCapacity(newDate, newTime, current.service, Booking, id);
        if (!cap.ok)
          return res.status(409).json({ success: false, message: cap.reason });
      }

      const updates = {};
      if (status    !== undefined) updates.status = status;
      if (notes     !== undefined) updates.notes  = notes;
      if (time      !== undefined) updates.time   = time;
      if (date      !== undefined) updates.date   = date;
      if (tireSize  !== undefined) updates.tireSize = tireSize;
      if (doesntKnowTireSize !== undefined)
        updates.doesntKnowTireSize = doesntKnowTireSize;
      if (completedSmsVariant !== undefined)
        updates.completedSmsVariant = completedSmsVariant;
      if (status === "completed") updates.completedAt = new Date();

      const updated = await Booking.findByIdAndUpdate(
        id,
        { $set: updates },
        { new: true, runValidators: true }
      );
      if (!updated)
        return res.status(404).json({ success: false, message: "Booking not found" });

      // ── Auto-SMS ─────────────────────────────────────────────────────────
      let smsSent = false;
      if (status && triggerSMS !== false) {
        let msg = null;

        if (status === "confirmed") msg = sms.confirmed(updated);
        if (status === "cancelled") msg = sms.declined(updated);

        if (status === "completed") {
          if (completedSmsVariant === "with_review")
            msg = sms.completed_review(updated);
          else if (completedSmsVariant === "without_review")
            msg = sms.completed_no_review(updated);
          // "none" → no SMS, intentional
        }

        if (msg) {
          try {
            await sendTwilioSMS(updated.phone, msg);
            await Booking.findByIdAndUpdate(id, { $set: { smsSentAt: new Date() } });
            smsSent = true;
          } catch (smsErr) {
            console.error("[SMS] Auto-send failed:", smsErr.message);
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

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/bookings/:id  — admin
// ─────────────────────────────────────────────────────────────────────────────
router.delete(
  "/bookings/:id",
  adminAuth,
  [param("id").isMongoId()],
  handleValidation,
  async (req, res) => {
    try {
      const deleted = await Booking.findByIdAndDelete(req.params.id);
      if (!deleted)
        return res.status(404).json({ success: false, message: "Booking not found" });
      if (req.io) req.io.emit("booking_deleted", { id: req.params.id });
      res.json({ success: true, message: "Booking deleted" });
    } catch (err) {
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/bookings/:id/sms  — admin: manual SMS
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/bookings/:id/sms",
  adminAuth,
  [
    param("id").isMongoId(),
    body("messageType").isIn([
      "confirmed", "declined", "waitlist", "reminder",
      "completed_review", "completed_no_review",
    ]),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const booking = await Booking.findById(req.params.id);
      if (!booking)
        return res.status(404).json({ success: false, message: "Not found" });

      if (!process.env.TWILIO_ACCOUNT_SID)
        return res.status(503).json({ success: false, message: "Twilio not configured" });

      const fn  = sms[req.body.messageType];
      if (!fn)
        return res.status(400).json({ success: false, message: "Invalid message type" });

      const msg     = fn(booking);
      const message = await sendTwilioSMS(booking.phone, msg);
      await Booking.findByIdAndUpdate(req.params.id, { $set: { smsSentAt: new Date() } });

      res.json({ success: true, message: `SMS sent to ${booking.phone}`, sid: message?.sid });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message || "SMS failed" });
    }
  }
);

module.exports = router;
