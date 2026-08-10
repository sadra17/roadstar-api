// routes/bookings.js  v9-supabase
"use strict";

const express = require("express");
const { body, query, param } = require("express-validator");
const router  = express.Router();

const { Bookings, SmsLog, ShopSettings } = require("../lib/db");
const { sendEmail } = require("../lib/email");
const adminAuth = require("../middleware/adminAuth");
const { requirePermission } = require("../middleware/adminAuth");
const { handleValidation }  = require("../middleware/validate");
const { createAuditLog }    = require("../middleware/audit");
const { getOrCreate }       = require("./settings");
const {
  buildShopConfig, renderSmsTemplate,
  DEFAULT_SERVICE_DEFS, DEFAULT_RESOURCE_POOLS,
  resolveService, resolvedOccupation,
  computeAvailability, validateCapacity, getHoursForDate,
  display12To24, toMinutes, generateSlots,
} = require("../config/business");

const jwt = require("jsonwebtoken");

const SOFT_DELETE_DAYS = 15;

// ── Per-slot booking mutex ────────────────────────────────────────────────────
// Prevents race condition where two simultaneous POST /api/book requests
// both pass validateCapacity() before either inserts. Lock key is
// shopId|date|resourcePool so unrelated slots never block each other.
// This is safe on Render's single-process deployment. A Redis lock would be
// needed for multi-process deployments.
const _slotLocks = new Map();

async function withSlotLock(key, fn) {
  // Queue behind any existing lock on this exact slot
  while (_slotLocks.has(key)) {
    await _slotLocks.get(key);
  }
  let resolve;
  const p = new Promise(r => { resolve = r; });
  _slotLocks.set(key, p);
  try {
    return await fn();
  } finally {
    _slotLocks.delete(key);
    resolve();
  }
}

async function loadConfig(shopId) {
  const settings = await getOrCreate(shopId);
  return { settings, config: buildShopConfig(settings) };
}

async function sendTwilioSMS(to, msgBody) {
  if (!process.env.TWILIO_ACCOUNT_SID) { console.warn("[SMS] Twilio not configured"); return null; }
  const client = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return client.messages.create({ body: msgBody, from: process.env.TWILIO_PHONE_NUMBER, to });
}

function buildSmsBody(messageType, booking, shopConfig) {
  const shopName   = shopConfig?.shopName || "Roadstar Tire";
  const reviewLink = shopConfig?.googleReviewLink || "";
  const svcLabel   = booking.service === "Other" && booking.customService ? `Other — ${booking.customService}` : booking.service;
  const templates  = shopConfig?.smsTemplates || {};
  // toCamel() converts stored JSONB keys: no_show→noShow, completed_review→completedReview, etc.
  // Try both the original snake_case key AND the camelCase version to handle both DB states.
  const camelType = messageType.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const defaults = {
    confirmed:           "Hi {firstName}! Your {shopName} appointment is CONFIRMED for {date} at {time} ({service}). See you soon! — {shopName}",
    declined:            "Hi {firstName}, we had to cancel your {time} appointment on {date}. Please call us to reschedule. — {shopName}",
    waitlist:            "Hi {firstName}! A spot just opened at {shopName} on {date}. Call us to claim it! — {shopName}",
    reminder:            "Hi {firstName}, reminder: your {shopName} appointment is TODAY at {time} for {service}. See you soon! — {shopName}",
    completed_review:    "Thanks for visiting {shopName}, {firstName}! We hope you love your {service}. Drive safe!\n\nClick the link to leave us a review\n{reviewLink}",
    completed_no_review: "Thanks for visiting {shopName}, {firstName}! We hope you love your {service}. Drive safe! — {shopName}",
    no_show:             "Hi {firstName}, we missed you today at {shopName} for your {service} appointment. Please call us to reschedule. — {shopName}",
  };
  // Lookup: try snake_case first, then camelCase (after toCamel DB round-trip), then default
  const template = templates[messageType] || templates[camelType] || defaults[messageType] || "";
  if (!template) return null;
  return renderSmsTemplate(template, { firstName: booking.firstName, shopName, date: booking.date, time: booking.time, service: svcLabel, reviewLink });
}

async function sendAndLog(bookingId, shopId, to, messageType, msgBody) {
  // Duplicate prevention — check sms_log for same type within 5 minutes
  const dup = await SmsLog.checkDuplicate(bookingId, messageType, 5);
  if (dup) {
    console.warn(`[SMS] Duplicate prevented: ${messageType} to ${to}`);
    return { ...dup, duplicate: true };
  }

  const entry = { bookingId, shopId, messageType, body: msgBody, sentAt: new Date().toISOString() };
  try {
    const msg    = await sendTwilioSMS(to, msgBody);
    entry.status    = "sent";
    entry.twilioSid = msg?.sid || null;
    console.log(`[SMS] ${messageType} → ${to}`);
  } catch (err) {
    entry.status = "failed";
    entry.error  = err.message;
    console.error(`[SMS] Failed ${messageType} → ${to}:`, err.message);
  }
  await SmsLog.create(entry);
  await Bookings.markSmsSent(bookingId);
  return entry;
}

