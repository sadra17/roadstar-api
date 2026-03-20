const express = require("express");
const { body, query, param } = require("express-validator");
const router = express.Router();

const Booking        = require("../models/Booking");
const adminAuth      = require("../middleware/adminAuth");
const { handleValidation } = require("../middleware/validate");
const { ALL_SLOTS, toMinutes } = require("../config/slots");

const getDuration = (s) => s === "Tire Change + Installation" ? 40 : 10;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/book  — create a new booking
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/book",
  [
    body("firstName").trim().notEmpty().withMessage("First name required").isLength({ max: 60 }).escape(),
    body("lastName").trim().notEmpty().withMessage("Last name required").isLength({ max: 60 }).escape(),
    body("phone").trim().notEmpty().withMessage("Phone required").matches(/^[\d\s\-\(\)\+]{7,20}$/).withMessage("Invalid phone"),
    body("service").trim().notEmpty().isIn(["Tire Change", "Tire Purchase", "Tire Change + Installation"]).withMessage("Invalid service"),
    body("customService").optional().trim().isLength({ max: 200 }).escape(),
    body("date").trim().notEmpty().matches(/^\d{4}-\d{2}-\d{2}$/).withMessage("Date must be YYYY-MM-DD")
      .custom((val) => {
        const d = new Date(val);
        const today = new Date(); today.setHours(0, 0, 0, 0);
        if (isNaN(d.getTime())) throw new Error("Invalid date");
        if (d < today) throw new Error("Cannot book a past date");
        return true;
      }),
    body("time").trim().notEmpty().isIn(ALL_SLOTS).withMessage("Invalid time slot"),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const { firstName, lastName, phone, service, customService, date, time } = req.body;

      const conflict = await Booking.findOne({ date, time });
      if (conflict) {
        return res.status(409).json({
          success: false,
          message: "That time slot is already booked. Please choose another.",
        });
      }

      const booking = await Booking.create({
        firstName, lastName, phone, service,
        customService: customService || "",
        date, time,
        duration: getDuration(service),
        status: "pending",
      });

      res.status(201).json({
        success: true,
        message: "Booking created",
        booking: {
          id: booking._id,
          customer: booking.customer,
          service: booking.service,
          date: booking.date,
          time: booking.time,
          status: booking.status,
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
// GET /api/availability?date=YYYY-MM-DD  — available time slots
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/availability",
  [
    query("date").trim().notEmpty().matches(/^\d{4}-\d{2}-\d{2}$/).withMessage("date must be YYYY-MM-DD"),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const { date } = req.query;

      const booked = await Booking.find(
        { date, status: { $nin: ["cancelled"] } },
        { time: 1, _id: 0 }
      );
      const bookedTimes = new Set(booked.map((b) => b.time));

      const now = new Date();
      const isToday = date === now.toISOString().slice(0, 10);
      const currentMinutes = isToday ? now.getHours() * 60 + now.getMinutes() : -1;

      const available = ALL_SLOTS.filter((slot) => {
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
// GET /api/bookings  — all bookings (admin only)
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
// PATCH /api/bookings/:id  — update status / reschedule / notes (admin only)
// ─────────────────────────────────────────────────────────────────────────────
router.patch(
  "/bookings/:id",
  adminAuth,
  [
    param("id").isMongoId().withMessage("Invalid ID"),
    body("status").optional().isIn(["pending", "confirmed", "waitlist", "cancelled"]),
    body("notes").optional().trim().isLength({ max: 500 }).escape(),
    body("time").optional().isIn(ALL_SLOTS),
    body("date").optional().matches(/^\d{4}-\d{2}-\d{2}$/),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status, notes, time, date } = req.body;

      if (time || date) {
        const booking = await Booking.findById(id);
        if (!booking) return res.status(404).json({ success: false, message: "Not found" });

        const conflict = await Booking.findOne({
          date: date || booking.date,
          time: time || booking.time,
          _id: { $ne: id },
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

      const updated = await Booking.findByIdAndUpdate(
        id, { $set: updates }, { new: true, runValidators: true }
      );
      if (!updated) return res.status(404).json({ success: false, message: "Not found" });

      res.json({ success: true, booking: updated });
    } catch (err) {
      console.error("PATCH /api/bookings/:id:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/bookings/:id  (admin only)
// ─────────────────────────────────────────────────────────────────────────────
router.delete(
  "/bookings/:id",
  adminAuth,
  [param("id").isMongoId().withMessage("Invalid ID")],
  handleValidation,
  async (req, res) => {
    try {
      const deleted = await Booking.findByIdAndDelete(req.params.id);
      if (!deleted) return res.status(404).json({ success: false, message: "Not found" });
      res.json({ success: true, message: "Booking deleted" });
    } catch (err) {
      console.error("DELETE /api/bookings/:id:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/bookings/:id/sms  — send Twilio SMS (admin only)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/bookings/:id/sms",
  adminAuth,
  [
    param("id").isMongoId().withMessage("Invalid ID"),
    body("messageType")
      .isIn(["confirmed", "declined", "waitlist", "reminder"])
      .withMessage("Invalid message type"),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const booking = await Booking.findById(req.params.id);
      if (!booking) return res.status(404).json({ success: false, message: "Not found" });

      if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
        return res.status(503).json({
          success: false,
          message: "Twilio not configured. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER to environment variables.",
        });
      }

      const first = booking.firstName;
      const messages = {
        confirmed: `Hi ${first}! Your Roadstar Tire appointment is CONFIRMED for ${booking.date} at ${booking.time} (${booking.service}). See you soon! — Roadstar Tire`,
        declined:  `Hi ${first}, we had to cancel your ${booking.time} appointment on ${booking.date}. Please call us to reschedule. — Roadstar Tire`,
        waitlist:  `Hi ${first}! A spot just opened at Roadstar Tire on ${booking.date}. Call us now to claim it! — Roadstar Tire`,
        reminder:  `Reminder: Hi ${first}, your Roadstar Tire appointment is TODAY at ${booking.time} (${booking.service}). See you soon! — Roadstar Tire`,
      };

      const client = require("twilio")(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
      );

      const message = await client.messages.create({
        body: messages[req.body.messageType],
        from: process.env.TWILIO_PHONE_NUMBER,
        to:   booking.phone,
      });

      console.log(`[SMS] Sent to ${booking.phone} — SID: ${message.sid}`);
      res.json({ success: true, message: `SMS sent to ${booking.phone}`, sid: message.sid });

    } catch (err) {
      console.error("[SMS] Error:", err.message);
      res.status(500).json({ success: false, message: err.message || "SMS failed" });
    }
  }
);

module.exports = router;
