// ─────────────────────────────────────────────────────────────────────────────
// config/business.js  v6
// Single source of truth for all Roadstar Tire business rules.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const { DateTime } = require("luxon");

const TZ           = "America/Toronto";
const NORMAL_BAYS  = 3;   // normal service bays (jacks)
const ALIGN_LANES  = 1;   // wheel alignment lane (separate capacity)
const SLOT_INTERVAL = 15; // minutes between slot start times

// ── Business hours ────────────────────────────────────────────────────────────
// 0=Sun, 1=Mon … 6=Sat.  null = closed all day.
const HOURS = {
  0: null,
  1: { open: "09:00", close: "18:00" },
  2: { open: "09:30", close: "18:00" },
  3: { open: "09:30", close: "18:00" },
  4: { open: "09:30", close: "18:00" },
  5: { open: "09:30", close: "18:00" },
  6: { open: "09:30", close: "16:00" },
};

// ── Service catalog ───────────────────────────────────────────────────────────
// capacityType:
//   "bay"       → uses 1 of 3 normal bays
//   "alignment" → uses the 1 alignment lane
//   "none"      → no capacity consumed
const SERVICE_DEFS = {
  "Tire Change + Installation": { duration: 40, capacityType: "bay"       },
  "Flat Tire Repair":           { duration: 15, capacityType: "bay"       },
  "Tire Rotation":              { duration: 20, capacityType: "bay"       },
  "Wheel Alignment":            { duration: 60, capacityType: "alignment" },
  "Tire Purchase":              { duration: 10, capacityType: "none"      },
  "Other":                      { duration: 30, capacityType: "none"      }, // admin-safe default
};

const ALL_SERVICES = Object.keys(SERVICE_DEFS);

// ── Capacity decisions ────────────────────────────────────────────────────────
// Use confirmed-only blocking (Option A).
// Rationale: cleaner UX, no phantom holds, no expiry complexity.
// Pending bookings are treated as soft holds only at the final race-condition
// check in validateCapacity — they do NOT block availability display.
const CAPACITY_BLOCKING_STATUSES = ["confirmed"];

// ── Helpers ───────────────────────────────────────────────────────────────────
function resolveService(service) {
  return SERVICE_DEFS[service] || { duration: 30, capacityType: "none" };
}

function getHoursForDate(dateStr) {
  const dt  = DateTime.fromISO(dateStr, { zone: TZ });
  const dow = dt.weekday === 7 ? 0 : dt.weekday; // luxon: 1=Mon,7=Sun → JS 0-6
  return HOURS[dow] ?? null;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function fromMinutes(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
}

function display12To24(str) {
  if (!str) return null;
  if (/^\d{2}:\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d+):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mn = parseInt(m[2], 10);
  const p  = m[3].toUpperCase();
  if (p === "PM" && h !== 12) h += 12;
  if (p === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2,"0")}:${String(mn).padStart(2,"0")}`;
}

function display24To12(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const p   = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2,"0")} ${p}`;
}

// Generates all valid start times for a service duration on a given date.
// Returns 12h display strings.
function generateSlots(dateStr, duration) {
  const hours = getHoursForDate(dateStr);
  if (!hours) return [];
  const openM  = toMinutes(hours.open);
  const closeM = toMinutes(hours.close);
  const last   = closeM - duration;
  const slots  = [];
  for (let t = openM; t <= last; t += SLOT_INTERVAL) {
    slots.push(display24To12(fromMinutes(t)));
  }
  return slots;
}

// Count how many confirmed bookings of a given capacityType overlap a window.
function countOverlapping(bookings, slot24, duration, capacityType) {
  const ns = toMinutes(slot24);
  const ne = ns + duration;
  let count = 0;
  for (const b of bookings) {
    if (b.capacityType !== capacityType) continue;
    const bs = toMinutes(display12To24(b.time) || b.time);
    const be = bs + (b.duration || 10);
    if (ns < be && ne > bs) count++;
  }
  return count;
}

