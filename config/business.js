// ─────────────────────────────────────────────────────────────────────────────
// config/business.js  v7
//
// Core scheduling parameters:
//   parallel_capacity      – how many simultaneous bookings a pool accepts
//   service_duration       – how long the service takes (minutes)
//   equipment_recovery_time – cooldown after service before next booking (minutes)
//   customer_quantity      – how many capacity units one booking consumes (default 1)
//
// effective_occupation = service_duration + equipment_recovery_time
// remaining_capacity   = parallel_capacity − Σ(customer_quantity of overlapping confirmed bookings)
// slot available when  remaining_capacity ≥ requested_quantity (always 1 from UI)
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const { DateTime } = require("luxon");

// ── Timezone ──────────────────────────────────────────────────────────────────
const TZ = "America/Toronto";

// ── Business hours ────────────────────────────────────────────────────────────
// 0=Sun, 1=Mon … 6=Sat. null = closed.
const HOURS = {
  0: null,
  1: { open: "09:00", close: "18:00" },
  2: { open: "09:30", close: "18:00" },
  3: { open: "09:30", close: "18:00" },
  4: { open: "09:30", close: "18:00" },
  5: { open: "09:30", close: "18:00" },
  6: { open: "09:30", close: "16:00" },
};

// ── Resource pools ────────────────────────────────────────────────────────────
// resourcePool drives which capacity bucket a booking consumes.
// "bay"       → shared normal bay pool (3 jacks)
// "alignment" → independent alignment lane (1)
// "none"      → no capacity consumed; always bookable
const RESOURCE_POOLS = {
  bay: {
    parallel_capacity: 3,   // global default; can be overridden per slot
    label: "Normal bay",
  },
  alignment: {
    parallel_capacity: 1,
    label: "Alignment lane",
  },
  none: {
    parallel_capacity: Infinity,
    label: "No bay required",
  },
};

// ── Service definitions ───────────────────────────────────────────────────────
// service_duration         – minutes of actual work
// equipment_recovery_time  – minutes the bay must rest before next booking
// resourcePool             – which pool this service draws from
const SERVICE_DEFS = {
  "Tire Change + Installation": {
    service_duration:        40,
    equipment_recovery_time: 0,
    resourcePool:            "bay",
  },
  "Flat Tire Repair": {
    service_duration:        15,
    equipment_recovery_time: 0,
    resourcePool:            "bay",
  },
  "Tire Rotation": {
    service_duration:        20,
    equipment_recovery_time: 0,
    resourcePool:            "bay",
  },
  "Wheel Alignment": {
    service_duration:        60,
    equipment_recovery_time: 0,
    resourcePool:            "alignment",
  },
  "Tire Purchase": {
    service_duration:        10,   // short display duration; no capacity consumed
    equipment_recovery_time: 0,
    resourcePool:            "none",
  },
  "Other": {
    service_duration:        30,   // admin-safe default; configurable
    equipment_recovery_time: 0,
    resourcePool:            "none", // default non-bay; staff can change later
  },
};

const ALL_SERVICES  = Object.keys(SERVICE_DEFS);
const SLOT_INTERVAL = 15; // minutes between candidate slot starts

// ── Blocking statuses ─────────────────────────────────────────────────────────
// Only confirmed bookings consume capacity.
// Pending does NOT lock slots (Option A — confirmed-only blocking).
const CAPACITY_BLOCKING_STATUSES = ["confirmed"];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Returns service def (with fallback for unknown/custom). */
function resolveService(serviceName) {
  return SERVICE_DEFS[serviceName] || {
    service_duration:        30,
    equipment_recovery_time: 0,
    resourcePool:            "none",
  };
}

/** Effective occupation in minutes: duration + recovery. */
function effectiveOccupation(def) {
  return def.service_duration + (def.equipment_recovery_time || 0);
}

/** Pool parallel_capacity (accounting for per-slot override). */
function poolCapacity(resourcePool, slotOverride) {
  if (slotOverride !== undefined && slotOverride !== null) return slotOverride;
  return RESOURCE_POOLS[resourcePool]?.parallel_capacity ?? Infinity;
}

/** Returns business hours { open, close } | null for "YYYY-MM-DD". */
function getHoursForDate(dateStr) {
  const dt  = DateTime.fromISO(dateStr, { zone: TZ });
  const dow = dt.weekday === 7 ? 0 : dt.weekday; // luxon 1=Mon,7=Sun → JS 0=Sun
  return HOURS[dow] ?? null;
}

/** "HH:MM" → minutes since midnight */
function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** minutes → "HH:MM" */
function fromMinutes(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2,"0")}:${String(mins % 60).padStart(2,"0")}`;
}

/** "9:00 AM" or "HH:MM" → "HH:MM" */
function display12To24(str) {
  if (!str) return null;
  if (/^\d{2}:\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d+):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mn = parseInt(m[2], 10);
  if (m[3].toUpperCase() === "PM" && h !== 12) h += 12;
  if (m[3].toUpperCase() === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2,"0")}:${String(mn).padStart(2,"0")}`;
}

