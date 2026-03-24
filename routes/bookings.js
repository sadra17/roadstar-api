// ─────────────────────────────────────────────────────────────────────────────
// routes/bookings.js  v8
// shopId on every query, settings-based SMS templates, smsLog, no_show status
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const express = require("express");
const { body, query, param } = require("express-validator");
const router  = express.Router();

const Booking      = require("../models/Booking");
const adminAuth    = require("../middleware/adminAuth");
const { handleValidation } = require("../middleware/validate");
const { getOrCreate } = require("./settings");
const {
  buildShopConfig, renderSmsTemplate,
  DEFAULT_SERVICE_DEFS, DEFAULT_RESOURCE_POOLS,
  CAPACITY_BLOCKING_STATUS,
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
  const svcLabel   = booking.service === "Other" && booking.customService
    ? `Other — ${booking.customService}` : booking.service;
  const templates  = shopConfig?.smsTemplates || {};
  const defaults   = {
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

async function sendAndLog(bookingId, to, messageType, msgBody) {
  const entry = { messageType, body: msgBody, sentAt: new Date() };
  try {
    const msg = await sendTwilioSMS(to, msgBody);
    entry.status = "sent"; entry.twilioSid = msg?.sid || null;
    console.log(`[SMS] ${messageType} → ${to}`);
  } catch (err) {
    entry.status = "failed"; entry.error = err.message;
    console.error(`[SMS] Failed ${messageType} → ${to}:`, err.message);
  }
  await Booking.findByIdAndUpdate(bookingId, { $push: { smsLog: entry }, $set: { smsSentAt: new Date() } });
  return entry;
}

// ── GET /api/business-hours (public) ─────────────────────────────────────────
router.get("/business-hours", async (req, res) => {
  try {
    const shopId = req.query.shopId || req.headers["x-shop-id"] || process.env.DEFAULT_SHOP_ID || "roadstar";
    const { settings, config } = await loadConfig(shopId);
    res.json({
      success: true,
      hours: config?.hours,
      services: config?.allServices || [],
      serviceDefs: config?.serviceDefs || DEFAULT_SERVICE_DEFS,
      resourcePools: config?.resourcePools || DEFAULT_RESOURCE_POOLS,
      blackoutDates: config?.blackoutDates || [],
      shopName: settings.shopName,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Could not load business info." });
  }
});

// ── GET /api/availability (public) ───────────────────────────────────────────
router.get("/availability",
  [query("date").trim().matches(/^\d{4}-\d{2}-\d{2}$/).withMessage("date must be YYYY-MM-DD"), query("service").optional().trim(), query("shopId").optional().trim()],
  handleValidation,
  async (req, res) => {
    try {
      const shopId  = req.query.shopId || req.headers["x-shop-id"] || process.env.DEFAULT_SHOP_ID || "roadstar";
      const service = req.query.service || "Tire Change + Installation";
      const { config } = await loadConfig(shopId);
      const result = await computeAvailability(req.query.date, service, Booking, shopId, config);
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
    body("service").trim().notEmpty(),
    body("customService").optional().trim().isLength({ max:300 }).escape(),
    body("date").trim().matches(/^\d{4}-\d{2}-\d{2}$/),
    body("time").trim().notEmpty(),
    body("tireSize").optional().trim().isLength({ max:50 }).escape(),
    body("doesntKnowTireSize").optional().isBoolean(),
    body("shopId").optional().trim(),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const shopId = req.body.shopId || req.headers["x-shop-id"] || process.env.DEFAULT_SHOP_ID || "roadstar";
      const { config } = await loadConfig(shopId);
      const { firstName, lastName, phone, service, customService, date, time, tireSize, doesntKnowTireSize } = req.body;

      if (!getHoursForDate(date, config)) {
        return res.status(400).json({ success: false, message: "The shop is closed on this day." });
      }
      const def = resolveService(service, config);
      const cap = await validateCapacity(date, time, service, Booking, shopId, null, config);
      if (!cap.ok) return res.status(409).json({ success: false, message: cap.reason });

      const booking = await Booking.create({
        shopId, firstName, lastName, phone,
        service, customService: customService || "",
        date, time,
        service_duration:        def.service_duration,
        equipment_recovery_time: def.equipment_recovery_time,
        resourcePool:            def.resourcePool,
        customer_quantity: 1,
        tireSize: tireSize || "",
        doesntKnowTireSize: doesntKnowTireSize === true || doesntKnowTireSize === "true",
        status: "pending", deleted: false,
      });

      if (req.io) req.io.emit(`new_booking:${shopId}`, { id: booking._id, customer: booking.customer, service: booking.service, date: booking.date, time: booking.time, status: booking.status });

      res.status(201).json({ success: true, message: "Booking created successfully.", booking: { id: booking._id, customer: booking.customer, service: booking.service, date: booking.date, time: booking.time, status: booking.status } });
    } catch (err) {
      console.error("POST /api/book:", err);
      if (err.code === 11000) return res.status(409).json({ success: false, message: "That time is no longer available. Please choose another time." });
      res.status(500).json({ success: false, message: "Something went wrong. Please try again or call us directly." });
    }
  }
);

// ── GET /api/bookings — admin ─────────────────────────────────────────────────
router.get("/bookings", adminAuth, async (req, res) => {
  try {
    const { config } = await loadConfig(req.shopId);
    const filter = { shopId: req.shopId, deleted: { $ne: true } };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.date)   filter.date   = req.query.date;
    const bookings = await Booking.find(filter).sort({ date: 1, time: 1 });
    const enriched = bookings.map(b => {
      const obj = b.toJSON();
      const def = resolveService(b.service, config);
      const needs = !b.service_duration || (b.service_duration === 10 && b.service !== "Tire Purchase") || !b.resourcePool || (b.resourcePool === "none" && def.resourcePool !== "none");
      if (needs) { obj.service_duration = def.service_duration; obj.equipment_recovery_time = b.equipment_recovery_time ?? def.equipment_recovery_time; obj.resourcePool = def.resourcePool; }
      return obj;
    });
    res.json({ success: true, count: enriched.length, bookings: enriched });
  } catch (err) { res.status(500).json({ success: false, message: "Server error" }); }
});

// ── GET /api/recently-deleted — admin ────────────────────────────────────────
router.get("/recently-deleted", adminAuth, async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - SOFT_DELETE_DAYS * 24 * 60 * 60 * 1000);
    const bookings = await Booking.find({ shopId: req.shopId, deleted: true, deletedAt: { $gte: cutoff } }).sort({ deletedAt: -1 }).lean();
    res.json({ success: true, count: bookings.length, bookings });
  } catch (err) { res.status(500).json({ success: false, message: "Server error" }); }
});