// ── GET /api/business-hours (public) ─────────────────────────────────────────
router.get("/business-hours", async (req, res) => {
  try {
    const shopId = req.query.shopId || req.headers["x-shop-id"] || process.env.DEFAULT_SHOP_ID || "roadstar";
    const { settings, config } = await loadConfig(shopId);
    res.json({
      success: true,
      hours:         config?.hours,
      services:      config?.allServices || [],
      serviceDefs:   config?.serviceDefs || DEFAULT_SERVICE_DEFS,
      resourcePools: config?.resourcePools || DEFAULT_RESOURCE_POOLS,
      blackoutDates: config?.blackoutDates || [],
      shopName:      settings.shopName,
      logoUrl:       settings.logoUrl || "",
      primaryColor:  settings.primaryColor || "#2563EB",
      collectEmailEnabled: settings.collectEmailEnabled || false,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Could not load business info." });
  }
});

// ── GET /api/availability (public) ───────────────────────────────────────────
router.get("/availability",
  [query("date").trim().matches(/^\d{4}-\d{2}-\d{2}$/), query("service").optional().trim(), query("shopId").optional().trim()],
  handleValidation,
  async (req, res) => {
    try {
      const shopId  = req.query.shopId || req.headers["x-shop-id"] || process.env.DEFAULT_SHOP_ID || "roadstar";
      const service = req.query.service || "Tire Change + Installation";
      const { config } = await loadConfig(shopId);
      // Note: computeAvailability no longer takes Booking model — uses db.Bookings internally
      const result = await computeAvailability(req.query.date, service, shopId, config);
      res.json({ success: true, date: req.query.date, ...result });
    } catch (err) {
      console.error("GET /api/availability:", err);
      res.status(500).json({ success: false, message: "Could not load availability." });
    }
  }
);

// ── POST /api/book (public) ───────────────────────────────────────────────────
router.post("/book",
  [
    body("firstName").trim().notEmpty().isLength({ max:60 }),
    body("lastName").trim().notEmpty().isLength({ max:60 }),
    body("phone").trim().notEmpty().matches(/^[\d\s\-\(\)\+]{7,20}$/),
    body("email").optional({ checkFalsy: true }).trim().isEmail().normalizeEmail(),
    body("service").trim().notEmpty(),
    body("customService").optional().trim().isLength({ max:300 }),
    body("date").trim().matches(/^\d{4}-\d{2}-\d{2}$/),
    body("time").trim().notEmpty(),
    body("tireSize").optional().trim().isLength({ max:50 }),
    body("doesntKnowTireSize").optional().isBoolean(),
    body("tireQuantity").optional({ nullable: true, checkFalsy: true }).isInt({ min:1, max:50 }).toInt(),
    body("shopId").optional().trim(),
    body("emailConsent").optional().isBoolean(),
    body("termsAgreed").optional().isBoolean(),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const shopId = req.body.shopId || req.headers["x-shop-id"] || process.env.DEFAULT_SHOP_ID || "roadstar";
      const { config } = await loadConfig(shopId);
      const { firstName, lastName, phone, email, service, customService, date, time, tireSize, doesntKnowTireSize, tireQuantity } = req.body;

      // Terms & Conditions: agreement is required for every booking (public form
      // and staff walk-in). Recorded on the booking with a server-side timestamp.
      const termsAgreed = req.body.termsAgreed === true || req.body.termsAgreed === "true";
      if (!termsAgreed) {
        return res.status(400).json({ success: false, message: "You must agree to the Terms & Conditions to book." });
      }

      if (!getHoursForDate(date, config)) {
        return res.status(400).json({ success: false, message: "The shop is closed on this day." });
      }

      // API8: validate service is in the shop's active service list
      // NOTE: use .length check — an empty array [] is truthy, so `|| fallback` would never fire
      const activeServices = config?.allServices?.length ? config.allServices : Object.keys(DEFAULT_SERVICE_DEFS);
      if (!activeServices.includes(service)) {
        return res.status(400).json({ success: false, message: "That service is not currently offered by this shop." });
      }

      // API7: validate that the requested time slot actually exists for this date+service
      // (prevents booking into slots outside business hours or non-15-min-boundary times)
      const validSlots = generateSlots(date, service, config);
      const slot24 = display12To24(time) || time;
      const isValidSlot = validSlots.some(s => (display12To24(s) || s) === slot24);
      if (!isValidSlot) {
        return res.status(400).json({ success: false, message: "That time slot is not available for this service on this date." });
      }

      const def = resolveService(service, config);

      // Staff walk-ins: if a valid staff JWT is present, allow status override (confirmed/pending)
      // Public Shopify form bookings always create as "pending" (no token present)
      // source: "walkin" when created by signed-in staff, "online" from the public form.
      let bookingStatus = "pending";
      let bookingSource = "online";
      const authHeader = req.headers["authorization"];
      if (authHeader?.startsWith("Bearer ")) {
        try {
          const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
          if (["superadmin","owner","frontdesk","mechanic"].includes(decoded.role)) {
            bookingSource = "walkin";
            if (["pending","confirmed"].includes(req.body.status)) bookingStatus = req.body.status;
          }
        } catch {} // invalid/expired token — default to pending/online
      }

      // Lock key: shopId|date|resourcePool — only serialize bookings that compete
      // for the same resource pool on the same date. Unrelated slots run in parallel.
      const lockKey = `${shopId}|${date}|${def.resourcePool}`;
      const result = await withSlotLock(lockKey, async () => {
        const cap = await validateCapacity(date, time, service, shopId, null, config);
        if (!cap.ok) return { conflict: true, reason: cap.reason };
        const bk = await Bookings.create({
          shopId, firstName, lastName, phone,
          email:         email || "",
          service,
          customService: customService || "",
          date, time,
          serviceDuration:       def.service_duration,
          equipmentRecoveryTime: def.equipment_recovery_time,
          resourcePool:          def.resourcePool,
          customerQuantity:      1,
          tireSize:         tireSize || "",
          doesntKnowTireSize: doesntKnowTireSize === true || doesntKnowTireSize === "true",
          tireQuantity:     Number.isInteger(tireQuantity) ? tireQuantity : null,
          emailConsent: req.body.emailConsent === true || req.body.emailConsent === "true" || false,
          termsAgreed:   true,
          termsAgreedAt: new Date().toISOString(),
          status:  bookingStatus,
          source:  bookingSource,
          deleted: false,
        });
        return { booking: bk };
      });

      if (result.conflict) return res.status(409).json({ success: false, message: result.reason });
      const booking = result.booking;

      if (req.io) req.io.to(`shop:${shopId}`).emit("new_booking", {
        id: booking.id, customer: `${booking.firstName} ${booking.lastName}`,
        service: booking.service, date: booking.date, time: booking.time, status: booking.status,
      });

      res.status(201).json({ success: true, message: "Booking created successfully.",
        booking: { id: booking.id, customer: `${booking.firstName} ${booking.lastName}`, service: booking.service, date: booking.date, time: booking.time, status: booking.status } });
    } catch (err) {
      console.error("POST /api/book:", err);
      res.status(500).json({ success: false, message: "Something went wrong. Please try again or call us directly." });
    }
  }
);

// ── GET /api/bookings — admin ─────────────────────────────────────────────────
router.get("/bookings", adminAuth, requirePermission("view:bookings"), async (req, res) => {
  try {
    const { config } = await loadConfig(req.shopId);
    const filter = { shop_id: req.shopId, deleted: false };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.date)   filter.date   = req.query.date;

    const bookings = await Bookings.find(filter, { orderBy: { col: "date", asc: true } });

    // P2: single batch query for all SMS logs instead of N per-booking queries
    const smsLogMap = await SmsLog.findByBookingBatch(bookings.map(b => b.id));

    const enriched = bookings.map(b => {
      const def = resolveService(b.service, config);
      if (!b.serviceDuration || (b.serviceDuration === 10 && b.service !== "Tire Purchase") || !b.resourcePool) {
        b.serviceDuration       = def.service_duration;
        b.equipmentRecoveryTime = b.equipmentRecoveryTime ?? def.equipment_recovery_time;
        b.resourcePool          = def.resourcePool;
      }
      b.smsLog = smsLogMap[b.id] || [];
      return b;
    });

    res.json({ success: true, count: enriched.length, bookings: enriched });
  } catch (err) {
    console.error("GET /api/bookings:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/recently-deleted — admin ────────────────────────────────────────
router.get("/recently-deleted", adminAuth, requirePermission("view:bookings"), async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - SOFT_DELETE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const bookings = await Bookings.find({ shop_id: req.shopId, deleted: true, deleted_at: { $gte: cutoff } },
      { orderBy: { col: "deleted_at", asc: false } });
    res.json({ success: true, count: bookings.length, bookings });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/customers — admin ────────────────────────────────────────────────
router.get("/customers", adminAuth, requirePermission("view:customers"), async (req, res) => {
  try {
    const { search } = req.query;
    const filter = { shop_id: req.shopId, deleted: false };

    // BE7: use Supabase ilike for server-side search instead of loading all rows into memory.
    // Searches first_name, last_name, phone, email independently (OR). Combined full-name
    // search (e.g. "John Smith") is not supported at DB level but covers the common cases.
    const findOpts = { orderBy: { col: "created_at", asc: false } };
    if (search) {
      findOpts.orSearch = [
        ["first_name", search], ["last_name", search],
        ["phone", search], ["email", search],
      ];
    }
    const bookings = await Bookings.find(filter, findOpts);
    const filtered = bookings;

    const map = {};
    for (const b of filtered) {
      const key = b.phone;
      if (!map[key]) map[key] = { phone: b.phone, firstName: b.firstName, lastName: b.lastName, email: b.email || "", visitCount: 0, completedCount: 0, bookings: [], tireSizes: new Set(), services: new Set(), lastVisit: b.date, totalSpent: 0 };
      const c = map[key];
      if (b.email && !c.email) c.email = b.email;
      c.visitCount++;
      if (b.status === "completed") { c.completedCount++; if (b.paymentStatus === "paid" && b.finalPrice) c.totalSpent += b.finalPrice; }
      c.bookings.push(b);
      c.services.add(b.service);
      if (b.tireSize) c.tireSizes.add(b.tireSize);
      if (b.doesntKnowTireSize && !b.tireSize) c.tireSizes.add("Doesn't know size");
      if (b.date > c.lastVisit) c.lastVisit = b.date;
    }
    const customers = Object.values(map)
      .map(c => ({ ...c, tireSizes: [...c.tireSizes], services: [...c.services], totalSpent: Math.round(c.totalSpent*100)/100 }))
      .sort((a, b) => b.visitCount - a.visitCount);
    res.json({ success: true, count: customers.length, customers });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /api/customers/export — CSV ──────────────────────────────────────────
router.get("/customers/export", adminAuth, requirePermission("export:customers"), async (req, res) => {
  try {
    const bookings = await Bookings.find({ shop_id: req.shopId, deleted: false }, { orderBy: { col: "created_at", asc: false } });
    const map = {};
    for (const b of bookings) {
      const key = b.phone;
      if (!map[key]) map[key] = { firstName:b.firstName, lastName:b.lastName, phone:b.phone, email:b.email||"", visitCount:0, completedCount:0, lastVisit:b.date, lastService:b.service, totalSpent:0, tireSizes:new Set() };
      const c = map[key]; if (b.email && !c.email) c.email = b.email;
      c.visitCount++;
      if (b.status==="completed") { c.completedCount++; if (b.paymentStatus==="paid"&&b.finalPrice) c.totalSpent+=b.finalPrice; if (b.date>=c.lastVisit) { c.lastVisit=b.date; c.lastService=b.service; } }
      if (b.tireSize) c.tireSizes.add(b.tireSize);
    }
    const rows = Object.values(map);
    const header = "First Name,Last Name,Phone,Email,Visits,Completed,Total Spent,Last Visit,Last Service,Tire Sizes";
    const csv = [header, ...rows.map(c => [c.firstName,c.lastName,c.phone,c.email,c.visitCount,c.completedCount,(c.totalSpent).toFixed(2),c.lastVisit,c.lastService,[...c.tireSizes].join("|")].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(","))].join("\n");
    await createAuditLog(req, { action:"export", entity:"customer", entityLabel:`${rows.length} customers exported` });
    res.setHeader("Content-Type","text/csv");
    res.setHeader("Content-Disposition",`attachment; filename="customers-${req.shopId}-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (err) { res.status(500).json({ success:false, message:"Server error" }); }
});

// ── GET /api/customers/by-phone/:phone ───────────────────────────────────────
router.get("/customers/by-phone/:phone", adminAuth, requirePermission("view:customers"), async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const bookings = await Bookings.find({ shop_id: req.shopId, phone, deleted: false }, { orderBy: { col: "date", asc: false } });
    if (!bookings.length) return res.status(404).json({ success:false, message:"Customer not found" });
    const latest = bookings[0];
    const profile = {
      phone, firstName: latest.firstName, lastName: latest.lastName, email: bookings.find(b=>b.email)?.email||"",
      visitCount: bookings.length, completedCount: bookings.filter(b=>b.status==="completed").length,
      noShowCount: bookings.filter(b=>b.status==="no_show").length,
      totalSpent: Math.round(bookings.filter(b=>b.paymentStatus==="paid").reduce((s,b)=>s+(b.finalPrice||0),0)*100)/100,
      tireSizes: [...new Set(bookings.filter(b=>b.tireSize).map(b=>b.tireSize))],
      services:  [...new Set(bookings.map(b=>b.service))],
      firstVisit: bookings[bookings.length-1].date, lastVisit: bookings[0].date, bookings,
    };
    res.json({ success:true, customer:profile });
  } catch (err) { res.status(500).json({ success:false, message:"Server error" }); }
});

// ── GET /api/live-bay — admin/mechanic ───────────────────────────────────────
// A car is "live at bay" ONLY after a mechanic presses Start (sets bay_started_at).
// It leaves the bay when a mechanic presses End (sets bay_ended_at).
//   active   = started, not yet ended (currently in a bay)
//   ready    = confirmed today, needs a bay, not yet started (mechanic must accept/Start)
//   upcoming = other non-cancelled/completed bookings later today (info only)
router.get("/live-bay", adminAuth, requirePermission("view:live_bay"), async (req, res) => {
  try {
    const { DateTime } = require("luxon");
    const { config }   = await loadConfig(req.shopId);
    const tz           = config?.tz || "America/Toronto";
    const now          = DateTime.now().setZone(tz);
    const todayStr     = now.toISODate();
    const nowMins      = now.hour*60+now.minute;
    const nowMs        = now.toMillis();

    const todayAll = await Bookings.find(
      { shop_id: req.shopId, date: todayStr, deleted: false },
      { orderBy: { col: "time", asc: true } }
    );

    const active = [], ready = [], upcoming = [];
    for (const b of todayAll) {
      if (["cancelled","completed"].includes(b.status)) continue;

      // Live in a bay: mechanic has started it and not yet ended it
      if (b.bayStartedAt && !b.bayEndedAt) {
        const occ      = resolvedOccupation(b, config);
        const totalOcc = occ + (b.bayTimeExtendedBy||0);
        const elapsed  = Math.max(0, Math.round((nowMs - DateTime.fromISO(b.bayStartedAt).toMillis()) / 60000));
        active.push({
          ...b,
          _elapsedMinutes:   elapsed,
          minutesRemaining:  totalOcc - elapsed,
          _resolvedDuration: totalOcc,
          _extendedBy:       b.bayTimeExtendedBy||0,
        });
        continue;
      }
      if (b.bayEndedAt) continue; // already finished its bay session

      // Ready to start: confirmed, needs a bay, not started yet
      if (b.status === "confirmed" && b.resourcePool !== "none") {
        ready.push(b);
        continue;
      }

      // Everything else still to come today (pending, waitlist, no-bay services)
      const s24 = display12To24(b.time);
      if (s24 && toMinutes(s24) >= nowMins) upcoming.push(b);
    }

    let counter = 1;
    const activeBays = active.map(b =>
      b.resourcePool === "alignment"
        ? { ...b, assignedBay: "alignment" }
        : { ...b, assignedBay: b.bayNumber || counter++ }
    );

    res.json({ success:true, active:activeBays, ready, upcoming:upcoming.slice(0,8), now:now.toISO() });
  } catch (err) { console.error("GET /api/live-bay:", err); res.status(500).json({ success:false, message:"Server error" }); }
});

// ── PATCH /api/bookings/:id/bay-start — mechanic accepts & puts car in bay ────
router.patch("/bookings/:id/bay-start", adminAuth, requirePermission("manage:live_bay"), [param("id").isUUID()], handleValidation, async (req, res) => {
  try {
    const booking = await Bookings.findById(req.params.id);
    if (!booking || booking.shopId !== req.shopId) return res.status(404).json({ success:false, message:"Not found" });
    if (booking.bayStartedAt && !booking.bayEndedAt) {
      return res.json({ success:true, booking, message:"Already in a bay." });
    }
    const startedAt = new Date().toISOString();
    // Starting also confirms the booking if it was still pending/waitlist
    const updates = { bayStartedAt: startedAt, bayEndedAt: null, bayDurationMinutes: null };
    if (["pending","waitlist"].includes(booking.status)) updates.status = "confirmed";
    const updated = await Bookings.update(req.params.id, req.shopId, updates);
    await createAuditLog(req, { action:"bay_start", entity:"booking", entityId:req.params.id, entityLabel:`${booking.firstName} ${booking.lastName}`, meta:{ startedAt } });
    if (req.io) req.io.to(`shop:${req.shopId}`).emit("booking_updated", { id:req.params.id, booking:updated });
    res.json({ success:true, booking:updated, message:"Car is now live at bay." });
  } catch (err) { console.error("bay-start:", err); res.status(500).json({ success:false, message:"Server error" }); }
});

// ── PATCH /api/bookings/:id/bay-end — mechanic ends job, returns time in shop ──
router.patch("/bookings/:id/bay-end", adminAuth, requirePermission("manage:live_bay"), [param("id").isUUID()], handleValidation, async (req, res) => {
  try {
    const booking = await Bookings.findById(req.params.id);
    if (!booking || booking.shopId !== req.shopId) return res.status(404).json({ success:false, message:"Not found" });
    if (!booking.bayStartedAt) return res.status(400).json({ success:false, message:"This car was never started." });
    const endedAt    = new Date().toISOString();
    const durationMinutes = Math.max(0, Math.round((new Date(endedAt) - new Date(booking.bayStartedAt)) / 60000));
    const updated = await Bookings.update(req.params.id, req.shopId, { bayEndedAt: endedAt, bayDurationMinutes: durationMinutes });
    await createAuditLog(req, { action:"bay_end", entity:"booking", entityId:req.params.id, entityLabel:`${booking.firstName} ${booking.lastName}`, meta:{ durationMinutes } });
    if (req.io) req.io.to(`shop:${req.shopId}`).emit("booking_updated", { id:req.params.id, booking:updated });
    res.json({ success:true, booking:updated, durationMinutes, message:`In the shop for ${durationMinutes} min.` });
  } catch (err) { console.error("bay-end:", err); res.status(500).json({ success:false, message:"Server error" }); }
});

// ── PATCH /api/bookings/:id/bay-snooze ───────────────────────────────────────
router.patch("/bookings/:id/bay-snooze", adminAuth, requirePermission("view:live_bay"), async (req, res) => {
  try {
    const { DateTime } = require("luxon"); const { config } = await loadConfig(req.shopId);
    const snoozeUntil = DateTime.now().setZone(config?.tz||"America/Toronto").plus({minutes:10}).toJSDate().toISOString();
    const updated = await Bookings.update(req.params.id, req.shopId, { bayCheckSnoozeUntil: snoozeUntil });
    if (!updated) return res.status(404).json({ success:false, message:"Not found" });
    res.json({ success:true, booking:updated });
  } catch (err) { res.status(500).json({ success:false, message:"Server error" }); }
});

// ── PATCH /api/bookings/:id/extend-bay ───────────────────────────────────────
router.patch("/bookings/:id/extend-bay", adminAuth, requirePermission("manage:live_bay"),
  [param("id").isUUID(), body("minutes").isInt({min:5,max:120})], handleValidation,
  async (req, res) => {
    try {
      const booking = await Bookings.findById(req.params.id);
      if (!booking||booking.shopId!==req.shopId) return res.status(404).json({success:false,message:"Not found"});
      const newExt = (booking.bayTimeExtendedBy||0) + req.body.minutes;
      const updated = await Bookings.update(req.params.id, req.shopId, { bayTimeExtendedBy: newExt });
      await createAuditLog(req, { action:"extend_bay", entity:"booking", entityId:req.params.id, entityLabel:`${booking.firstName} ${booking.lastName}`, field:"bayTimeExtendedBy", before:booking.bayTimeExtendedBy||0, after:newExt, meta:{addedMinutes:req.body.minutes} });
      res.json({ success:true, booking:updated, message:`Bay time extended by ${req.body.minutes} min` });
    } catch (err) { res.status(500).json({success:false,message:"Server error"}); }
  }
);

// ── PATCH /api/bookings/:id/mechanic ─────────────────────────────────────────
router.patch("/bookings/:id/mechanic", adminAuth, requirePermission("manage:mechanic"),
  [param("id").isUUID(), body("mechanicNotes").trim().isLength({max:2000})], handleValidation,
  async (req, res) => {
    try {
      const booking = await Bookings.findById(req.params.id);
      if (!booking||booking.shopId!==req.shopId) return res.status(404).json({success:false,message:"Not found"});
      const updated = await Bookings.update(req.params.id, req.shopId, { mechanicNotes: req.body.mechanicNotes });
      await createAuditLog(req, { action:"updated", entity:"booking", entityId:req.params.id, entityLabel:`${booking.firstName} ${booking.lastName}`, field:"mechanicNotes", before:booking.mechanicNotes, after:req.body.mechanicNotes });
      res.json({ success:true, booking:updated });
    } catch (err) { res.status(500).json({success:false,message:"Server error"}); }
  }
);

// ── PATCH /api/bookings/:id/payment ──────────────────────────────────────────
router.patch("/bookings/:id/payment", adminAuth, requirePermission("manage:prices"),
  [
    param("id").isUUID(),
    body("quotedPrice").optional().isFloat({min:0}),
    body("finalPrice").optional().isFloat({min:0}),
    body("paymentMethod").optional().isIn(["cash","card","cheque","e-transfer","other"]),
    body("paymentStatus").optional().isIn(["unpaid","paid","partial","refunded"]),
    body("paymentNotes").optional().trim().isLength({max:500}),
  ], handleValidation,
  async (req, res) => {
    try {
      const booking = await Bookings.findById(req.params.id);
      if (!booking||booking.shopId!==req.shopId) return res.status(404).json({success:false,message:"Not found"});
      const { quotedPrice, finalPrice, paymentMethod, paymentStatus, paymentNotes } = req.body;
      const before = { quotedPrice:booking.quotedPrice, finalPrice:booking.finalPrice, paymentMethod:booking.paymentMethod, paymentStatus:booking.paymentStatus };
      // Only pass userId if it's a real UUID (not 'env-admin' or 'system')
      const isRealUUID = req.userId && req.userId !== 'env-admin' && req.userId !== 'system' && req.userId.includes('-');
      const updates = { priceAddedBy:isRealUUID?req.userId:null, priceAddedAt:new Date().toISOString() };
      if (quotedPrice!==undefined) updates.quotedPrice=quotedPrice;
      if (finalPrice!==undefined)  updates.finalPrice=finalPrice;
      if (paymentMethod!==undefined) updates.paymentMethod=paymentMethod;
      if (paymentStatus!==undefined) updates.paymentStatus=paymentStatus;
      if (paymentNotes!==undefined)  updates.paymentNotes=paymentNotes;
      const updated = await Bookings.update(req.params.id, req.shopId, updates);
      await createAuditLog(req, { action:"updated", entity:"booking", entityId:req.params.id, entityLabel:`${booking.firstName} ${booking.lastName} — ${booking.service}`, field:"payment", before, after:{quotedPrice:updated.quotedPrice,finalPrice:updated.finalPrice,paymentMethod:updated.paymentMethod,paymentStatus:updated.paymentStatus} });
      if (req.io) req.io.to(`shop:${req.shopId}`).emit("booking_updated",{id:req.params.id,booking:updated});
      res.json({ success:true, booking:updated });
    } catch (err) { res.status(500).json({success:false,message:"Server error"}); }
  }
);

// ── PATCH /api/bookings/:id — main status/notes/reschedule ───────────────────
router.patch("/bookings/:id", adminAuth, requirePermission("manage:bookings"),
  [
    param("id").isUUID(),
    body("status").optional().isIn(["pending","confirmed","waitlist","completed","cancelled","no_show"]),
    body("notes").optional().trim().isLength({max:1000}),
    body("time").optional().trim(), body("date").optional().isISO8601().toDate(),
    body("sendSMS").optional().isBoolean(),
    body("completedSmsVariant").optional().isIn(["with_review","without_review","none"]),
    body("tireSize").optional().trim().isLength({max:50}),
    body("doesntKnowTireSize").optional().isBoolean(),
    body("tireQuantity").optional({ nullable:true, checkFalsy:true }).isInt({min:1,max:50}).toInt(),
    body("firstName").optional().trim().notEmpty().isLength({max:60}),
    body("lastName").optional().trim().notEmpty().isLength({max:60}),
    body("phone").optional().trim().matches(/^[\d\s\-\(\)\+]{7,20}$/),
    body("email").optional({ checkFalsy:true }).trim().isEmail().normalizeEmail(),
    body("bayNumber").optional().isInt({min:1,max:3}),
  ], handleValidation,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status, notes, time, date, sendSMS:triggerSMS, completedSmsVariant, tireSize, doesntKnowTireSize, tireQuantity, firstName, lastName, phone, email, bayNumber } = req.body;

      const current = await Bookings.findById(id);
      if (!current||current.shopId!==req.shopId) return res.status(404).json({success:false,message:"Booking not found."});

      // CQ5: load config once — reused for reschedule capacity check AND SMS sending below
      const { config } = await loadConfig(req.shopId);

      if (time||date) {
        const newDate = date ? (typeof date==="object"?date.toISOString().slice(0,10):date) : current.date;
        const newTime = time || current.time;
        const def     = resolveService(current.service, config);
        const lockKey = `${req.shopId}|${newDate}|${def.resourcePool}`;
        const capResult = await withSlotLock(lockKey, () =>
          validateCapacity(newDate, newTime, current.service, req.shopId, id, config)
        );
        if (!capResult.ok) return res.status(409).json({success:false,message:capResult.reason});
      }

      const updates = {};
      if (status!==undefined) updates.status=status;
      if (notes!==undefined)  updates.notes=notes;
      if (time!==undefined)   updates.time=time;
      if (date!==undefined)   updates.date=(typeof date==="object"?date.toISOString().slice(0,10):date);
      if (tireSize!==undefined) updates.tireSize=tireSize;
      if (doesntKnowTireSize!==undefined) updates.doesntKnowTireSize=doesntKnowTireSize;
      if (tireQuantity!==undefined) updates.tireQuantity = Number.isInteger(tireQuantity) ? tireQuantity : null;
      if (firstName!==undefined) updates.firstName=firstName;
      if (lastName!==undefined)  updates.lastName=lastName;
      if (phone!==undefined)     updates.phone=phone;
      if (email!==undefined)     updates.email=email;
      if (completedSmsVariant!==undefined) updates.completedSmsVariant=completedSmsVariant;
      if (bayNumber!==undefined) updates.bayNumber=bayNumber;
      if (status==="completed") updates.completedAt=new Date().toISOString();
      if (status==="no_show")   updates.noShowAt=new Date().toISOString();

      const updated = await Bookings.update(id, req.shopId, updates);
      if (!updated) return res.status(404).json({success:false,message:"Booking not found."});

      // Audit
      const changed = Object.keys(updates).filter(k=>String(current[k])!==String(updates[k]));
      if (changed.length) {
        await createAuditLog(req, {
          action: status?"status_changed":"updated", entity:"booking", entityId:id,
          entityLabel:`${current.firstName} ${current.lastName} — ${current.time} ${current.date}`,
          field: changed.length===1?changed[0]:null,
          before: changed.length===1?current[changed[0]]:Object.fromEntries(changed.map(f=>[f,current[f]])),
          after:  changed.length===1?updates[changed[0]]:updates,
        });
      }

      // SMS — uses config loaded above (CQ5: no second loadConfig call)
      let smsSent=false;
      if (status&&triggerSMS!==false) {
        let mt=null;
        if (status==="confirmed") mt="confirmed";
        if (status==="cancelled") mt="declined";
        if (status==="no_show")   mt="no_show";
        if (status==="completed") { if(completedSmsVariant==="with_review") mt="completed_review"; else if(completedSmsVariant==="without_review") mt="completed_no_review"; }
        if (mt) {
          const msgBody=buildSmsBody(mt,updated,config);
          if (msgBody) { const log=await sendAndLog(id,req.shopId,updated.phone,mt,msgBody); smsSent=log.status==="sent"; }
        }
      }

      if (req.io) req.io.to(`shop:${req.shopId}`).emit("booking_updated",{id,booking:updated});
      res.json({ success:true, booking:updated, smsSent });
    } catch (err) { console.error("PATCH /api/bookings/:id:", err); res.status(500).json({success:false,message:"Server error"}); }
  }
);

// ── DELETE /api/bookings/:id — soft delete ────────────────────────────────────
router.delete("/bookings/:id", adminAuth, requirePermission("manage:bookings"), [param("id").isUUID()], handleValidation, async (req, res) => {
  try {
    const booking = await Bookings.findById(req.params.id);
    if (!booking||booking.shopId!==req.shopId) return res.status(404).json({success:false,message:"Not found"});
    await Bookings.softDelete(req.params.id, req.shopId);
    await createAuditLog(req, { action:"deleted", entity:"booking", entityId:req.params.id, entityLabel:`${booking.firstName} ${booking.lastName} — ${booking.date} ${booking.time}`, meta:{service:booking.service,status:booking.status} });
    if (req.io) req.io.to(`shop:${req.shopId}`).emit("booking_deleted",{id:req.params.id});
    res.json({ success:true, message:"Booking moved to Recently Deleted." });
  } catch (err) { res.status(500).json({success:false,message:"Server error"}); }
});

// ── PATCH /api/bookings/:id/restore ──────────────────────────────────────────
router.patch("/bookings/:id/restore", adminAuth, requirePermission("manage:bookings"), [param("id").isUUID()], handleValidation, async (req, res) => {
  try {
    const updated = await Bookings.restore(req.params.id, req.shopId);
    if (!updated) return res.status(404).json({success:false,message:"Not found or not deleted."});
    await createAuditLog(req, { action:"restored", entity:"booking", entityId:req.params.id, entityLabel:`${updated.firstName} ${updated.lastName} — ${updated.date} ${updated.time}` });
    if (req.io) req.io.to(`shop:${req.shopId}`).emit("booking_restored",{id:req.params.id,booking:updated});
    res.json({ success:true, message:"Booking restored.", booking:updated });
  } catch (err) { res.status(500).json({success:false,message:"Server error"}); }
});

// ── Wheel & Tire Inspection Report ────────────────────────────────────────────
// The report is stored as a JSON document on the booking (inspection column).
// Item ids are camelCase so they survive the db layer's snake/camel conversion.
// This server-side map is the source of truth for the emailed report (prevents
// the client from injecting arbitrary label HTML).
const INSPECTION_SECTIONS = [
  { title: "Wheel / Rim Condition", items: [
    ["previousCosmeticRimDamage","Previous cosmetic rim damage"],
    ["wheelBent","Wheel bent"],
    ["wheelCracked","Wheel cracked"],
    ["wheelCorrosion","Wheel corrosion"],
    ["wheelPreviouslyRepaired","Wheel previously repaired"],
    ["wheelSeizedToHub","Wheel seized to hub"],
    ["centerBoreHubDamage","Center bore / hub damage"],
    ["hubRingMissing","Hub ring missing"],
    ["hubRingSeized","Hub ring seized"],
  ]},
  { title: "Lug Nuts / Bolts / Studs", items: [
    ["rustedLugNutsBolts","Rusted lug nuts / bolts"],
    ["swollenLugNuts","Swollen lug nuts"],
    ["roundedDamagedLugNuts","Rounded / damaged lug nuts"],
    ["previouslyOverTorqued","Previously over-torqued"],
    ["previouslyUnderTorqued","Previously under-torqued"],
    ["crossThreadedLugNutBolt","Cross-threaded lug nut / bolt"],
    ["damagedThreads","Damaged threads"],
    ["brokenWheelStud","Broken wheel stud"],
    ["strippedWheelStud","Stripped wheel stud"],
    ["studLengthInsufficient","Stud length insufficient"],
    ["missingLugNutBolt","Missing lug nut / bolt"],
    ["wheelLockDamagedMissingKey","Wheel lock damaged / missing key"],
  ]},
  { title: "Tires / Valves / TPMS", items: [
    ["unevenTreadWear","Uneven tread wear"],
    ["lowTreadDepth","Low tread depth"],
    ["sidewallDamage","Sidewall damage"],
    ["puncturePreviousRepair","Puncture / previous repair"],
    ["dryRotCracking","Dry rot / cracking"],
    ["incorrectTirePressure","Incorrect tire pressure"],
    ["mismatchedTires","Mismatched tires"],
    ["beadDamageObserved","Bead damage observed"],
    ["valveStemCracked","Valve stem cracked"],
    ["tpmsSensorDamaged","TPMS sensor damaged"],
  ]},
  { title: "Hub / Mounting Surface", items: [
    ["heavyRustOnHubFace","Heavy rust on hub face"],
    ["hubPreventsProperWheelSeating","Hub prevents proper wheel seating"],
    ["rotorHatExcessiveCorrosion","Rotor hat excessive corrosion"],
    ["mountingSurfaceRequiresCleaning","Mounting surface requires cleaning"],
  ]},
];
const esc = s => String(s || "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));

function buildInspectionEmail(booking, insp, shopName) {
  const checked = new Set(Array.isArray(insp.checked) ? insp.checked : []);
  const sectionsHtml = INSPECTION_SECTIONS.map(sec => {
    const flagged = sec.items.filter(([id]) => checked.has(id));
    if (!flagged.length) return "";
    const lis = flagged.map(([,label]) => `<li style="margin:2px 0;color:#b91c1c">⚠ ${esc(label)}</li>`).join("");
    return `<div style="margin:14px 0"><div style="font-weight:700;font-size:14px;color:#111">${esc(sec.title)}</div><ul style="margin:6px 0 0;padding-left:20px;font-size:13px">${lis}</ul></div>`;
  }).join("");
  const anyFlagged = [...checked].length > 0;
  const field = (l,v) => v ? `<td style="padding:3px 14px 3px 0;font-size:13px"><b>${esc(l)}:</b> ${esc(v)}</td>` : "";
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#111">
      <h2 style="margin:0 0 2px">${esc(shopName || "Roadstar Tire")}</h2>
      <div style="font-size:15px;font-weight:600;color:#444;margin-bottom:14px">Wheel &amp; Tire Inspection Report</div>
      <table style="border-collapse:collapse;margin-bottom:8px"><tr>
        ${field("Customer", `${booking.firstName} ${booking.lastName}`)}${field("Vehicle", insp.vehicle)}${field("Plate", insp.plate)}
      </tr><tr>
        ${field("Mileage", insp.mileage)}${field("Date", booking.date)}${field("Technician", insp.technician)}
      </tr></table>
      ${anyFlagged ? sectionsHtml : `<p style="font-size:13px;color:#15803d">✓ No issues were flagged during this inspection.</p>`}
      ${insp.notes ? `<div style="margin:14px 0"><div style="font-weight:700;font-size:14px">Recommendations / Notes</div><div style="font-size:13px;white-space:pre-wrap;margin-top:4px">${esc(insp.notes)}</div></div>` : ""}
      <p style="font-size:11px;color:#888;border-top:1px solid #ddd;padding-top:10px;margin-top:18px">Disclaimer: Visual inspection only. Any identified issues should be inspected and repaired by a licensed mechanic.</p>
    </div>`;
}

// ── PATCH /api/bookings/:id/inspection — save the inspection report ────────────
router.patch("/bookings/:id/inspection", adminAuth, requirePermission("manage:bookings"),
  [param("id").isUUID()], handleValidation,
  async (req, res) => {
    try {
      const booking = await Bookings.findById(req.params.id);
      if (!booking || booking.shopId !== req.shopId) return res.status(404).json({ success:false, message:"Not found" });

      const b = req.body || {};
      const validIds = new Set(INSPECTION_SECTIONS.flatMap(s => s.items.map(([id]) => id)));
      const checked = Array.isArray(b.checked) ? b.checked.filter(id => validIds.has(id)) : [];
      const clip = (v, n) => (v == null ? "" : String(v).slice(0, n));
      const inspection = {
        vehicle:    clip(b.vehicle, 120),
        plate:      clip(b.plate, 40),
        mileage:    clip(b.mileage, 40),
        roNumber:   clip(b.roNumber, 40),
        technician: clip(b.technician, 80),
        checked,
        notes:      clip(b.notes, 2000),
        updatedAt:  new Date().toISOString(),
        updatedBy:  req.user?.name || req.user?.email || "staff",
        emailedAt:  booking.inspection?.emailedAt || null,
      };
      const updated = await Bookings.update(req.params.id, req.shopId, { inspection });
      if (!updated) return res.status(404).json({ success:false, message:"Not found" });
      await createAuditLog(req, { action:"inspection_saved", entity:"booking", entityId:req.params.id, entityLabel:`${booking.firstName} ${booking.lastName} — ${checked.length} item(s) flagged` });
      res.json({ success:true, message:"Inspection saved.", booking: updated });
    } catch (err) { console.error("PATCH inspection:", err); res.status(500).json({ success:false, message:"Server error" }); }
  }
);

// ── POST /api/bookings/:id/inspection/email — email report to the customer ─────
router.post("/bookings/:id/inspection/email", adminAuth, requirePermission("manage:bookings"),
  [param("id").isUUID(), body("email").optional({ checkFalsy:true }).trim().isEmail().normalizeEmail()],
  handleValidation,
  async (req, res) => {
    try {
      const booking = await Bookings.findById(req.params.id);
      if (!booking || booking.shopId !== req.shopId) return res.status(404).json({ success:false, message:"Not found" });
      if (!booking.inspection) return res.status(400).json({ success:false, message:"Save the inspection before emailing it." });
      const to = req.body.email || booking.email;
      if (!to) return res.status(400).json({ success:false, message:"No email on file — enter one to send the report." });

      const { config } = await loadConfig(req.shopId);
      const shopName = config?.shopName || config?.settings?.shopName || "Roadstar Tire";
      const html = buildInspectionEmail(booking, booking.inspection, shopName);
      await sendEmail({ to, subject: `Wheel & Tire Inspection Report — ${booking.firstName} ${booking.lastName}`, html });

      const inspection = { ...booking.inspection, emailedAt: new Date().toISOString() };
      const updated = await Bookings.update(req.params.id, req.shopId, { inspection });
      await createAuditLog(req, { action:"inspection_emailed", entity:"booking", entityId:req.params.id, entityLabel:`Sent to ${to}` });
      res.json({ success:true, message:`Inspection report sent to ${to}`, booking: updated });
    } catch (err) { console.error("POST inspection email:", err); res.status(500).json({ success:false, message:err.message || "Email failed" }); }
  }
);

// ── POST /api/bookings/:id/sms — manual ──────────────────────────────────────
router.post("/bookings/:id/sms", adminAuth, requirePermission("manage:bookings"),
  [param("id").isUUID(), body("messageType").isIn(["confirmed","declined","waitlist","reminder","completed_review","completed_no_review","no_show"])],
  handleValidation,
  async (req, res) => {
    try {
      const booking = await Bookings.findById(req.params.id);
      if (!booking||booking.shopId!==req.shopId) return res.status(404).json({success:false,message:"Not found"});
      if (!process.env.TWILIO_ACCOUNT_SID) return res.status(503).json({success:false,message:"Twilio not configured."});
      const { config } = await loadConfig(req.shopId);
      const msgBody = buildSmsBody(req.body.messageType, booking, config);
      if (!msgBody) return res.status(400).json({success:false,message:"No template for this message type."});
      const log = await sendAndLog(booking.id, req.shopId, booking.phone, req.body.messageType, msgBody);
      res.json({ success:true, message:`SMS ${log.status} to ${booking.phone}`, log });
    } catch (err) { res.status(500).json({success:false,message:err.message||"SMS failed"}); }
  }
);

// ── GET /api/queue — public ───────────────────────────────────────────────────
router.get("/queue", async (req, res) => {
  try {
    const shopId = req.query.shopId||process.env.DEFAULT_SHOP_ID||"roadstar";
    const { date, bookingId } = req.query;
    if (!date||!bookingId) return res.status(400).json({success:false,message:"date and bookingId required"});
    const active = await Bookings.find({ shop_id:shopId, date, status:{$in:["pending","confirmed","waitlist"]}, deleted:false }, { orderBy:{col:"time",asc:true} });
    const idx = active.findIndex(b=>b.id===bookingId);
    if (idx===-1) return res.json({success:true,position:0,waitMinutes:0,message:"You are next!"});
    // UX3: sum actual service durations of bookings ahead instead of hardcoded 40min
    const waitMinutes = active.slice(0, idx).reduce((sum, b) => sum + (b.serviceDuration || 40), 0);
    res.json({ success:true, position:idx, waitMinutes, totalInQueue:active.length, message:idx===0?"You are next!":`${idx} customer${idx>1?"s":""} ahead` });
  } catch (err) { res.status(500).json({success:false,message:"Server error"}); }
});

// ── Purge export ──────────────────────────────────────────────────────────────
async function purgeOldDeletedBookings() {
  try {
    const cutoff = new Date(Date.now() - SOFT_DELETE_DAYS*24*60*60*1000).toISOString();
    const sb = require("../config/supabase");
    const { error, count } = await sb.from("bookings").delete({ count:"exact" }).eq("deleted",true).lt("deleted_at",cutoff);
    if (error) throw error;
    if (count>0) console.log(`[Cleanup] Purged ${count} bookings`);
  } catch (err) { console.error("[Cleanup] Error:", err.message); }
}

module.exports = router;
module.exports.purgeOldDeletedBookings = purgeOldDeletedBookings;