/** "HH:MM" → "9:00 AM" */
function display24To12(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const p   = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2,"0")} ${p}`;
}

/**
 * Generate all candidate slot start times for a service on a date.
 * A slot is valid only if the effective_occupation fits before closing time.
 * Returns 12-hour display strings.
 */
function generateSlots(dateStr, serviceName) {
  const hours = getHoursForDate(dateStr);
  if (!hours) return [];
  const def     = resolveService(serviceName);
  const occMin  = effectiveOccupation(def);
  const openM   = toMinutes(hours.open);
  const closeM  = toMinutes(hours.close);
  const last    = closeM - occMin;
  const slots   = [];
  for (let t = openM; t <= last; t += SLOT_INTERVAL) {
    slots.push(display24To12(fromMinutes(t)));
  }
  return slots;
}

/**
 * Count capacity consumed by existing confirmed bookings that overlap
 * the proposed [newStart, newStart + occupation).
 *
 * Each booking contributes its customer_quantity (default 1).
 */
function occupancyDuring(bookings, newStart24, newOccupation, resourcePool) {
  const ns = toMinutes(newStart24);
  const ne = ns + newOccupation;
  let total = 0;
  for (const b of bookings) {
    if (b.resourcePool !== resourcePool) continue;
    const bs24 = display12To24(b.time) || b.time;
    const bs   = toMinutes(bs24);
    const occ  = (b.service_duration || 10) + (b.equipment_recovery_time || 0);
    const be   = bs + occ;
    if (ns < be && ne > bs) {
      total += (b.customer_quantity || 1);
    }
  }
  return total;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main availability engine
// ─────────────────────────────────────────────────────────────────────────────
async function computeAvailability(dateStr, serviceName, Booking) {
  const def          = resolveService(serviceName);
  const occ          = effectiveOccupation(def);
  const { resourcePool } = def;
  const hours        = getHoursForDate(dateStr);

  if (!hours) return { available: [], businessHours: null, def };

  const candidates = generateSlots(dateStr, serviceName);

  // Fetch confirmed bookings for this date that consume capacity
  const existing = await Booking.find(
    {
      date:         dateStr,
      status:       { $in: CAPACITY_BLOCKING_STATUSES },
      resourcePool: { $ne: "none" },
    },
    { time: 1, service_duration: 1, equipment_recovery_time: 1,
      resourcePool: 1, customer_quantity: 1, _id: 0 }
  ).lean();

  // Strip past times for today (Toronto clock)
  const now      = DateTime.now().setZone(TZ);
  const isToday  = dateStr === now.toISODate();
  const nowMins  = isToday ? now.hour * 60 + now.minute : -1;

  const cap     = poolCapacity(resourcePool); // no per-slot override at this layer
  const avail   = [];

  for (const slot12 of candidates) {
    const slot24 = display12To24(slot12);
    if (!slot24) continue;
    if (isToday && toMinutes(slot24) <= nowMins) continue;

    if (resourcePool !== "none") {
      const used = occupancyDuring(existing, slot24, occ, resourcePool);
      if (used >= cap) continue; // full → skip
    }
    avail.push(slot12);
  }

  return { available: avail, businessHours: hours, def, resourcePool, occupation: occ };
}

// ─────────────────────────────────────────────────────────────────────────────
// Server-side capacity validation (race-condition guard)
// ─────────────────────────────────────────────────────────────────────────────
async function validateCapacity(dateStr, slot, serviceName, Booking, excludeId) {
  const def          = resolveService(serviceName);
  const occ          = effectiveOccupation(def);
  const { resourcePool } = def;

  if (resourcePool === "none") return { ok: true };

  const slot24 = display12To24(slot) || slot;
  const cap    = poolCapacity(resourcePool);

  const q = {
    date:         dateStr,
    status:       { $in: CAPACITY_BLOCKING_STATUSES },
    resourcePool: resourcePool,
  };
  if (excludeId) q._id = { $ne: excludeId };

  const existing = await Booking.find(
    q,
    { time: 1, service_duration: 1, equipment_recovery_time: 1,
      resourcePool: 1, customer_quantity: 1, _id: 0 }
  ).lean();

  const used = occupancyDuring(existing, slot24, occ, resourcePool);
  if (used >= cap) {
    const noun = resourcePool === "alignment" ? "alignment lane" : "service bay";
    return {
      ok: false,
      reason: `That time is no longer available — the ${noun} is fully booked during that window. Please choose another time.`,
    };
  }
  return { ok: true };
}

module.exports = {
  TZ,
  HOURS,
  RESOURCE_POOLS,
  SERVICE_DEFS,
  ALL_SERVICES,
  SLOT_INTERVAL,
  CAPACITY_BLOCKING_STATUSES,
  resolveService,
  effectiveOccupation,
  poolCapacity,
  getHoursForDate,
  toMinutes,
  fromMinutes,
  display12To24,
  display24To12,
  generateSlots,
  occupancyDuring,
  computeAvailability,
  validateCapacity,
};
