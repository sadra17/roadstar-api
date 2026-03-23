// ─────────────────────────────────────────────────────────────────────────────
// config/business.js  v7.2
//
// Capacity model:
//   effective_occupation = service_duration + equipment_recovery_time
//   remaining_capacity   = pool.parallel_capacity − Σ(customer_quantity of confirmed overlapping)
//   slot FULL when remaining < 1
//
// Two resource pools:
//   "bay"       → 3-bay shared normal pool (Tire Change, Flat Repair, Rotation)
//   "alignment" → 1-lane independent pool (Wheel Alignment only)
//   "none"      → no capacity consumed (Tire Purchase, Other)
//
// Key fix v7.2:
//   computeAvailability now returns { available, full, allSlots, businessHours }
//   Full slots are returned so the UI can show them grayed-out (not hidden).
//   occupancyDuring always resolves duration from SERVICE_DEFS as authoritative source,
//   falling back to stored value only if stored is > 10 (i.e. was correctly saved).
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const { DateTime } = require("luxon");

const TZ = "America/Toronto";

// ── Business hours ────────────────────────────────────────────────────────────
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
    resourcePool:            "alignment",  // INDEPENDENT — never shares with bay pool
  },
  "Tire Purchase": {
    service_duration:        10,
    equipment_recovery_time: 0,
    resourcePool:            "none",
  },
  "Other": {
    service_duration:        30,
    equipment_recovery_time: 0,
    resourcePool:            "none",
  },
};

const ALL_SERVICES  = Object.keys(SERVICE_DEFS);
const SLOT_INTERVAL = 15; // minutes

// Only confirmed bookings consume capacity.
const CAPACITY_BLOCKING_STATUSES = ["confirmed"];

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

// Always use SERVICE_DEFS as source of truth for duration.
// The stored b.service_duration may be 10 (schema default) for old records.
// Use stored value ONLY if it is > 10 (meaning it was explicitly set correctly).
// Otherwise always use the config value.
function resolvedDuration(b) {
  const def = resolveService(b.service || "");
  const stored = b.service_duration;
  if (stored && stored > 10) return stored; // correctly saved
  return def.service_duration;              // config is authoritative
}

function resolvedOccupation(b) {
  const def = resolveService(b.service || "");
  return resolvedDuration(b) + (b.equipment_recovery_time !== undefined
    ? b.equipment_recovery_time
    : def.equipment_recovery_time);
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
  return `${String(Math.floor(mins / 60)).padStart(2,"0")}:${String(mins % 60).padStart(2,"0")}`;
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
  return `${String(h).padStart(2,"0")}:${String(mn).padStart(2,"0")}`;
}

function display24To12(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const p   = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2,"0")} ${p}`;
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

// Count capacity consumed during [newStart, newStart+newOccupation).
// Uses resolvedOccupation() for each existing booking so stored service_duration=10
// defaults don't corrupt the math.
function occupancyDuring(bookings, newStart24, newOccupation, resourcePool) {
  const ns = toMinutes(newStart24);
  const ne = ns + newOccupation;
  let total = 0;
  for (const b of bookings) {
    // CRITICAL: only count bookings in the SAME resource pool.
    // Bay bookings NEVER count against the alignment pool and vice versa.
    if (b.resourcePool !== resourcePool) continue;
    const bs24 = display12To24(b.time) || b.time;
    const bs   = toMinutes(bs24);
    const occ  = resolvedOccupation(b);
    const be   = bs + occ;
    if (ns < be && ne > bs) {
      total += (b.customer_quantity || 1);
    }
  }
  return total;
}

// ─────────────────────────────────────────────────────────────────────────────
// computeAvailability
// Returns { available, full, allSlots, businessHours, def, resourcePool, occupation }
//
// available  — array of 12h strings the customer CAN book
// full       — array of 12h strings that exist but are at capacity (show grayed out)
// allSlots   — available + full combined in time order (for UI rendering)
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

  // Fetch confirmed bookings that consume capacity — for THIS pool only.
  // This is the key isolation: bay queries only see bay bookings, alignment only alignment.
  // $ne: "none" fetches both bay and alignment — we filter by pool in occupancyDuring.
  const existing = await Booking.find(
    {
      date:         dateStr,
      status:       { $in: CAPACITY_BLOCKING_STATUSES },
      resourcePool: { $ne: "none" },
    },
    { time: 1, service: 1, service_duration: 1, equipment_recovery_time: 1,
      resourcePool: 1, customer_quantity: 1, _id: 0 }
  ).lean();

  const now     = DateTime.now().setZone(TZ);
  const isToday = dateStr === now.toISODate();
  const nowMins = isToday ? now.hour * 60 + now.minute : -1;

  const cap       = poolCapacity(resourcePool);
  const available = [];
  const full      = [];

  for (const slot12 of candidates) {
    const slot24 = display12To24(slot12);
    if (!slot24) continue;

    // Always skip past times — don't show them at all
    if (isToday && toMinutes(slot24) <= nowMins) continue;

    if (resourcePool === "none") {
      available.push(slot12);
    } else {
      const used = occupancyDuring(existing, slot24, occ, resourcePool);
      if (used >= cap) {
        full.push(slot12);      // at capacity — grayed out but still shown
      } else {
        available.push(slot12); // open
      }
    }
  }

  // allSlots preserves time order for UI rendering
  const allSlots = [...candidates].filter(s => {
    const s24 = display12To24(s);
    return s24 && !(isToday && toMinutes(s24) <= nowMins);
  });

  return { available, full, allSlots, businessHours: hours, def, resourcePool, occupation: occ };
}

// ─────────────────────────────────────────────────────────────────────────────
// validateCapacity — server-side race-condition guard
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
    resourcePool: resourcePool,   // EXACT pool match — no cross-pool interference
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
