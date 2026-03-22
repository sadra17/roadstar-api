// ─────────────────────────────────────────────────────────────────────────────
// config/business.js
// Single source of truth for Roadstar Tire business rules.
// Imported by routes, scheduler, and tests.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const { DateTime } = require("luxon");

// ── Timezone ──────────────────────────────────────────────────────────────────
const TZ = "America/Toronto";

// ── Business hours ────────────────────────────────────────────────────────────
// Keyed by JS getDay() values: 0=Sun, 1=Mon … 6=Sat
// null = closed all day
const HOURS = {
  0: null,                                        // Sunday  — closed
  1: { open: "09:00", close: "18:00" },           // Monday
  2: { open: "09:30", close: "18:00" },           // Tuesday
  3: { open: "09:30", close: "18:00" },           // Wednesday
  4: { open: "09:30", close: "18:00" },           // Thursday
  5: { open: "09:30", close: "18:00" },           // Friday
  6: { open: "09:30", close: "16:00" },           // Saturday
};

// ── Service catalog ───────────────────────────────────────────────────────────
// usesJack: true  → consumes 1 of 3 jacks; subject to capacity check
// usesJack: false → no capacity gate; always available when open
const SERVICE_DEFS = {
  "Tire Change":                { duration: 40, usesJack: true  },
  "Tire Change + Installation": { duration: 40, usesJack: true  },
  "Flat Tire Repair":           { duration: 15, usesJack: true  },
  "Wheel Balancing":            { duration: 20, usesJack: true  },
  "Tire Rotation":              { duration: 20, usesJack: true  },
  "TPMS Service":               { duration: 15, usesJack: true  },
  "Tire Purchase":              { duration: 10, usesJack: false },
  "Other":                      { duration: 15, usesJack: false },
};

const ALL_SERVICES = Object.keys(SERVICE_DEFS);
const TOTAL_JACKS  = 3;
const SLOT_INTERVAL = 15; // minutes between candidate start times

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns { duration, usesJack } for a service name.
 * Falls back to { duration:15, usesJack:false } for unknown/custom.
 */
function resolveService(serviceName) {
  return SERVICE_DEFS[serviceName] || { duration: 15, usesJack: false };
}

/**
 * Returns business hours object { open:"HH:MM", close:"HH:MM" } | null
 * for a given "YYYY-MM-DD" date string in Toronto time.
 */
function getHoursForDate(dateStr) {
  // Luxon weekday: 1=Mon … 7=Sun — convert to JS 0=Sun … 6=Sat
  const dt  = DateTime.fromISO(dateStr, { zone: TZ });
  const dow = dt.weekday === 7 ? 0 : dt.weekday;
  return HOURS[dow] ?? null;
}

