// reminder.js  v8 — per-shop timezone, per-shop SMS template, shopId scoped
"use strict";

const { DateTime } = require("luxon");
const { display12To24, toMinutes, buildShopConfig, renderSmsTemplate } = require("./config/business");

async function sendTwilioSMS(to, body) {
  if (!process.env.TWILIO_ACCOUNT_SID) return null;
  const client = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return client.messages.create({ body, from: process.env.TWILIO_PHONE_NUMBER, to });
}

async function runReminderCheck() {
  const Booking      = require("./models/Booking");
  const ShopSettings = require("./models/ShopSettings");

  const allSettings = await ShopSettings.find({}).lean();

  for (const settings of allSettings) {
    const config  = buildShopConfig(settings);
    const shopId  = settings.shopId;
    const tz      = config?.tz || "America/Toronto";
    if (config?.reminderEnabled === false) continue;

    const minutesBefore = config?.reminderMinutes || 30;
    const now       = DateTime.now().setZone(tz);
    const todayStr  = now.toISODate();
    const nowMins   = now.hour * 60 + now.minute;
    const winStart  = nowMins + minutesBefore - 1;
    const winEnd    = nowMins + minutesBefore + 1;

    const candidates = await Booking.find({
      shopId, date: todayStr,
      status: { $in: ["pending","confirmed","waitlist"] },
      reminderStatus: null, reminderSentAt: null,
      deleted: { $ne: true },
    }).lean();

    for (const b of candidates) {
      try {
        const s24 = display12To24(b.time);
        if (!s24) continue;
        const slotMins = toMinutes(s24);
        if (slotMins < winStart || slotMins > winEnd) continue;

        const svcLabel = b.service === "Other" && b.customService ? `Other — ${b.customService}` : b.service;
        const shopName = config?.shopName || "Roadstar Tire";
        const template = config?.smsTemplates?.reminder ||
          "Hi {firstName}, reminder: your {shopName} appointment is TODAY at {time} for {service}. See you soon! — {shopName}";
        const msgBody  = renderSmsTemplate(template, {
          firstName: b.firstName, shopName, time: b.time,
          service: svcLabel, date: b.date, reviewLink: config?.googleReviewLink || "",
        });

        console.log(`[Reminder][${shopId}] Sending to ${b.phone} — ${b.time}`);
        try {
          await sendTwilioSMS(b.phone, msgBody);
          await Booking.findByIdAndUpdate(b._id, {
            $set:  { reminderSentAt: new Date(), reminderStatus: "sent" },
            $push: { smsLog: { messageType: "reminder", body: msgBody, sentAt: new Date(), status: "sent" } },
          });
          console.log(`[Reminder][${shopId}] ✓ ${b.phone}`);
        } catch (err) {
          await Booking.findByIdAndUpdate(b._id, {
            $set:  { reminderStatus: "failed", reminderError: err.message },
            $push: { smsLog: { messageType: "reminder", body: msgBody, sentAt: new Date(), status: "failed", error: err.message } },
          });
          console.error(`[Reminder][${shopId}] ✗ ${b.phone}:`, err.message);
        }
      } catch (err) { console.error(`[Reminder][${shopId}] Error:`, err.message); }
    }
  }
}

function startReminderScheduler() {
  console.log("[Reminder] Scheduler started — checking every 60 s");
  runReminderCheck().catch(console.error);
  setInterval(() => runReminderCheck().catch(console.error), 60_000);
}

module.exports = { startReminderScheduler };
