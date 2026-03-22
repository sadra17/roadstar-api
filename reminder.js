// ─────────────────────────────────────────────────────────────────────────────
// reminder.js  —  30-minute appointment reminder scheduler
//
// Runs every 60 seconds. Sends one SMS per booking when the appointment is
// approximately 30 minutes away. Uses Toronto timezone. Idempotent: reminderStatus
// prevents duplicate sends even after server restart.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const { DateTime } = require("luxon");
const { TZ, display12To24, toMinutes } = require("./config/business");

// ── Twilio helper ─────────────────────────────────────────────────────────────
async function sendTwilioSMS(to, body) {
  if (!process.env.TWILIO_ACCOUNT_SID) {
    console.warn("[Reminder] Twilio not configured — skipping SMS");
    return null;
  }
  const client = require("twilio")(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  return client.messages.create({
    body,
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
  });
}

function buildReminderMsg(booking) {
  return (
    `Hi ${booking.firstName}, this is a reminder that your Roadstar Tire ` +
    `appointment is at ${booking.time} today for ${booking.service}. ` +
    `See you soon! — Roadstar Tire`
  );
}

// ── Core check ────────────────────────────────────────────────────────────────
async function runReminderCheck() {
  // Lazy-require to avoid circular dependency at module load
  const Booking = require("./models/Booking");

  const now      = DateTime.now().setZone(TZ);
  const todayStr = now.toISODate(); // "YYYY-MM-DD"

  // Window: appointments whose start time falls between now+29:00 and now+31:00
  const windowStartMins = now.hour * 60 + now.minute + 29;
  const windowEndMins   = now.hour * 60 + now.minute + 31;

  // Find candidates: today, active statuses, reminder not already sent/failed
  const candidates = await Booking.find({
    date:           todayStr,
    status:         { $in: ["pending", "confirmed", "waitlist"] },
    reminderStatus: null, // not yet attempted
  }).lean();

  for (const booking of candidates) {
    try {
      const slot24 = display12To24(booking.time);
      if (!slot24) continue;

      const slotMins = toMinutes(slot24);
      if (slotMins < windowStartMins || slotMins > windowEndMins) continue;

      // ── This booking is in the reminder window ─────────────────────────────
      console.log(
        `[Reminder] Sending to ${booking.phone} — ${booking.time} (${booking.service})`
      );

      try {
        const msg = buildReminderMsg(booking);
        await sendTwilioSMS(booking.phone, msg);
        await Booking.findByIdAndUpdate(booking._id, {
          $set: {
            reminderSentAt: new Date(),
            reminderStatus: "sent",
          },
        });
        console.log(`[Reminder] ✓ Sent to ${booking.phone}`);
      } catch (smsErr) {
        console.error(`[Reminder] ✗ SMS failed for ${booking.phone}:`, smsErr.message);
        await Booking.findByIdAndUpdate(booking._id, {
          $set: {
            reminderStatus: "failed",
            reminderError:  smsErr.message,
          },
        });
      }
    } catch (err) {
      console.error("[Reminder] Unexpected error:", err.message);
    }
  }
}

// ── Exported starter ──────────────────────────────────────────────────────────
function startReminderScheduler() {
  console.log("[Reminder] Scheduler started — checking every 60 s");
  // Run once immediately, then every 60 seconds
  runReminderCheck().catch(console.error);
  setInterval(() => runReminderCheck().catch(console.error), 60_000);
}

module.exports = { startReminderScheduler };
