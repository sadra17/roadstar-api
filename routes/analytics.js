// routes/analytics.js  v9-supabase
"use strict";

const express = require("express");
const router  = express.Router();
const sb      = require("../config/supabase");
const adminAuth = require("../middleware/adminAuth");
const { requirePermission } = require("../middleware/adminAuth");

const { isRealDate } = require("../config/business");

// Shop-local dates: the server runs in UTC, but the shop is open past 8 PM Toronto time.
function dateRange(from, to) {
  const now = require("luxon").DateTime.now().setZone("America/Toronto");
  const f = from || now.minus({ days: 30 }).toISODate();
  const t = to || now.toISODate();
  return { from: f, to: t };
}

// Validates ?from/?to (each optional, a single real YYYY-MM-DD date, from ≤ to).
// Sends a 400 and returns null when they're invalid.
function rangeOr400(req, res) {
  const { from, to } = req.query;
  for (const v of [from, to]) {
    if (v !== undefined && v !== "" && (typeof v !== "string" || !isRealDate(v))) {
      res.status(400).json({ success: false, message: "Dates must be real calendar dates in YYYY-MM-DD format." });
      return null;
    }
  }
  const range = dateRange(from || undefined, to || undefined);
  if (range.from > range.to) {
    res.status(400).json({ success: false, message: "The start date must be on or before the end date." });
    return null;
  }
  return range;
}

// Bookings in the date range, paged past Supabase's 1000-row limit. Throws on a
// database error (so it's a 500, not a silent "no business" result of zeros).
async function bookingsInRange(shopId, cols, from, to) {
  const out = [];
  for (let start = 0; ; start += 1000) {
    const { data, error } = await sb.from("bookings").select(cols)
      .eq("shop_id", shopId).eq("deleted", false)
      .gte("date", from).lte("date", to)
      .order("id", { ascending: true }).range(start, start + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// ── GET /api/analytics/summary ────────────────────────────────────────────────
router.get("/analytics/summary", adminAuth, requirePermission("view:analytics"), async (req, res) => {
  try {
    const range = rangeOr400(req, res); if (!range) return;
    const { from, to } = range;
    const shopId = req.shopId;

    // All bookings in range
    const all = await bookingsInRange(shopId, "status, final_price, payment_status", from, to);

    const totals = { all:0, confirmed:0, pending:0, completed:0, cancelled:0, no_show:0, waitlist:0 };
    let totalRevenue=0, paidCount=0;
    for (const b of (all||[])) {
      totals.all++;
      if (totals[b.status]!==undefined) totals[b.status]++;
      if (b.payment_status==="paid" && b.final_price) { totalRevenue+=b.final_price; paidCount++; }
    }

    res.json({
      success: true,
      period: { from, to },
      totals,
      revenue: {
        total:     Math.round(totalRevenue*100)/100,
        paidCount,
        avgTicket: paidCount>0 ? Math.round((totalRevenue/paidCount)*100)/100 : 0,
      },
    });
  } catch (err) {
    console.error("analytics/summary:", err);
    res.status(500).json({ success:false, message:"Server error" });
  }
});

// ── GET /api/analytics/by-day ─────────────────────────────────────────────────
router.get("/analytics/by-day", adminAuth, requirePermission("view:analytics"), async (req, res) => {
  try {
    const range = rangeOr400(req, res); if (!range) return;
    const { from, to } = range;
    const data = await bookingsInRange(req.shopId, "date, status, final_price, payment_status", from, to);

    const byDay = {};
    for (const b of (data||[])) {
      if (!byDay[b.date]) byDay[b.date] = { date:b.date, bookings:0, completed:0, revenue:0, noShows:0 };
      const d = byDay[b.date];
      d.bookings++;
      if (b.status==="completed") d.completed++;
      if (b.status==="no_show") d.noShows++;
      if (b.payment_status==="paid"&&b.final_price) d.revenue+=b.final_price;
    }

    const days = Object.values(byDay).sort((a,b)=>a.date.localeCompare(b.date)).map(d=>({...d,revenue:Math.round(d.revenue*100)/100}));
    res.json({ success:true, days });
  } catch (err) { console.error("analytics/by-day:", err); res.status(500).json({ success:false, message:"Server error" }); }
});

// ── GET /api/analytics/by-service ────────────────────────────────────────────
router.get("/analytics/by-service", adminAuth, requirePermission("view:analytics"), async (req, res) => {
  try {
    const range = rangeOr400(req, res); if (!range) return;
    const { from, to } = range;
    const data = await bookingsInRange(req.shopId, "service, status, final_price, payment_status", from, to);

    const bySvc = {};
    for (const b of (data||[])) {
      if (!bySvc[b.service]) bySvc[b.service] = { service:b.service, count:0, completed:0, revenue:0 };
      const s = bySvc[b.service];
      s.count++;
      if (b.status==="completed") s.completed++;
      if (b.payment_status==="paid"&&b.final_price) s.revenue+=b.final_price;
    }

    const services = Object.values(bySvc).sort((a,b)=>b.count-a.count).map(s=>({...s,revenue:Math.round(s.revenue*100)/100}));
    res.json({ success:true, services });
  } catch (err) { console.error("analytics/by-service:", err); res.status(500).json({ success:false, message:"Server error" }); }
});

// ── GET /api/analytics/by-payment ────────────────────────────────────────────
router.get("/analytics/by-payment", adminAuth, requirePermission("view:revenue"), async (req, res) => {
  try {
    const range = rangeOr400(req, res); if (!range) return;
    const { from, to } = range;
    const data = await bookingsInRange(req.shopId, "status, payment_method, payment_status, final_price", from, to);

    // Methods = payments actually received (same rule as revenue: paid with a price).
    // Unpaid warning = completed jobs with no payment recorded — not pending,
    // confirmed or cancelled bookings, which are simply "unpaid" by default.
    const byMethod = {};
    let unpaidCompleted=0;
    for (const b of (data||[])) {
      if (b.status==="completed" && (!b.payment_status || b.payment_status==="unpaid")) unpaidCompleted++;
      if (b.payment_status!=="paid" || !b.final_price) continue;
      const m = b.payment_method||"unknown";
      if (!byMethod[m]) byMethod[m] = { method:m, count:0, total:0 };
      byMethod[m].count++;
      byMethod[m].total+=Number(b.final_price);
    }

    res.json({ success:true, byMethod:Object.values(byMethod).map(m=>({...m,total:Math.round(m.total*100)/100})), unpaidCompleted });
  } catch (err) { console.error("analytics/by-payment:", err); res.status(500).json({ success:false, message:"Server error" }); }
});

module.exports = router;
