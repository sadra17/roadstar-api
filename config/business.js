// ─────────────────────────────────────────────────────────────────────────────
// config/business.js  v8
// All capacity functions accept optional shopConfig (from buildShopConfig).
// Falls back to hardcoded defaults when shopConfig is null.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const { DateTime } = require("luxon");

const DEFAULT_TZ = "America/Toronto";

const DEFAULT_HOURS = {
  0: null,
  1: { open: "09:00", close: "18:00" },
  2: { open: "09:30", close: "18:00" },
  3: { open: "09:30", close: "18:00" },
  4: { open: "09:30", close: "18:00" },
  5: { open: "09:30", close: "18:00" },
  6: { open: "09:30", close: "16:00" },
};

const DEFAULT_SERVICE_DEFS = {
  "Tire Change + Installation": { service_duration:40, equipment_recovery_time:0, resourcePool:"bay" },
  "Flat Tire Repair":           { service_duration:15, equipment_recovery_time:0, resourcePool:"bay" },
  "Tire Rotation":              { service_duration:20, equipment_recovery_time:0, resourcePool:"bay" },
  "Wheel Alignment":            { service_duration:60, equipment_recovery_time:0, resourcePool:"alignment" },
  "Tire Purchase":              { service_duration:10, equipment_recovery_time:0, resourcePool:"none" },
  "Other":                      { service_duration:30, equipment_recovery_time:0, resourcePool:"none" },
};

const DEFAULT_RESOURCE_POOLS = {
  bay:       { parallel_capacity: 3 },
  alignment: { parallel_capacity: 1 },
  none:      { parallel_capacity: Infinity },
};

const ALL_SERVICES             = Object.keys(DEFAULT_SERVICE_DEFS);
const SLOT_INTERVAL            = 15;
const CAPACITY_BLOCKING_STATUS = "confirmed";

// ── buildShopConfig ────────────────────────────────────────────────────────────
// Converts a ShopSettings mongoose document into the config object
// that all business logic functions expect.
function buildShopConfig(settings) {
  if (!settings) return null;

  const hours = {};
  for (let d = 0; d <= 6; d++) {
    const day = settings.hours?.[d];
    hours[d] = (!day || !day.open || !day.close) ? null : { open: day.open, close: day.close };
  }

  const serviceDefs = {};
  const allServices = [];
  (settings.services || []).filter(s => s.active !== false).forEach(s => {
    serviceDefs[s.name] = {
      service_duration:        s.service_duration,
      equipment_recovery_time: s.equipment_recovery_time || 0,
      resourcePool:            s.resourcePool || "none",
    };
    allServices.push(s.name);
  });

  const resourcePools = {
    bay:       { parallel_capacity: settings.bayCount || 3 },
    alignment: { parallel_capacity: settings.alignmentLaneEnabled !== false ? (settings.alignmentCapacity || 1) : 0 },
    none:      { parallel_capacity: Infinity },
  };

  return {
    tz:           settings.timezone || DEFAULT_TZ,
    hours,
    serviceDefs,
    allServices,
    resourcePools,
    blackoutDates: settings.blackoutDates || [],
    shopName:      settings.shopName || "Shop",
    googleReviewLink: settings.googleReviewLink || "",
    smsTemplates:  settings.smsTemplates || {},
    reminderEnabled: settings.reminderEnabled !== false,
    reminderMinutes: settings.reminderMinutes || 30,
  };
}

// ── SMS template renderer ──────────────────────────────────────────────────────
// Replaces {firstName}, {shopName}, {date}, {time}, {service}, {reviewLink}
function renderSmsTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? "");
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getHoursForDate(dateStr, shopConfig) {
  const hoursMap = shopConfig?.hours ?? DEFAULT_HOURS;
  const tz       = shopConfig?.tz ?? DEFAULT_TZ;
  const dt  = DateTime.fromISO(dateStr, { zone: tz });
  const dow = dt.weekday === 7 ? 0 : dt.weekday;
  return hoursMap[dow] ?? null;
}