/** "HH:MM" → integer minutes since midnight */
function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** integer minutes → "HH:MM" */
function fromMinutes(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * "9:00 AM" / "10:40 PM" → "HH:MM"
 * If already "HH:MM", returns as-is.
 */
function display12To24(str) {
  if (!str) return null;
  if (/^\d{2}:\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d+):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mn = parseInt(m[2], 10);
  const period = m[3].toUpperCase();
  if (period === "PM" && h !== 12) h += 12;
  if (period === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${String(mn).padStart(2, "0")}`;
}

/**
 * "HH:MM" → "9:00 AM"
 */
function display24To12(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12    = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

/**
 * Generate all valid slot start times for a date + service duration.
 * Returns array of 12-hour display strings ("9:00 AM", …)
 * that have room to fit fully before closing.
 */
function generateSlots(dateStr, duration) {
  const hours = getHoursForDate(dateStr);
  if (!hours) return [];

  const openM  = toMinutes(hours.open);
  const closeM = toMinutes(hours.close);
  const last   = closeM - duration;    // latest valid start

  const slots = [];
  for (let t = openM; t <= last; t += SLOT_INTERVAL) {
    slots.push(display24To12(fromMinutes(t)));
  }
  return slots;
}

/**
 * Count how many jack-using bookings overlap a proposed [start, start+duration).
 * @param {Array}  bookings  — lean DB objects with { time, duration, usesJack }
 * @param {string} slot24    — "HH:MM" proposed start
 * @param {number} duration  — proposed duration in minutes
 */
function jacksInUse(bookings, slot24, duration) {
  const ns = toMinutes(slot24);
  const ne = ns + duration;
  let count = 0;
  for (const b of bookings) {
    if (!b.usesJack) continue;
    const bs = toMinutes(display12To24(b.time) || b.time);
    const be = bs + (b.duration || 10);
    if (ns < be && ne > bs) count++;  // any overlap
  }
  return count;
}

/**
 * Full availability check for a (date, service) pair.
 * Queries the DB for existing bookings and filters slots by capacity.
 * Returns { available: string[], businessHours, duration, usesJack }
 *
 * @param {string} dateStr   "YYYY-MM-DD"
 * @param {string} service   canonical service name
 * @param {Model}  Booking   Mongoose model (passed in to avoid circular require)
 */
async function computeAvailability(dateStr, service, Booking) {
  const { duration, usesJack } = resolveService(service);
  const hours = getHoursForDate(dateStr);
  if (!hours) {
    return { available: [], businessHours: null, duration, usesJack };
  }

  const candidate12h = generateSlots(dateStr, duration);

  // Fetch all active bookings for this date
  const existing = await Booking.find(
    { date: dateStr, status: { $nin: ["cancelled"] } },
    { time: 1, duration: 1, usesJack: 1, _id: 0 }
  ).lean();

  // Strip past slots when date === today (Toronto time)
  const now      = DateTime.now().setZone(TZ);
  const isToday  = dateStr === now.toISODate();
  const nowMins  = isToday ? now.hour * 60 + now.minute : -1;

  const available = [];
  for (const slot12 of candidate12h) {
    const slot24 = display12To24(slot12);
    if (!slot24) continue;

    // Skip past times
    if (isToday && toMinutes(slot24) <= nowMins) continue;

    // Jack capacity gate (only for jack-consuming services)
    if (usesJack && jacksInUse(existing, slot24, duration) >= TOTAL_JACKS) continue;

    available.push(slot12);
  }

  return { available, businessHours: hours, duration, usesJack };
}

/**
 * Server-side capacity validation for a new / updated booking.
 * Call before Booking.create() and before Booking.findByIdAndUpdate() when time changes.
 *
 * @param {string}      dateStr     "YYYY-MM-DD"
 * @param {string}      slot        "9:00 AM" (stored format) or "HH:MM"
 * @param {string}      service
 * @param {Model}       Booking
 * @param {ObjectId|string|null} excludeId  booking to exclude (for reschedule)
 * @returns {{ ok: boolean, reason?: string }}
 */
async function validateCapacity(dateStr, slot, service, Booking, excludeId) {
  const { duration, usesJack } = resolveService(service);
  if (!usesJack) return { ok: true };

  const slot24 = display12To24(slot) || slot;
  const q = {
    date:     dateStr,
    status:   { $nin: ["cancelled"] },
    usesJack: true,
  };
  if (excludeId) q._id = { $ne: excludeId };

  const existing = await Booking.find(q, { time: 1, duration: 1, usesJack: 1, _id: 0 }).lean();
  const occupied = jacksInUse(existing, slot24, duration);

  if (occupied >= TOTAL_JACKS) {
    return {
      ok: false,
      reason:
        "All 3 service bays are occupied during that time window. Please select a different slot.",
    };
  }
  return { ok: true };
}

module.exports = {
  TZ,
  HOURS,
  TOTAL_JACKS,
  SLOT_INTERVAL,
  SERVICE_DEFS,
  ALL_SERVICES,
  resolveService,
  getHoursForDate,
  toMinutes,
  fromMinutes,
  display12To24,
  display24To12,
  generateSlots,
  jacksInUse,
  computeAvailability,
  validateCapacity,
};
