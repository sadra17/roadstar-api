// routes/analytics.js  v9-supabase
"use strict";

const express = require("express");
const router  = express.Router();
const sb      = require("../config/supabase");
const adminAuth = require("../middleware/adminAuth");
const { requirePermission } = require("../middleware/adminAuth");

function dateRange(from, to) {
  const f = from || (() => { const d=new Date(); d.setDate(d.getDate()-30); return d.toISOString().slice(0,10); })();
  const t = to || new Date().toISOString().slice(0,10);
  return { from: f, to: t };
}

// ── GET /api/analytics/summary ────────────────────────────────────────────────
router.get("/analytics/summary", adminAuth, requirePermission("view:analytics"), async (req, res) => {
  try {
    const { from, to } = dateRange(req.query.from, req.query.to);
    const shopId = req.shopId;

    // All bookings in range
    const { data: all } = await sb.from("bookings")
      .select("status, final_price, payment_status")
      .eq("shop_id", shopId).eq("deleted", false)
      .gte("date", from).lte("date", to);

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
    const { from, to } = dateRange(req.query.from, req.query.to);
    const { data } = await sb.from("bookings")
      .select("date, status, final_price, payment_status")
      .eq("shop_id", req.shopId).eq("deleted", false)
      .gte("date", from).lte("date", to);

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
  } catch (err) { res.status(500).json({ success:false, message:"Server error" }); }
});

// ── GET /api/analytics/by-service ────────────────────────────────────────────
router.get("/analytics/by-service", adminAuth, requirePermission("view:analytics"), async (req, res) => {
  try {
    const { from, to } = dateRange(req.query.from, req.query.to);
    const { data } = await sb.from("bookings")
      .select("service, status, final_price, payment_status")
      .eq("shop_id", req.shopId).eq("deleted", false)
      .gte("date", from).lte("date", to);

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
  } catch (err) { res.status(500).json({ success:false, message:"Server error" }); }
});

// ── GET /api/analytics/by-payment ────────────────────────────────────────────
router.get("/analytics/by-payment", adminAuth, requirePermission("view:revenue"), async (req, res) => {
  try {
    const { from, to } = dateRange(req.query.from, req.query.to);
    const { data } = await sb.from("bookings")
      .select("payment_method, payment_status, final_price")
      .eq("shop_id", req.shopId).eq("deleted", false)
      .not("payment_status","is",null)
      .gte("date", from).lte("date", to);

    const byMethod = {};
    let unpaidCompleted=0;
    for (const b of (data||[])) {
      const m = b.payment_method||"unknown";
      if (!byMethod[m]) byMethod[m] = { method:m, count:0, total:0 };
      byMethod[m].count++;
      if (b.final_price) byMethod[m].total+=b.final_price;
      if (b.payment_status==="unpaid") unpaidCompleted++;
    }

    res.json({ success:true, byMethod:Object.values(byMethod).map(m=>({...m,total:Math.round(m.total*100)/100})), unpaidCompleted });
  } catch (err) { res.status(500).json({ success:false, message:"Server error" }); }
});

module.exports = router;