// Maximum capacity for a capacityType.
function maxCapacity(capacityType) {
  if (capacityType === "bay")       return NORMAL_BAYS;
  if (capacityType === "alignment") return ALIGN_LANES;
  return Infinity; // "none" — no limit
}

// ── Main availability computation ─────────────────────────────────────────────
async function computeAvailability(dateStr, service, Booking) {
  const { duration, capacityType } = resolveService(service);
  const hours = getHoursForDate(dateStr);
  if (!hours) return { available: [], businessHours: null, duration, capacityType };

  const candidates = generateSlots(dateStr, duration);

  // Fetch CONFIRMED bookings for this date (confirmed-only blocking)
  const existing = await Booking.find(
    {
      date:         dateStr,
      status:       { $in: CAPACITY_BLOCKING_STATUSES },
      capacityType: { $ne: "none" },
    },
    { time: 1, duration: 1, capacityType: 1, _id: 0 }
  ).lean();

  // Strip past times (today only, Toronto time)
  const now     = DateTime.now().setZone(TZ);
  const isToday = dateStr === now.toISODate();
  const nowMins = isToday ? now.hour * 60 + now.minute : -1;

  const cap   = maxCapacity(capacityType);
  const avail = [];

  for (const slot12 of candidates) {
    const slot24 = display12To24(slot12);
    if (!slot24) continue;
    if (isToday && toMinutes(slot24) <= nowMins) continue;

    if (capacityType !== "none") {
      const occupied = countOverlapping(existing, slot24, duration, capacityType);
      if (occupied >= cap) continue;
    }

    avail.push(slot12);
  }

  return { available: avail, businessHours: hours, duration, capacityType };
}

// ── Server-side capacity validation (race-condition guard) ────────────────────
// Called inside POST /api/book and PATCH /api/bookings/:id when rescheduling.
async function validateCapacity(dateStr, slot, service, Booking, excludeId) {
  const { duration, capacityType } = resolveService(service);
  if (capacityType === "none") return { ok: true };

  const slot24 = display12To24(slot) || slot;
  const cap    = maxCapacity(capacityType);

  const q = {
    date:         dateStr,
    status:       { $in: CAPACITY_BLOCKING_STATUSES },
    capacityType: capacityType,
  };
  if (excludeId) q._id = { $ne: excludeId };

  const existing = await Booking.find(q, { time: 1, duration: 1, capacityType: 1, _id: 0 }).lean();
  const occupied = countOverlapping(existing, slot24, duration, capacityType);

  if (occupied >= cap) {
    const noun = capacityType === "alignment" ? "alignment lane" : "service bay";
    return {
      ok: false,
      reason: `That time is no longer available — the ${noun} is fully booked during that window. Please choose another time.`,
    };
  }
  return { ok: true };
}

// ── "Live at bay" helper ──────────────────────────────────────────────────────
// Returns bookings that are actively in service right now based on
// confirmed status + time window containing current Toronto time.
function isActiveInBayNow(booking) {
  const now     = DateTime.now().setZone(TZ);
  const todayStr = now.toISODate();
  if (booking.date !== todayStr) return false;
  if (booking.status !== "confirmed") return false;
  if (booking.capacityType === "none") return false;

  const slot24 = display12To24(booking.time);
  if (!slot24) return false;

  const startMins = toMinutes(slot24);
  const endMins   = startMins + (booking.duration || 10);
  const nowMins   = now.hour * 60 + now.minute;

  return nowMins >= startMins && nowMins < endMins;
}

module.exports = {
  TZ,
  NORMAL_BAYS,
  ALIGN_LANES,
  SLOT_INTERVAL,
  HOURS,
  SERVICE_DEFS,
  ALL_SERVICES,
  CAPACITY_BLOCKING_STATUSES,
  resolveService,
  getHoursForDate,
  toMinutes,
  fromMinutes,
  display12To24,
  display24To12,
  generateSlots,
  countOverlapping,
  maxCapacity,
  computeAvailability,
  validateCapacity,
  isActiveInBayNow,
};