// ── GET /api/customers — admin ────────────────────────────────────────────────
router.get("/customers", adminAuth, async (req, res) => {
  try {
    const { search } = req.query;
    const filter = { shopId: req.shopId, deleted: { $ne: true } };
    if (search) { const re = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"i"); filter.$or = [{ firstName:re },{ lastName:re },{ phone:re }]; }
    const bookings = await Booking.find(filter).sort({ createdAt:-1 }).lean();
    const map = {};
    for (const b of bookings) {
      if (!map[b.phone]) map[b.phone] = { phone:b.phone, firstName:b.firstName, lastName:b.lastName, visitCount:0, bookings:[], tireSizes:new Set(), services:new Set(), lastVisit:b.date };
      const c = map[b.phone]; c.visitCount++; c.bookings.push(b); c.services.add(b.service);
      if (b.tireSize) c.tireSizes.add(b.tireSize);
      if (b.doesntKnowTireSize && !b.tireSize) c.tireSizes.add("Doesn't know size");
      if (b.date > c.lastVisit) c.lastVisit = b.date;
    }
    const customers = Object.values(map).map(c=>({...c,tireSizes:[...c.tireSizes],services:[...c.services]})).sort((a,b)=>b.visitCount-a.visitCount);
    res.json({ success:true, count:customers.length, customers });
  } catch (err) { res.status(500).json({ success:false, message:"Server error" }); }
});

// ── GET /api/live-bay — admin ─────────────────────────────────────────────────
router.get("/live-bay", adminAuth, async (req, res) => {
  try {
    const { DateTime } = require("luxon");
    const { config } = await loadConfig(req.shopId);
    const tz = config?.tz || "America/Toronto";
    const now = DateTime.now().setZone(tz);
    const todayStr = now.toISODate();
    const nowMins  = now.hour*60+now.minute;
    const todayConfirmed = await Booking.find({ shopId:req.shopId, date:todayStr, status:"confirmed", deleted:{$ne:true} }).sort({ time:1 }).lean();
    const active=[], upcoming=[];
    for (const b of todayConfirmed) {
      if (b.resourcePool==="none") continue;
      const s24=display12To24(b.time); if(!s24) continue;
      const startM=toMinutes(s24), occ=resolvedOccupation(b,config), endM=startM+occ;
      if (nowMins>=startM&&nowMins<endM) active.push({...b,minutesRemaining:endM-nowMins,_resolvedDuration:occ});
      else if (startM>nowMins) upcoming.push(b);
    }
    let counter=1;
    const activeBays=active.map(b=>b.resourcePool==="alignment"?{...b,assignedBay:"alignment"}:{...b,assignedBay:b.bayNumber||counter++});
    res.json({ success:true, active:activeBays, upcoming:upcoming.slice(0,6), now:now.toISO() });
  } catch (err) { res.status(500).json({ success:false, message:"Server error" }); }
});

