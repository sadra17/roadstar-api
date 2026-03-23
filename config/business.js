// ─────────────────────────────────────────────────────────────────────────────
// config/business.js  v7.3
//
// CAPACITY RULES — source of truth:
//
//  resourcePool = "bay"       → 3 shared bays (Tire Change, Flat Repair, Rotation)
//  resourcePool = "alignment" → 1 independent lane (Wheel Alignment ONLY)
//  resourcePool = "none"      → no capacity consumed (Tire Purchase, Other)
//                               ALWAYS available — skips ALL capacity checks
//
//  Only CONFIRMED bookings count toward capacity.
//  PENDING bookings never block any slot.
//  DELETED bookings (deleted:true) are completely invisible to all checks.
//
//  Pool isolation is strict:
//    bay bookings ONLY count against the bay pool
//    alignment bookings ONLY count against the alignment pool
//    they NEVER interfere with each other
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const { DateTime } = require("luxon");

const TZ = "America/Toronto";

// ── Business hours ────────────────────────────────────────────────────────────
// 0=Sun, 1=Mon … 6=Sat. null = closed all day.
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
const RESOURCE_POOLS = {
  bay:       { parallel_capacity: 3, label: "Normal bay" },
  alignment: { parallel_capacity: 1, label: "Alignment lane" },
  none:      { parallel_capacity: Infinity, label: "No bay required" },
};

// ── Service catalog ───────────────────────────────────────────────────────────
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
    service_duration:        10,
    equipment_recovery_time: 0,
    resourcePool:            "none",   // ← NO capacity consumed — always bookable
  },
  "Other": {
    service_duration:        30,
    equipment_recovery_time: 0,
    resourcePool:            "none",   // ← NO capacity consumed — always bookable
  },
};

const ALL_SERVICES  = Object.keys(SERVICE_DEFS);
const SLOT_INTERVAL = 15; // minutes between slot start times

// ─────────────────────────────────────────────────────────────────────────────
// CRITICAL: Only CONFIRMED bookings consume capacity.
// Pending, waitlist, completed, cancelled, and deleted bookings do NOT block slots.
// ─────────────────────────────────────────────────────────────────────────────
const CAPACITY_BLOCKING_STATUS = "confirmed";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function resolveService(serviceName) {
  return SERVICE_DEFS[serviceName] || {
    service_duration:        30,
    equipment_recovery_time: 0,
    resourcePool:            "none",
  };
}

// Use SERVICE_DEFS as authoritative duration source.
// Stored service_duration may be wrong (schema default = 10) for old records.
// Only trust stored value if it's > 10 (explicitly set correctly).
function resolvedDuration(b) {
  const def    = resolveService(b.service || "");
  const stored = b.service_duration;
  if (stored && stored > 10) return stored;
  return def.service_duration;
}

function resolvedOccupation(b) {
  const def = resolveService(b.service || "");
  const rec = (b.equipment_recovery_time !== undefined && b.equipment_recovery_time !== null)
    ? b.equipment_recovery_time
    : def.equipment_recovery_time;
  return resolvedDuration(b) + rec;
}

function effectiveOccupation(def) {
  return def.service_duration + (def.equipment_recovery_time || 0);
}

function poolCapacity(resourcePool, slotOverride) {
  if (slotOverride !== undefined && slotOverride !== null) return slotOverride;
  return RESOURCE_POOLS[resourcePool]?.parallel_capacity ?? Infinity;
}

