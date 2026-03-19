const express = require("express");
const { body, query, param } = require("express-validator");
const router = express.Router();

const Booking = require("../models/Booking");
const adminAuth = require("../middleware/adminAuth");
const { handleValidation } = require("../middleware/validate");
const { ALL_SLOTS, toMinutes } = require("../config/slots");

// ─────────────────────────────────────────────────────────────────────────────
// Helper: derive duration from service
// ─────────────────────────────────────────────────────────────────────────────
const getDuration = (service) =>
  service === "Tire Change + Installation" ? 40 : 10;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/book
// Creates a new booking after checking availability
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/book",
  [
    body("firstName")
      .trim()
      .notEmpty().withMessage("First name is required")
      .isLength({ max: 60 }).withMessage("First name too long")
      .escape(),
    body("lastName")
      .trim()
      .notEmpty().withMessage("Last name is required")
      .isLength({ max: 60 }).withMessage("Last name too long")
      .escape(),
    body("phone")
      .trim()
      .notEmpty().withMessage("Phone number is required")
      .matches(/^[\d\s\-\(\)\+]{7,20}$/).withMessage("Invalid phone number"),
    body("service")
      .trim()
      .notEmpty().withMessage("Service type is required")
      .isIn(["Tire Change", "Tire Purchase", "Tire Change + Installation"])
      .withMessage("Invalid service type"),
    body("customService")
      .optional()
      .trim()
      .isLength({ max: 200 }).withMessage("Custom note too long")
      .escape(),
    body("date")
      .trim()
      .notEmpty().withMessage("Date is required")
      .matches(/^\d{4}-\d{2}-\d{2}$/).withMessage("Date must be YYYY-MM-DD")
      .custom((val) => {
        const d = new Date(val);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (isNaN(d.getTime())) throw new Error("Invalid date");
        if (d < today) throw new Error("Cannot book a date in the past");
        return true;
      }),
    body("time")
      .trim()
      .notEmpty().withMessage("Time slot is required")
      .isIn(ALL_SLOTS).withMessage("Invalid time slot"),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const { firstName, lastName, phone, service, customService, date, time } =
        req.body;

      // Check for existing booking at this date+time
      const conflict = await Booking.findOne({ date, time });
      if (conflict) {
        return res.status(409).json({
          success: false,
          message: "That time slot is already booked. Please choose another.",
        });
      }

      const booking = await Booking.create({
        firstName,
        lastName,
        phone,
        service,
        customService: customService || "",
        date,
        time,
        duration: getDuration(service),
        status: "pending",
      });

      res.status(201).json({
        success: true,
        message: "Booking created successfully",
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
      // Handle Mongo duplicate key (race condition safety net)
      if (err.code === 11000) {
        return res.status(409).json({
          success: false,
          message: "That time slot was just taken. Please choose another.",
        });
      }
      console.error("POST /api/book error:", err);
      res.status(500).json({ success: false, message: "Server error. Try again." });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/availability?date=YYYY-MM-DD
// Returns available (not yet booked) time slots for a given date
// Removes past slots if date is today
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/availability",
  [
    query("date")
      .trim()
      .notEmpty().withMessage("date query param is required")
      .matches(/^\d{4}-\d{2}-\d{2}$/).withMessage("date must be YYYY-MM-DD"),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const { date } = req.query;

      // Fetch all bookings on this date (only need the time field)
      const booked = await Booking.find(
        { date, status: { $nin: ["cancelled"] } },
        { time: 1, _id: 0 }
      );
      const bookedTimes = new Set(booked.map((b) => b.time));

      // If today, filter out slots that are already past
      const now = new Date();
      const isToday =
        date === now.toISOString().slice(0, 10);
      const currentMinutes = isToday
        ? now.getHours() * 60 + now.getMinutes()
        : -1;

      const available = ALL_SLOTS.filter((slot) => {
        if (bookedTimes.has(slot)) return false;
        if (isToday && toMinutes(slot) <= currentMinutes) return false;
        return true;
      });

      res.json({ success: true, date, available, booked: [...bookedTimes] });
    } catch (err) {
      console.error("GET /api/availability error:", err);
      res.status(500).json({ success: false, message: "Server error." });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/bookings   (admin only)
// Returns all bookings, newest first, with optional ?status= filter
// ─────────────────────────────────────────────────────────────────────────────
router.get("/bookings", adminAuth, async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.date)   filter.date   = req.query.date;

    const bookings = await Booking.find(filter).sort({ date: 1, time: 1 });
    res.json({ success: true, count: bookings.length, bookings });
  } catch (err) {
    console.error("GET /api/bookings error:", err);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/bookings/:id   (admin only)
// Update status and/or notes and/or reschedule time
// ─────────────────────────────────────────────────────────────────────────────
router.patch(
  "/bookings/:id",
  adminAuth,
  [
    param("id").isMongoId().withMessage("Invalid booking ID"),
    body("status")
      .optional()
      .isIn(["pending", "confirmed", "waitlist", "cancelled"])
      .withMessage("Invalid status"),
    body("notes")
      .optional()
      .trim()
      .isLength({ max: 500 }).withMessage("Notes too long")
      .escape(),
    body("time")
      .optional()
      .isIn(ALL_SLOTS).withMessage("Invalid time slot"),
    body("date")
      .optional()
      .matches(/^\d{4}-\d{2}-\d{2}$/).withMessage("Date must be YYYY-MM-DD"),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status, notes, time, date } = req.body;

      // If rescheduling, ensure no conflict on the new slot
      if (time || date) {
        const booking = await Booking.findById(id);
        if (!booking) return res.status(404).json({ success: false, message: "Booking not found" });

        const newDate = date || booking.date;
        const newTime = time || booking.time;

        const conflict = await Booking.findOne({
          date: newDate,
          time: newTime,
          _id: { $ne: id },
          status: { $nin: ["cancelled"] },
        });
        if (conflict) {
          return res.status(409).json({
            success: false,
            message: "That time slot is already taken.",
          });
        }
      }

      const updates = {};
      if (status !== undefined) updates.status = status;
      if (notes  !== undefined) updates.notes  = notes;
      if (time   !== undefined) updates.time   = time;
      if (date   !== undefined) updates.date   = date;

      const updated = await Booking.findByIdAndUpdate(
        id,
        { $set: updates },
        { new: true, runValidators: true }
      );

      if (!updated) {
        return res.status(404).json({ success: false, message: "Booking not found" });
      }

      res.json({ success: true, booking: updated });
    } catch (err) {
      console.error("PATCH /api/bookings/:id error:", err);
      res.status(500).json({ success: false, message: "Server error." });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/bookings/:id   (admin only)
// ─────────────────────────────────────────────────────────────────────────────
router.delete(
  "/bookings/:id",
  adminAuth,
  [param("id").isMongoId().withMessage("Invalid booking ID")],
  handleValidation,
  async (req, res) => {
    try {
      const deleted = await Booking.findByIdAndDelete(req.params.id);
      if (!deleted) {
        return res.status(404).json({ success: false, message: "Booking not found" });
      }
      res.json({ success: true, message: "Booking deleted" });
    } catch (err) {
      console.error("DELETE /api/bookings/:id error:", err);
      res.status(500).json({ success: false, message: "Server error." });
    }
  }
);

module.exports = router;
