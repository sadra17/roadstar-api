// ─────────────────────────────────────────────────────────────────────────────
// reminder.js  v6 — 30-minute appointment reminder scheduler
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const { DateTime } = require("luxon");
const { TZ, display12To24, toMinutes } = require("./config/business");

async function sendTwilioSMS(to, body) {
  if (!process.env.TWILIO_ACCOUNT_SID) return null;
  const client = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return client.messages.create({ body, from: process.env.TWILIO_PHONE_NUMBER, to });
}

function buildMsg(b) {
  const svc = b.service === "Other" && b.customService ? `Other — ${b.customService}` : b.service;
  return `Hi ${b.firstName}, reminder: your Roadstar Tire appointment is TODAY at ${b.time} for ${svc}. See you soon! — Roadstar Tire`;
}

async function runReminderCheck() {
  const Booking = require("./models/Booking");
  const now       = DateTime.now().setZone(TZ);
  const todayStr  = now.toISODate();
  const nowMins   = now.hour * 60 + now.minute;
  const winStart  = nowMins + 29;
  const winEnd    = nowMins + 31;

  const candidates = await Booking.find({
    date:           todayStr,
    status:         { $in: ["pending","confirmed","waitlist"] },
    reminderStatus: null,
    reminderSentAt: null,
  }).lean();

  for (const b of candidates) {
    try {
      const s24 = display12To24(b.time);
      if (!s24) continue;
      const slotMins = toMinutes(s24);
      if (slotMins < winStart || slotMins > winEnd) continue;

      console.log(`[Reminder] Sending to ${b.phone} — ${b.time} (${b.service})`);
      try {
        await sendTwilioSMS(b.phone, buildMsg(b));
        await require("./models/Booking").findByIdAndUpdate(b._id, {
          $set: { reminderSentAt: new Date(), reminderStatus: "sent" },
        });
        console.log(`[Reminder] ✓ Sent to ${b.phone}`);
      } catch (err) {
        await require("./models/Booking").findByIdAndUpdate(b._id, {
          $set: { reminderStatus: "failed", reminderError: err.message },
        });
        console.error(`[Reminder] ✗ Failed ${b.phone}:`, err.message);
      }
    } catch (err) {
      console.error("[Reminder] Unexpected error:", err.message);
    }
  }
}

function startReminderScheduler() {
  console.log("[Reminder] Scheduler started — checking every 60 s");
  runReminderCheck().catch(console.error);
  setInterval(() => runReminderCheck().catch(console.error), 60_000);
}

module.exports = { startReminderScheduler };
