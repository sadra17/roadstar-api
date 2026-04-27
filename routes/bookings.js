// routes/bookings.js  v9-supabase
"use strict";

const express = require("express");
const { body, query, param } = require("express-validator");
const router  = express.Router();

const { Bookings, SmsLog, ShopSettings } = require("../lib/db");
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
  display12To24, toMinutes,
} = require("../config/business");

const SOFT_DELETE_DAYS = 15;

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
  const defaults = {
    confirmed:           "Hi {firstName}! Your {shopName} appointment is CONFIRMED for {date} at {time} ({service}). See you soon! — {shopName}",
    declined:            "Hi {firstName}, we had to cancel your {time} appointment on {date}. Please call us to reschedule. — {shopName}",
    waitlist:            "Hi {firstName}! A spot just opened at {shopName} on {date}. Call us to claim it! — {shopName}",
    reminder:            "Hi {firstName}, reminder: your {shopName} appointment is TODAY at {time} for {service}. See you soon! — {shopName}",
    completed_review:    "Thanks for visiting {shopName}, {firstName}! We hope you love your {service}. Drive safe!\n\nClick the link to leave us a review\n{reviewLink}",
    completed_no_review: "Thanks for visiting {shopName}, {firstName}! We hope you love your {service}. Drive safe! — {shopName}",
    no_show:             "Hi {firstName}, we missed you today at {shopName} for your {service} appointment. Please call us to reschedule. — {shopName}",
  };
  const template = templates[messageType] || defaults[messageType] || "";
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
    body("firstName").trim().notEmpty().isLength({ max:60 }).escape(),
    body("lastName").trim().notEmpty().isLength({ max:60 }).escape(),
    body("phone").trim().notEmpty().matches(/^[\d\s\-\(\)\+]{7,20}$/),
    body("email").optional().trim().isEmail().normalizeEmail(),
    body("service").trim().notEmpty(),
    body("customService").optional().trim().isLength({ max:300 }).escape(),
    body("date").trim().matches(/^\d{4}-\d{2}-\d{2}$/),
    body("time").trim().notEmpty(),
    body("tireSize").optional().trim().isLength({ max:50 }).escape(),
    body("doesntKnowTireSize").optional().isBoolean(),
    body("shopId").optional().trim(),
    body("emailConsent").optional().isBoolean(),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const shopId = req.body.shopId || req.headers["x-shop-id"] || process.env.DEFAULT_SHOP_ID || "roadstar";
      const { config } = await loadConfig(shopId);
      const { firstName, lastName, phone, email, service, customService, date, time, tireSize, doesntKnowTireSize } = req.body;

      if (!getHoursForDate(date, config)) {
        return res.status(400).json({ success: false, message: "The shop is closed on this day." });
      }
      const def = resolveService(service, config);
      const cap = await validateCapacity(date, time, service, shopId, null, config);
      if (!cap.ok) return res.status(409).json({ success: false, message: cap.reason });

      const booking = await Bookings.create({
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
        emailConsent: req.body.emailConsent === true || req.body.emailConsent === "true" || false,
        status:  "pending",
        deleted: false,
      });

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

    // Fetch sms_log for each booking (batch would be better at scale, fine for now)
    const enriched = await Promise.all(bookings.map(async b => {
      const def = resolveService(b.service, config);
      if (!b.serviceDuration || (b.serviceDuration === 10 && b.service !== "Tire Purchase") || !b.resourcePool) {
        b.serviceDuration       = def.service_duration;
        b.equipmentRecoveryTime = b.equipmentRecoveryTime ?? def.equipment_recovery_time;
        b.resourcePool          = def.resourcePool;
      }
      b.smsLog = await SmsLog.findByBooking(b.id);
      return b;
    }));

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
    const bookings = await Bookings.find(filter, { orderBy: { col: "created_at", asc: false } });

    // Filter by search client-side (Supabase ilike for server-side search at scale)
    let filtered = bookings;
    if (search) {
      const q = search.toLowerCase();
      filtered = bookings.filter(b =>
        `${b.firstName} ${b.lastName}`.toLowerCase().includes(q) ||
        b.phone.includes(q) || (b.email || "").toLowerCase().includes(q)
      );
    }

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
router.get("/live-bay", adminAuth, requirePermission("view:live_bay"), async (req, res) => {
  try {
    const { DateTime } = require("luxon");
    const { config }   = await loadConfig(req.shopId);
    const tz           = config?.tz || "America/Toronto";
    const now          = DateTime.now().setZone(tz);
    const todayStr     = now.toISODate();
    const nowMins      = now.hour*60+now.minute;

    const todayConfirmed = await Bookings.find({ shop_id: req.shopId, date: todayStr, status: "confirmed", deleted: false }, { orderBy: { col: "time", asc: true } });

    const active=[], upcoming=[];
    for (const b of todayConfirmed) {
      if (b.resourcePool === "none") continue;
      const s24 = display12To24(b.time);
      if (!s24) continue;
      const startM = toMinutes(s24);
      const occ    = resolvedOccupation(b, config);
      const totalOcc = occ + (b.bayTimeExtendedBy||0);
      const endM   = startM + totalOcc;
      if (nowMins>=startM&&nowMins<endM) active.push({...b,minutesRemaining:endM-nowMins,_resolvedDuration:totalOcc,_extendedBy:b.bayTimeExtendedBy||0});
      else if (startM>nowMins) upcoming.push(b);
    }
    let counter=1;
    const activeBays=active.map(b=>b.resourcePool==="alignment"?{...b,assignedBay:"alignment"}:{...b,assignedBay:b.bayNumber||counter++});
    res.json({ success:true, active:activeBays, upcoming:upcoming.slice(0,8), now:now.toISO() });
  } catch (err) { res.status(500).json({ success:false, message:"Server error" }); }
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
    body("notes").optional().trim().isLength({max:1000}).escape(),
    body("time").optional().trim(), body("date").optional().isISO8601().toDate(),
    body("sendSMS").optional().isBoolean(),
    body("completedSmsVariant").optional().isIn(["with_review","without_review","none"]),
    body("tireSize").optional().trim().isLength({max:50}).escape(),
    body("doesntKnowTireSize").optional().isBoolean(),
    body("bayNumber").optional().isInt({min:1,max:3}),
  ], handleValidation,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status, notes, time, date, sendSMS:triggerSMS, completedSmsVariant, tireSize, doesntKnowTireSize, bayNumber } = req.body;

      const current = await Bookings.findById(id);
      if (!current||current.shopId!==req.shopId) return res.status(404).json({success:false,message:"Booking not found."});

      if (time||date) {
        const { config } = await loadConfig(req.shopId);
        const newDate = date ? (typeof date==="object"?date.toISOString().slice(0,10):date) : current.date;
        const newTime = time || current.time;
        const cap = await validateCapacity(newDate, newTime, current.service, req.shopId, id, config);
        if (!cap.ok) return res.status(409).json({success:false,message:cap.reason});
      }

      const updates = {};
      if (status!==undefined) updates.status=status;
      if (notes!==undefined)  updates.notes=notes;
      if (time!==undefined)   updates.time=time;
      if (date!==undefined)   updates.date=(typeof date==="object"?date.toISOString().slice(0,10):date);
      if (tireSize!==undefined) updates.tireSize=tireSize;
      if (doesntKnowTireSize!==undefined) updates.doesntKnowTireSize=doesntKnowTireSize;
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

      // SMS
      let smsSent=false;
      if (status&&triggerSMS!==false) {
        const { config } = await loadConfig(req.shopId);
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
    res.json({ success:true, position:idx, waitMinutes:idx*40, totalInQueue:active.length, message:idx===0?"You are next!":`${idx} customer${idx>1?"s":""} ahead` });
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
