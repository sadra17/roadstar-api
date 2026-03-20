const express = require("express");
const { body, query, param } = require("express-validator");
const router  = express.Router();

const Booking  = require("../models/Booking");
const adminAuth = require("../middleware/adminAuth");
const { handleValidation } = require("../middleware/validate");
const { ALL_SLOTS, toMinutes } = require("../config/slots");

const getDuration = (s) => s === "Tire Change + Installation" ? 40 : 10;

// ── Twilio helper ─────────────────────────────────────────────────────────────
const sendTwilioSMS = async (to, body) => {
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
};

const smsTemplates = {
  confirmed: (b) => `Hi ${b.firstName}! Your Roadstar Tire appointment is CONFIRMED for ${b.date} at ${b.time} (${b.service}). See you soon! — Roadstar Tire`,
  declined:  (b) => `Hi ${b.firstName}, we had to cancel your ${b.time} appointment on ${b.date}. Please call to reschedule. — Roadstar Tire`,
  waitlist:  (b) => `Hi ${b.firstName}! A spot just opened at Roadstar Tire on ${b.date}. Call us to claim it! — Roadstar Tire`,
  reminder:  (b) => `Reminder: Hi ${b.firstName}, your Roadstar Tire appointment is TODAY at ${b.time} (${b.service}). — Roadstar Tire`,
  completed: (b) => `Thanks for visiting Roadstar Tire, ${b.firstName}! Your ${b.service} is done. Drive safe! — Roadstar Tire`,
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/book  — public: create booking
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/book",
  [
    body("firstName").trim().notEmpty().withMessage("First name required").isLength({ max: 60 }).escape(),
    body("lastName").trim().notEmpty().withMessage("Last name required").isLength({ max: 60 }).escape(),
    body("phone").trim().notEmpty().matches(/^[\d\s\-\(\)\+]{7,20}$/).withMessage("Invalid phone"),
    body("service").isIn(["Tire Change", "Tire Purchase", "Tire Change + Installation"]).withMessage("Invalid service"),
    body("customService").optional().trim().isLength({ max: 200 }).escape(),
    body("date").trim().matches(/^\d{4}-\d{2}-\d{2}$/).withMessage("Date must be YYYY-MM-DD")
      .custom(val => {
        const d = new Date(val), today = new Date();
        today.setHours(0,0,0,0);
        if (isNaN(d.getTime())) throw new Error("Invalid date");
        if (d < today) throw new Error("Cannot book a past date");
        return true;
      }),
    body("time").isIn(ALL_SLOTS).withMessage("Invalid time slot"),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const { firstName, lastName, phone, service, customService, date, time } = req.body;

      const conflict = await Booking.findOne({ date, time });
      if (conflict) {
        return res.status(409).json({ success: false, message: "That time slot is already booked. Please choose another." });
      }

      const booking = await Booking.create({
        firstName, lastName, phone, service,
        customService: customService || "",
        date, time,
        duration: getDuration(service),
        status: "pending",
      });

      // ── Emit Socket.io event so dashboard updates instantly ──────────────
      if (req.io) {
        req.io.emit("new_booking", {
          id:       booking._id,
          customer: booking.customer,
          service:  booking.service,
          date:     booking.date,
          time:     booking.time,
          phone:    booking.phone,
          status:   booking.status,
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
      if (err.code === 11000) {
        return res.status(409).json({ success: false, message: "That slot was just taken. Please choose another." });
      }
      console.error("POST /api/book:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/availability?date=YYYY-MM-DD  — public
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/availability",
  [query("date").trim().matches(/^\d{4}-\d{2}-\d{2}$/).withMessage("date must be YYYY-MM-DD")],
  handleValidation,
  async (req, res) => {
    try {
      const { date } = req.query;
      const booked = await Booking.find(
        { date, status: { $nin: ["cancelled"] } },
        { time: 1, _id: 0 }
      );
      const bookedTimes = new Set(booked.map(b => b.time));

      const now = new Date();
      const isToday = date === now.toISOString().slice(0, 10);
      const currentMinutes = isToday ? now.getHours() * 60 + now.getMinutes() : -1;

      const available = ALL_SLOTS.filter(slot => {
        if (bookedTimes.has(slot)) return false;
        if (isToday && toMinutes(slot) <= currentMinutes) return false;
        return true;
      });

      res.json({ success: true, date, available, booked: [...bookedTimes] });
    } catch (err) {
      console.error("GET /api/availability:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/queue?date=YYYY-MM-DD  — public: queue position + wait time
// ─────────────────────────────────────────────────────────────────────────────
router.get("/queue", async (req, res) => {
  try {
    const { date, bookingId } = req.query;
    if (!date || !bookingId) {
      return res.status(400).json({ success: false, message: "date and bookingId required" });
    }

    // Get all active bookings for that date, sorted by time
    const activeBookings = await Booking.find({
      date,
      status: { $in: ["pending", "confirmed", "waitlist"] },
    }).sort({ time: 1 });

    const myIndex = activeBookings.findIndex(b => b._id.toString() === bookingId);
    if (myIndex === -1) {
      return res.json({ success: true, position: 0, waitMinutes: 0, message: "Booking not found in queue" });
    }

    const position    = myIndex; // 0 = you're next
    const waitMinutes = position * 40; // 40 min avg per service

    res.json({
      success: true,
      position,
      waitMinutes,
      totalInQueue: activeBookings.length,
      message: position === 0
        ? "You are next!"
        : `${position} customer${position > 1 ? "s" : ""} ahead of you. Est. wait: ${waitMinutes} min`,
    });
  } catch (err) {
    console.error("GET /api/queue:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/bookings  — admin only
// ─────────────────────────────────────────────────────────────────────────────
router.get("/bookings", adminAuth, async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.date)   filter.date   = req.query.date;

    const bookings = await Booking.find(filter).sort({ date: 1, time: 1 });
    res.json({ success: true, count: bookings.length, bookings });
  } catch (err) {
    console.error("GET /api/bookings:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/bookings/:id  — admin only: update status, notes, reschedule
// Auto-sends SMS when status changes to confirmed, declined, completed
// ─────────────────────────────────────────────────────────────────────────────
router.patch(
  "/bookings/:id",
  adminAuth,
  [
    param("id").isMongoId().withMessage("Invalid ID"),
    body("status").optional().isIn(["pending", "confirmed", "waitlist", "completed", "cancelled"]),
    body("notes").optional().trim().isLength({ max: 500 }).escape(),
    body("time").optional().isIn(ALL_SLOTS),
    body("date").optional().matches(/^\d{4}-\d{2}-\d{2}$/),
    body("sendSMS").optional().isBoolean(),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status, notes, time, date, sendSMS: triggerSMS } = req.body;

      // Check slot conflict if rescheduling
      if (time || date) {
        const current = await Booking.findById(id);
        if (!current) return res.status(404).json({ success: false, message: "Not found" });

        const conflict = await Booking.findOne({
          date: date || current.date,
          time: time || current.time,
          _id:  { $ne: id },
          status: { $nin: ["cancelled"] },
        });
        if (conflict) {
          return res.status(409).json({ success: false, message: "That slot is already taken." });
        }
      }

      const updates = {};
      if (status !== undefined) updates.status = status;
      if (notes  !== undefined) updates.notes  = notes;
      if (time   !== undefined) updates.time   = time;
      if (date   !== undefined) updates.date   = date;
      if (status === "completed") updates.completedAt = new Date();

      const updated = await Booking.findByIdAndUpdate(
        id, { $set: updates }, { new: true, runValidators: true }
      );
      if (!updated) return res.status(404).json({ success: false, message: "Not found" });

      // ── Auto-SMS on status change ─────────────────────────────────────────
      let smsSent = false;
      const autoSmsStatuses = ["confirmed", "completed", "cancelled"];
      if (
        status &&
        autoSmsStatuses.includes(status) &&
        triggerSMS !== false   // allow caller to suppress with sendSMS: false
      ) {
        try {
          const msgKey = status === "cancelled" ? "declined" : status;
          const msg    = smsTemplates[msgKey]?.(updated);
          if (msg) {
            await sendTwilioSMS(updated.phone, msg);
            await Booking.findByIdAndUpdate(id, { $set: { smsSentAt: new Date() } });
            smsSent = true;
            console.log(`[SMS] Auto-sent (${status}) to ${updated.phone}`);
          }
        } catch (smsErr) {
          console.error("[SMS] Auto-send failed:", smsErr.message);
          // Don't fail the whole request if SMS fails
        }
      }

      // ── Emit socket event so dashboard updates in real-time ───────────────
      if (req.io) {
        req.io.emit("booking_updated", { id, updates, booking: updated });
      }

      res.json({ success: true, booking: updated, smsSent });
    } catch (err) {
      console.error("PATCH /api/bookings/:id:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/bookings/:id  — admin only
// ─────────────────────────────────────────────────────────────────────────────
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
      console.error("DELETE /api/bookings/:id:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/bookings/:id/sms  — admin only: manual SMS send
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/bookings/:id/sms",
  adminAuth,
  [
    param("id").isMongoId(),
    body("messageType").isIn(["confirmed", "declined", "waitlist", "reminder", "completed"]),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const booking = await Booking.findById(req.params.id);
      if (!booking) return res.status(404).json({ success: false, message: "Not found" });

      if (!process.env.TWILIO_ACCOUNT_SID) {
        return res.status(503).json({
          success: false,
          message: "Twilio not configured. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER to env vars.",
        });
      }

      const msg = smsTemplates[req.body.messageType]?.(booking);
      if (!msg) return res.status(400).json({ success: false, message: "Invalid message type" });

      const message = await sendTwilioSMS(booking.phone, msg);
      await Booking.findByIdAndUpdate(req.params.id, { $set: { smsSentAt: new Date() } });

      console.log(`[SMS] Manual sent to ${booking.phone} — SID: ${message?.sid}`);
      res.json({ success: true, message: `SMS sent to ${booking.phone}`, sid: message?.sid });
    } catch (err) {
      console.error("[SMS] Error:", err.message);
      res.status(500).json({ success: false, message: err.message || "SMS failed" });
    }
  }
);

module.exports = router;