function getHoursForDate(dateStr) {
  const dt  = DateTime.fromISO(dateStr, { zone: TZ });
  const dow = dt.weekday === 7 ? 0 : dt.weekday;
  return HOURS[dow] ?? null;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function fromMinutes(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

function display12To24(str) {
  if (!str) return null;
  if (/^\d{2}:\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d+):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mn = parseInt(m[2], 10);
  if (m[3].toUpperCase() === "PM" && h !== 12) h += 12;
  if (m[3].toUpperCase() === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${String(mn).padStart(2, "0")}`;
}

function display24To12(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const p   = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, "0")} ${p}`;
}

function generateSlots(dateStr, serviceName) {
  const hours = getHoursForDate(dateStr);
  if (!hours) return [];
  const def    = resolveService(serviceName);
  const occMin = effectiveOccupation(def);
  const openM  = toMinutes(hours.open);
  const closeM = toMinutes(hours.close);
  const last   = closeM - occMin;
  const slots  = [];
  for (let t = openM; t <= last; t += SLOT_INTERVAL) {
    slots.push(display24To12(fromMinutes(t)));
  }
  return slots;
}

// ─────────────────────────────────────────────────────────────────────────────
// occupancyDuring
//
// Counts how many confirmed, non-deleted bookings of a SPECIFIC resource pool
// overlap the proposed time window [newStart, newStart+newOccupation).
//
// Pool isolation is strict:
//   - bay bookings are ONLY counted when checking bay capacity
//   - alignment bookings are ONLY counted when checking alignment capacity
//   - "none" pool bookings are NEVER counted (they don't consume capacity)
//
// This is the single function that enforces capacity — every check goes through here.
// ─────────────────────────────────────────────────────────────────────────────
function occupancyDuring(bookings, newStart24, newOccupation, resourcePool) {
  const ns = toMinutes(newStart24);
  const ne = ns + newOccupation;
  let total = 0;

  for (const b of bookings) {
    // Strict pool match — bay only sees bay, alignment only sees alignment
    if (b.resourcePool !== resourcePool) continue;

    const bs24 = display12To24(b.time) || b.time;
    if (!bs24) continue;

    const bs  = toMinutes(bs24);
    const occ = resolvedOccupation(b);
    const be  = bs + occ;

    // Overlap check: windows intersect if start of one < end of other
    if (ns < be && ne > bs) {
      total += (b.customer_quantity || 1);
    }
  }
  return total;
}

// ─────────────────────────────────────────────────────────────────────────────
// computeAvailability
//
// Returns { available, full, allSlots, businessHours, def, resourcePool, occupation }
//   available — slots that can still be booked
//   full      — slots at capacity (show grayed out to customer)
//   allSlots  — available + full in time order
//
// Rules enforced:
//   1. Only CONFIRMED, non-deleted bookings count toward capacity
//   2. Pool isolation is strict — each pool checks only its own bookings
//   3. "none" pool services bypass ALL capacity checks — always available
//   4. Past times are hidden (today only)
// ─────────────────────────────────────────────────────────────────────────────
async function computeAvailability(dateStr, serviceName, Booking) {
  const def          = resolveService(serviceName);
  const occ          = effectiveOccupation(def);
  const { resourcePool } = def;
  const hours        = getHoursForDate(dateStr);

  if (!hours) {
    return { available: [], full: [], allSlots: [], businessHours: null, def, resourcePool, occupation: occ };
  }

  const candidates = generateSlots(dateStr, serviceName);

  // Short-circuit for no-bay services — they never check capacity
  if (resourcePool === "none") {
    const now     = DateTime.now().setZone(TZ);
    const isToday = dateStr === now.toISODate();
    const nowMins = isToday ? now.hour * 60 + now.minute : -1;
    const allSlots = candidates.filter(s => {
      const s24 = display12To24(s);
      return s24 && !(isToday && toMinutes(s24) <= nowMins);
    });
    return { available: allSlots, full: [], allSlots, businessHours: hours, def, resourcePool, occupation: occ };
  }

  // For bay and alignment: fetch ONLY confirmed, non-deleted bookings for this pool
  // Using exact resourcePool match in the query for maximum efficiency
  const existing = await Booking.find(
    {
      date:         dateStr,
      status:       CAPACITY_BLOCKING_STATUS,   // string "confirmed" — only confirmed count
      resourcePool: resourcePool,               // exact pool match — no cross-pool interference
      deleted:      { $ne: true },              // exclude soft-deleted bookings
    },
    { time: 1, service: 1, service_duration: 1, equipment_recovery_time: 1,
      resourcePool: 1, customer_quantity: 1, _id: 0 }
  ).lean();

  const now     = DateTime.now().setZone(TZ);
  const isToday = dateStr === now.toISODate();
  const nowMins = isToday ? now.hour * 60 + now.minute : -1;
  const cap     = poolCapacity(resourcePool);

  const available = [];
  const full      = [];

  for (const slot12 of candidates) {
    const slot24 = display12To24(slot12);
    if (!slot24) continue;
    if (isToday && toMinutes(slot24) <= nowMins) continue; // past — skip entirely

    const used = occupancyDuring(existing, slot24, occ, resourcePool);
    if (used >= cap) {
      full.push(slot12);      // at capacity — grayed out but visible
    } else {
      available.push(slot12); // open
    }
  }

  // allSlots = time-ordered union of available + full (for UI rendering)
  const allSlots = candidates.filter(s => {
    const s24 = display12To24(s);
    return s24 && !(isToday && toMinutes(s24) <= nowMins);
  });

  return { available, full, allSlots, businessHours: hours, def, resourcePool, occupation: occ };
}

// ─────────────────────────────────────────────────────────────────────────────
// validateCapacity — server-side race-condition guard
//
// Called inside POST /api/book immediately before creating the booking.
// Prevents two customers from booking the last spot simultaneously.
//
// Rules:
//   1. "none" pool → always ok (no capacity check at all)
//   2. Only CONFIRMED, non-deleted bookings in the exact same pool count
//   3. Pending bookings are completely ignored
// ─────────────────────────────────────────────────────────────────────────────
async function validateCapacity(dateStr, slot, serviceName, Booking, excludeId) {
  const def          = resolveService(serviceName);
  const occ          = effectiveOccupation(def);
  const { resourcePool } = def;

  // "none" pool: no capacity check — always allow
  if (resourcePool === "none") return { ok: true };

  const slot24 = display12To24(slot) || slot;
  const cap    = poolCapacity(resourcePool);

  // Query: ONLY confirmed, non-deleted bookings in the exact same resource pool
  const q = {
    date:         dateStr,
    status:       CAPACITY_BLOCKING_STATUS, // "confirmed" only — pending does NOT block
    resourcePool: resourcePool,             // exact pool — bay ≠ alignment
    deleted:      { $ne: true },            // exclude soft-deleted
  };
  if (excludeId) q._id = { $ne: excludeId };

  const existing = await Booking.find(
    q,
    { time: 1, service: 1, service_duration: 1, equipment_recovery_time: 1,
      resourcePool: 1, customer_quantity: 1, _id: 0 }
  ).lean();

  const used = occupancyDuring(existing, slot24, occ, resourcePool);

  if (used >= cap) {
    const noun = resourcePool === "alignment" ? "alignment lane" : "service bay";
    return {
      ok: false,
      reason: `That time is no longer available — the ${noun} is fully booked. Please choose another time.`,
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
  CAPACITY_BLOCKING_STATUS,
  resolveService,
  resolvedDuration,
  resolvedOccupation,
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