// ── PATCH /api/bookings/:id/bay-snooze ───────────────────────────────────────
router.patch("/bookings/:id/bay-snooze", adminAuth, async (req, res) => {
  try {
    const { DateTime } = require("luxon");
    const { config } = await loadConfig(req.shopId);
    const snoozeUntil = DateTime.now().setZone(config?.tz||"America/Toronto").plus({minutes:10}).toJSDate();
    const updated = await Booking.findOneAndUpdate({ _id:req.params.id, shopId:req.shopId, deleted:{$ne:true} }, { $set:{bayCheckSnoozeUntil:snoozeUntil} }, { new:true });
    if (!updated) return res.status(404).json({ success:false, message:"Not found" });
    res.json({ success:true, booking:updated });
  } catch (err) { res.status(500).json({ success:false, message:"Server error" }); }
});

// ── PATCH /api/bookings/:id — admin ──────────────────────────────────────────
router.patch("/bookings/:id", adminAuth,
  [
    param("id").isMongoId(),
    body("status").optional().isIn(["pending","confirmed","waitlist","completed","cancelled","no_show"]),
    body("notes").optional().trim().isLength({max:1000}).escape(),
    body("time").optional().trim(), body("date").optional().matches(/^\d{4}-\d{2}-\d{2}$/),
    body("sendSMS").optional().isBoolean(), body("completedSmsVariant").optional().isIn(["with_review","without_review","none"]),
    body("tireSize").optional().trim().isLength({max:50}).escape(), body("doesntKnowTireSize").optional().isBoolean(),
    body("bayNumber").optional().isInt({min:1,max:3}),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status, notes, time, date, sendSMS:triggerSMS, completedSmsVariant, tireSize, doesntKnowTireSize, bayNumber } = req.body;

      if (time||date) {
        const { config } = await loadConfig(req.shopId);
        const current = await Booking.findOne({ _id:id, shopId:req.shopId, deleted:{$ne:true} });
        if (!current) return res.status(404).json({ success:false, message:"Booking not found." });
        const cap = await validateCapacity(date||current.date, time||current.time, current.service, Booking, req.shopId, id, config);
        if (!cap.ok) return res.status(409).json({ success:false, message:cap.reason });
      }

      const updates = {};
      if (status!==undefined) updates.status=status;
      if (notes!==undefined)  updates.notes=notes;
      if (time!==undefined)   updates.time=time;
      if (date!==undefined)   updates.date=date;
      if (tireSize!==undefined) updates.tireSize=tireSize;
      if (doesntKnowTireSize!==undefined) updates.doesntKnowTireSize=doesntKnowTireSize;
      if (completedSmsVariant!==undefined) updates.completedSmsVariant=completedSmsVariant;
      if (bayNumber!==undefined) updates.bayNumber=bayNumber;
      if (status==="completed") updates.completedAt=new Date();
      if (status==="no_show")   updates.noShowAt=new Date();

      const updated = await Booking.findOneAndUpdate({ _id:id, shopId:req.shopId, deleted:{$ne:true} }, { $set:updates }, { new:true, runValidators:true });
      if (!updated) return res.status(404).json({ success:false, message:"Booking not found." });

      let smsSent = false;
      if (status && triggerSMS!==false) {
        const { config } = await loadConfig(req.shopId);
        let mt = null;
        if (status==="confirmed") mt="confirmed";
        if (status==="cancelled") mt="declined";
        if (status==="no_show")   mt="no_show";
        if (status==="completed") { if(completedSmsVariant==="with_review") mt="completed_review"; else if(completedSmsVariant==="without_review") mt="completed_no_review"; }
        if (mt) {
          const msgBody = buildSmsBody(mt, updated, config);
          if (msgBody) { const log = await sendAndLog(updated._id, updated.phone, mt, msgBody); smsSent = log.status==="sent"; }
        }
      }

      if (req.io) req.io.emit(`booking_updated:${req.shopId}`, { id, booking:updated });
      res.json({ success:true, booking:updated, smsSent });
    } catch (err) { console.error("PATCH /api/bookings/:id:", err); res.status(500).json({ success:false, message:"Server error" }); }
  }
);

