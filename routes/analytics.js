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

// ── Shopify-style overview: any date range, compared with the previous period ──
const TZ = "America/Toronto";
const r2 = n => Math.round(n * 100) / 100;
const digits = p => String(p || "").replace(/\D/g, "").slice(-10);

// Every booking for the shop (paged past Supabase's 1000-row limit), only the columns we need.
async function allBookings(shopId) {
  const cols = "date, status, final_price, payment_status, payment_method, service, service_mode, storage_opt_in, storage_price, phone, source";
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("bookings").select(cols)
      .eq("shop_id", shopId).eq("deleted", false)
      .order("date", { ascending: true }).order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

function summarize(rows, firstSeen, from, to) {
  const m = { bookings: 0, completed: 0, cancelled: 0, noShows: 0, pending: 0, confirmed: 0,
    revenue: 0, paidCount: 0, unpaidCompleted: 0, storageSignups: 0, storageValue: 0,
    instore: { bookings: 0, revenue: 0 }, mobile: { bookings: 0, revenue: 0 },
    online: 0, walkin: 0, customers: 0, newCustomers: 0, returningCustomers: 0 };
  const seen = new Set();
  for (const b of rows) {
    m.bookings++;
    if (b.status === "completed") m.completed++;
    if (b.status === "cancelled") m.cancelled++;
    if (b.status === "no_show") m.noShows++;
    if (b.status === "pending") m.pending++;
    if (b.status === "confirmed") m.confirmed++;
    const paid = b.payment_status === "paid" && b.final_price ? Number(b.final_price) : 0;
    if (paid) { m.revenue += paid; m.paidCount++; }
    if (b.status === "completed" && b.payment_status !== "paid") m.unpaidCompleted++;
    if (b.storage_opt_in && b.status !== "cancelled") { m.storageSignups++; m.storageValue += Number(b.storage_price) || 0; }
    const mode = b.service_mode === "mobile" ? "mobile" : "instore";
    m[mode].bookings++; m[mode].revenue += paid;
    if (b.source === "walkin") m.walkin++; else m.online++;
    const key = digits(b.phone);
    if (key && !seen.has(key)) {
      seen.add(key); m.customers++;
      (firstSeen.get(key) >= from ? m.newCustomers++ : m.returningCustomers++);
    }
  }
  m.revenue = r2(m.revenue); m.storageValue = r2(m.storageValue);
  m.instore.revenue = r2(m.instore.revenue); m.mobile.revenue = r2(m.mobile.revenue);
  m.avgTicket = m.paidCount ? r2(m.revenue / m.paidCount) : 0;
  const closed = m.completed + m.noShows;
  m.noShowRate = closed ? r2(m.noShows / closed * 100) : 0;
  m.cancelRate = m.bookings ? r2(m.cancelled / m.bookings * 100) : 0;
  return m;
}

// Group the range into day / week / month buckets depending on its length (like Shopify).
function series(rows, from, to) {
  const { DateTime } = require("luxon");
  const start = DateTime.fromISO(from, { zone: TZ }), end = DateTime.fromISO(to, { zone: TZ });
  const span = end.diff(start, "days").days + 1;
  const unit = span <= 62 ? "day" : span <= 400 ? "week" : "month";
  const keyOf = d => DateTime.fromISO(d, { zone: TZ }).startOf(unit).toISODate();
  const buckets = new Map();
  for (let d = start.startOf(unit); d <= end; d = d.plus({ [unit + "s"]: 1 })) {
    buckets.set(d.toISODate(), { date: d.toISODate(), bookings: 0, completed: 0, revenue: 0 });
  }
  for (const b of rows) {
    const k = buckets.get(keyOf(b.date)); if (!k) continue;
    k.bookings++; if (b.status === "completed") k.completed++;
    if (b.payment_status === "paid" && b.final_price) k.revenue += Number(b.final_price);
  }
  return { unit, points: [...buckets.values()].map(p => ({ ...p, revenue: r2(p.revenue) })) };
}

function breakdowns(rows) {
  const svc = {}, pay = {};
  for (const b of rows) {
    const paid = b.payment_status === "paid" && b.final_price ? Number(b.final_price) : 0;
    const s = svc[b.service] ||= { service: b.service, count: 0, completed: 0, revenue: 0 };
    s.count++; if (b.status === "completed") s.completed++; s.revenue += paid;
    if (paid) { const k = b.payment_method || "unknown"; const p = pay[k] ||= { method: k, count: 0, total: 0 }; p.count++; p.total += paid; }
  }
  return {
    services: Object.values(svc).map(s => ({ ...s, revenue: r2(s.revenue) })).sort((a, b) => b.revenue - a.revenue || b.count - a.count),
    payments: Object.values(pay).map(p => ({ ...p, total: r2(p.total) })).sort((a, b) => b.total - a.total),
  };
}

// Longest range the overview will chart (~25 years) — keeps the series bounded.
const MAX_RANGE_DAYS = 9200;

router.get("/analytics/overview", adminAuth, requirePermission("view:analytics"), async (req, res) => {
  try {
    const { DateTime } = require("luxon");
    // Only rows with a real YYYY-MM-DD date count. A corrupt date (e.g. '["2026-11-03"]')
    // would otherwise sort first, become "since we opened" and break the date maths.
    const all = (await allBookings(req.shopId)).filter(b => isRealDate(b.date));
    const today = DateTime.now().setZone(TZ).toISODate();
    const firstDate = all.length ? all[0].date : today;

    // from/to: a real calendar date, "all" (from only), or left out for the default range
    const qFrom = typeof req.query.from === "string" ? req.query.from : undefined;
    const qTo   = typeof req.query.to   === "string" ? req.query.to   : undefined;
    if ((qFrom && qFrom !== "all" && !isRealDate(qFrom)) || (qTo && !isRealDate(qTo))) {
      return res.status(400).json({ success: false, message: "Dates must be real calendar dates in YYYY-MM-DD format." });
    }
    let from = qFrom && qFrom !== "all" ? qFrom : DateTime.now().setZone(TZ).minus({ days: 29 }).toISODate();
    let to   = qTo || today;
    if (qFrom === "all") from = firstDate < to ? firstDate : to;
    if (from > to) [from, to] = [to, from];
    if (DateTime.fromISO(to).diff(DateTime.fromISO(from), "days").days + 1 > MAX_RANGE_DAYS) {
      return res.status(400).json({ success: false, message: "That date range is too long. Please pick a shorter range." });
    }

    // First time we ever saw each customer (by phone digits) → new vs returning
    const firstSeen = new Map();
    for (const b of all) { const k = digits(b.phone); if (k && !firstSeen.has(k)) firstSeen.set(k, b.date); }

    const inRange = all.filter(b => b.date >= from && b.date <= to);
    const current = summarize(inRange, firstSeen, from, to);

    // Previous period of equal length, immediately before
    let previous = null, prevRange = null;
    if (req.query.compare !== "0") {
      const f = DateTime.fromISO(from, { zone: TZ }), t = DateTime.fromISO(to, { zone: TZ });
      const days = Math.round(t.diff(f, "days").days) + 1;
      const pTo = f.minus({ days: 1 }).toISODate(), pFrom = f.minus({ days }).toISODate();
      prevRange = { from: pFrom, to: pTo };
      previous = summarize(all.filter(b => b.date >= pFrom && b.date <= pTo), firstSeen, pFrom, pTo);
    }

    res.json({ success: true, range: { from, to }, previousRange: prevRange, firstDate, today,
      current, previous, series: series(inRange, from, to), ...breakdowns(inRange) });
  } catch (err) {
    console.error("analytics/overview:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