function resolveService(serviceName, shopConfig) {
  const defs = shopConfig?.serviceDefs ?? DEFAULT_SERVICE_DEFS;
  return defs[serviceName] || { service_duration:30, equipment_recovery_time:0, resourcePool:"none" };
}

function poolCapacity(resourcePool, shopConfig, slotOverride) {
  if (slotOverride !== undefined && slotOverride !== null) return slotOverride;
  const pools = shopConfig?.resourcePools ?? DEFAULT_RESOURCE_POOLS;
  return pools[resourcePool]?.parallel_capacity ?? Infinity;
}

function resolvedDuration(b, shopConfig) {
  const def    = resolveService(b.service || "", shopConfig);
  const stored = b.service_duration;
  if (stored && stored > 10) return stored;
  return def.service_duration;
}

function resolvedOccupation(b, shopConfig) {
  const def = resolveService(b.service || "", shopConfig);
  const rec = (b.equipment_recovery_time !== undefined && b.equipment_recovery_time !== null)
    ? b.equipment_recovery_time : def.equipment_recovery_time;
  return resolvedDuration(b, shopConfig) + rec;
}

function effectiveOccupation(def) {
  return def.service_duration + (def.equipment_recovery_time || 0);
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function fromMinutes(mins) {
  return `${String(Math.floor(mins/60)).padStart(2,"0")}:${String(mins%60).padStart(2,"0")}`;
}

function display12To24(str) {
  if (!str) return null;
  if (/^\d{2}:\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d+):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = parseInt(m[1],10);
  const mn = parseInt(m[2],10);
  if (m[3].toUpperCase()==="PM" && h!==12) h+=12;
  if (m[3].toUpperCase()==="AM" && h===12) h=0;
  return `${String(h).padStart(2,"0")}:${String(mn).padStart(2,"0")}`;
}

function display24To12(hhmm) {
  const [h,m] = hhmm.split(":").map(Number);
  const p   = h>=12?"PM":"AM";
  const h12 = h===0?12:h>12?h-12:h;
  return `${h12}:${String(m).padStart(2,"0")} ${p}`;
}

function generateSlots(dateStr, serviceName, shopConfig) {
  const hours  = getHoursForDate(dateStr, shopConfig);
  if (!hours) return [];
  const def    = resolveService(serviceName, shopConfig);
  const occMin = effectiveOccupation(def);
  const openM  = toMinutes(hours.open);
  const closeM = toMinutes(hours.close);
  const last   = closeM - occMin;
  const slots  = [];
  for (let t=openM; t<=last; t+=SLOT_INTERVAL) slots.push(display24To12(fromMinutes(t)));
  return slots;
}

function occupancyDuring(bookings, newStart24, newOccupation, resourcePool, shopConfig) {
  const ns = toMinutes(newStart24);
  const ne = ns + newOccupation;
  let total = 0;
  for (const b of bookings) {
    if (b.resourcePool !== resourcePool) continue;
    const bs24 = display12To24(b.time) || b.time;
    if (!bs24) continue;
    const bs  = toMinutes(bs24);
    const occ = resolvedOccupation(b, shopConfig);
    const be  = bs + occ;
    if (ns < be && ne > bs) total += (b.customer_quantity || 1);
  }
  return total;
}

// ── computeAvailability ────────────────────────────────────────────────────────
async function computeAvailability(dateStr, serviceName, Booking, shopId, shopConfig) {
  const def          = resolveService(serviceName, shopConfig);
  const occ          = effectiveOccupation(def);
  const { resourcePool } = def;
  const tz           = shopConfig?.tz ?? DEFAULT_TZ;

  // Blackout date → fully closed
  if ((shopConfig?.blackoutDates ?? []).includes(dateStr)) {
    return { available:[], full:[], allSlots:[], businessHours:null, def, resourcePool, occupation:occ, blackout:true };
  }

  const hours = getHoursForDate(dateStr, shopConfig);
  if (!hours) {
    return { available:[], full:[], allSlots:[], businessHours:null, def, resourcePool, occupation:occ };
  }

  const candidates = generateSlots(dateStr, serviceName, shopConfig);

  // No-bay services: always available (no capacity check)
  if (resourcePool === "none") {
    const now     = DateTime.now().setZone(tz);
    const isToday = dateStr === now.toISODate();
    const nowMins = isToday ? now.hour*60+now.minute : -1;
    const allSlots = candidates.filter(s => {
      const s24 = display12To24(s);
      return s24 && !(isToday && toMinutes(s24) <= nowMins);
    });
    return { available:allSlots, full:[], allSlots, businessHours:hours, def, resourcePool, occupation:occ };
  }

  const existing = await Booking.find(
    { shopId, date:dateStr, status:CAPACITY_BLOCKING_STATUS, resourcePool, deleted:{$ne:true} },
    { time:1, service:1, service_duration:1, equipment_recovery_time:1, resourcePool:1, customer_quantity:1, _id:0 }
  ).lean();

  const now     = DateTime.now().setZone(tz);
  const isToday = dateStr === now.toISODate();
  const nowMins = isToday ? now.hour*60+now.minute : -1;
  const cap     = poolCapacity(resourcePool, shopConfig);

  const available = [];
  const full      = [];

  for (const slot12 of candidates) {
    const slot24 = display12To24(slot12);
    if (!slot24) continue;
    if (isToday && toMinutes(slot24) <= nowMins) continue;
    const used = occupancyDuring(existing, slot24, occ, resourcePool, shopConfig);
    used >= cap ? full.push(slot12) : available.push(slot12);
  }

  const allSlots = candidates.filter(s => {
    const s24 = display12To24(s);
    return s24 && !(isToday && toMinutes(s24) <= nowMins);
  });

  return { available, full, allSlots, businessHours:hours, def, resourcePool, occupation:occ };
}

// ── validateCapacity ───────────────────────────────────────────────────────────
async function validateCapacity(dateStr, slot, serviceName, Booking, shopId, excludeId, shopConfig) {
  const def          = resolveService(serviceName, shopConfig);
  const occ          = effectiveOccupation(def);
  const { resourcePool } = def;
  if (resourcePool === "none") return { ok:true };

  const slot24 = display12To24(slot) || slot;
  const cap    = poolCapacity(resourcePool, shopConfig);

  const q = { shopId, date:dateStr, status:CAPACITY_BLOCKING_STATUS, resourcePool, deleted:{$ne:true} };
  if (excludeId) q._id = { $ne: excludeId };

  const existing = await Booking.find(
    q,
    { time:1, service:1, service_duration:1, equipment_recovery_time:1, resourcePool:1, customer_quantity:1, _id:0 }
  ).lean();

  const used = occupancyDuring(existing, slot24, occ, resourcePool, shopConfig);
  if (used >= cap) {
    const noun = resourcePool==="alignment" ? "alignment lane" : "service bay";
    return { ok:false, reason:`That time is no longer available — the ${noun} is fully booked. Please choose another time.` };
  }
  return { ok:true };
}

module.exports = {
  DEFAULT_TZ, DEFAULT_HOURS, DEFAULT_SERVICE_DEFS, DEFAULT_RESOURCE_POOLS,
  ALL_SERVICES, SLOT_INTERVAL, CAPACITY_BLOCKING_STATUS,
  buildShopConfig, renderSmsTemplate,
  resolveService, resolvedDuration, resolvedOccupation, effectiveOccupation,
  poolCapacity, getHoursForDate, toMinutes, fromMinutes,
  display12To24, display24To12, generateSlots, occupancyDuring,
  computeAvailability, validateCapacity,
};