// ── DELETE /api/bookings/:id — soft delete ────────────────────────────────────
router.delete("/bookings/:id", adminAuth, [param("id").isMongoId()], handleValidation, async (req, res) => {
  try {
    const updated = await Booking.findOneAndUpdate({ _id:req.params.id, shopId:req.shopId, deleted:{$ne:true} }, { $set:{deleted:true,deletedAt:new Date()} }, { new:true });
    if (!updated) return res.status(404).json({ success:false, message:"Not found" });
    if (req.io) req.io.emit(`booking_deleted:${req.shopId}`, { id:req.params.id });
    res.json({ success:true, message:"Booking moved to Recently Deleted." });
  } catch (err) { res.status(500).json({ success:false, message:"Server error" }); }
});

// ── PATCH /api/bookings/:id/restore ──────────────────────────────────────────
router.patch("/bookings/:id/restore", adminAuth, [param("id").isMongoId()], handleValidation, async (req, res) => {
  try {
    const updated = await Booking.findOneAndUpdate({ _id:req.params.id, shopId:req.shopId, deleted:true }, { $set:{deleted:false,deletedAt:null} }, { new:true });
    if (!updated) return res.status(404).json({ success:false, message:"Not found or not deleted." });
    if (req.io) req.io.emit(`booking_restored:${req.shopId}`, { id:req.params.id, booking:updated });
    res.json({ success:true, message:"Booking restored.", booking:updated });
  } catch (err) { res.status(500).json({ success:false, message:"Server error" }); }
});

// ── POST /api/bookings/:id/sms — manual ──────────────────────────────────────
router.post("/bookings/:id/sms", adminAuth,
  [param("id").isMongoId(), body("messageType").isIn(["confirmed","declined","waitlist","reminder","completed_review","completed_no_review","no_show"])],
  handleValidation,
  async (req, res) => {
    try {
      const booking = await Booking.findOne({ _id:req.params.id, shopId:req.shopId, deleted:{$ne:true} });
      if (!booking) return res.status(404).json({ success:false, message:"Not found" });
      if (!process.env.TWILIO_ACCOUNT_SID) return res.status(503).json({ success:false, message:"Twilio not configured." });
      const { config } = await loadConfig(req.shopId);
      const msgBody = buildSmsBody(req.body.messageType, booking, config);
      if (!msgBody) return res.status(400).json({ success:false, message:"No template for this message type." });
      const log = await sendAndLog(booking._id, booking.phone, req.body.messageType, msgBody);
      res.json({ success:true, message:`SMS ${log.status} to ${booking.phone}`, log });
    } catch (err) { res.status(500).json({ success:false, message:err.message||"SMS failed" }); }
  }
);

// ── GET /api/queue — public ───────────────────────────────────────────────────
router.get("/queue", async (req, res) => {
  try {
    const shopId = req.query.shopId || process.env.DEFAULT_SHOP_ID || "roadstar";
    const { date, bookingId } = req.query;
    if (!date||!bookingId) return res.status(400).json({ success:false, message:"date and bookingId required" });
    const active = await Booking.find({ shopId, date, status:{$in:["pending","confirmed","waitlist"]}, deleted:{$ne:true} }, { time:1, _id:1 }).sort({ time:1 });
    const idx = active.findIndex(b=>b._id.toString()===bookingId);
    if (idx===-1) return res.json({ success:true, position:0, waitMinutes:0, message:"You are next!" });
    res.json({ success:true, position:idx, waitMinutes:idx*40, totalInQueue:active.length, message:idx===0?"You are next!":`${idx} customer${idx>1?"s":""} ahead` });
  } catch (err) { res.status(500).json({ success:false, message:"Server error" }); }
});

async function purgeOldDeletedBookings() {
  try {
    const cutoff = new Date(Date.now() - SOFT_DELETE_DAYS*24*60*60*1000);
    const result = await Booking.deleteMany({ deleted:true, deletedAt:{$lt:cutoff} });
    if (result.deletedCount>0) console.log(`[Cleanup] Purged ${result.deletedCount} bookings`);
  } catch (err) { console.error("[Cleanup] Error:", err.message); }
}

module.exports = router;
module.exports.purgeOldDeletedBookings = purgeOldDeletedBookings;
