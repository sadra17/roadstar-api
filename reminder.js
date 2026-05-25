// reminder.js  v9-supabase — dual reminder support
// Reminder 1: advance notice (12 h or 24 h before) — message type "reminder_advance"
// Reminder 2: same-day     (N minutes before)       — message type "reminder"
"use strict";

const { DateTime } = require("luxon");
const { Bookings, SmsLog, ShopSettings } = require("./lib/db");
const { buildShopConfig, renderSmsTemplate, display12To24, toMinutes } = require("./config/business");

async function sendTwilioSMS(to, body) {
  if (!process.env.TWILIO_ACCOUNT_SID) return null;
  const client = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return client.messages.create({ body, from: process.env.TWILIO_PHONE_NUMBER, to });
}

// ── Shared SMS send + log helper ──────────────────────────────────────────────
async function dispatchReminder(b, shopId, config, messageType) {
  const svcLabel = b.service === "Other" && b.customService
    ? `Other — ${b.customService}` : b.service;
  const shopName = config?.shopName || "Roadstar Tire";

  // Template lookup: custom → default
  const templates = config?.smsTemplates || {};
  const defaults = {
    reminder:         "Hi {firstName}, reminder: your {shopName} appointment is TODAY at {time} for {service}. See you soon! — {shopName}",
    reminder_advance: "Hi {firstName}! Just a heads-up — your {shopName} appointment is on {date} at {time} for {service}. See you then! — {shopName}",
  };
  const camelType = messageType.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const template  = templates[messageType] || templates[camelType] || defaults[messageType] || "";
  if (!template) return;

  const msgBody = renderSmsTemplate(template, {
    firstName: b.firstName, shopName, time: b.time,
    service: svcLabel, date: b.date, reviewLink: config?.googleReviewLink || "",
  });

  console.log(`[Reminder][${shopId}][${messageType}] Sending to ${b.phone} — ${b.date} ${b.time}`);

  let status = "failed", twilioSid = null, error = null;
  try {
    const msg = await sendTwilioSMS(b.phone, msgBody);
    status = "sent"; twilioSid = msg?.sid || null;
    console.log(`[Reminder][${shopId}][${messageType}] ✓ ${b.phone}`);
  } catch (err) {
    error = err.message;
    console.error(`[Reminder][${shopId}][${messageType}] ✗ ${b.phone}:`, err.message);
  }

  // Log to sms_log (duplicate prevention uses this)
  await SmsLog.create({
    bookingId: b.id, shopId, messageType, body: msgBody,
    sentAt: new Date().toISOString(), status, twilioSid, error,
  });

  // For the same-day reminder, also stamp the booking row so we never re-query it
  if (messageType === "reminder") {
    await Bookings.update(b.id, shopId, {
      reminderSentAt: new Date().toISOString(),
      reminderStatus: status,
      reminderError:  error,
    });
  }
}

// ── Main check — runs every 60 s ──────────────────────────────────────────────
async function runReminderCheck() {
  const allSettings = await ShopSettings.findAll();

  for (const settings of allSettings) {
    const config = buildShopConfig(settings);
    const shopId = settings.shopId;
    const tz     = config?.tz || "America/Toronto";
    if (config?.reminderEnabled === false) continue;

    const now      = DateTime.now().setZone(tz);
    const todayStr = now.toISODate();
    const nowMins  = now.hour * 60 + now.minute;

    // ── Reminder 1: advance notice (12 h or 24 h before) ─────────────────────
    if (config.reminderAdvanceEnabled) {
      const advHours   = config.reminderAdvanceHours || 24; // 12 or 24
      const targetDt   = now.plus({ hours: advHours });
      const targetDate = targetDt.toISODate();
      const targetMins = targetDt.hour * 60 + targetDt.minute;

      const advanceCandidates = await Bookings.find({
        shop_id: shopId,
        date:    targetDate,
        status:  { $in: ["pending", "confirmed", "waitlist"] },
        deleted: false,
      });

      for (const b of advanceCandidates) {
        try {
          const s24 = display12To24(b.time);
          if (!s24) continue;
          const slotMins = toMinutes(s24);
          // ±1 minute window around the target time
          if (slotMins < targetMins - 1 || slotMins > targetMins + 1) continue;

          // Duplicate guard: don't send again if already sent within last (advHours - 1) hours
          const alreadySent = await SmsLog.checkDuplicate(b.id, "reminder_advance", (advHours - 1) * 60);
          if (alreadySent) continue;

          await dispatchReminder(b, shopId, config, "reminder_advance");
        } catch (err) {
          console.error(`[Reminder][${shopId}][advance] Unexpected:`, err.message);
        }
      }
    }

    // ── Reminder 2: same-day (N minutes before) ───────────────────────────────
    const minutesBefore = config.reminderMinutes || 30;
    const winStart      = nowMins + minutesBefore - 1;
    const winEnd        = nowMins + minutesBefore + 1;

    // reminder_status + reminder_sent_at both null = not yet sent
    const sameDayCandidates = await Bookings.find({
      shop_id:          shopId,
      date:             todayStr,
      status:           { $in: ["pending", "confirmed", "waitlist"] },
      reminder_status:  null,
      reminder_sent_at: null,
      deleted:          false,
    });

    for (const b of sameDayCandidates) {
      try {
        const s24 = display12To24(b.time);
        if (!s24) continue;
        const slotMins = toMinutes(s24);
        if (slotMins < winStart || slotMins > winEnd) continue;

        await dispatchReminder(b, shopId, config, "reminder");
      } catch (err) {
        console.error(`[Reminder][${shopId}][same-day] Unexpected:`, err.message);
      }
    }
  }
}

function startReminderScheduler() {
  console.log("[Reminder] Scheduler started — checking every 60 s (same-day + advance)");
  runReminderCheck().catch(console.error);
  setInterval(() => runReminderCheck().catch(console.error), 60_000);
}

module.exports = { startReminderScheduler };
