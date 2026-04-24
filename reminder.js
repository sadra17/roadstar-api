// reminder.js  v9-supabase
"use strict";

const { DateTime } = require("luxon");
const { Bookings, SmsLog, ShopSettings } = require("./lib/db");
const { buildShopConfig, renderSmsTemplate, display12To24, toMinutes } = require("./config/business");

async function sendTwilioSMS(to, body) {
  if (!process.env.TWILIO_ACCOUNT_SID) return null;
  const client = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return client.messages.create({ body, from: process.env.TWILIO_PHONE_NUMBER, to });
}

async function runReminderCheck() {
  const allSettings = await ShopSettings.findAll();

  for (const settings of allSettings) {
    const config  = buildShopConfig(settings);
    const shopId  = settings.shopId;
    const tz      = config?.tz || "America/Toronto";
    if (config?.reminderEnabled === false) continue;

    const minutesBefore = config?.reminderMinutes || 30;
    const now       = DateTime.now().setZone(tz);
    const todayStr  = now.toISODate();
    const nowMins   = now.hour*60+now.minute;
    const winStart  = nowMins+minutesBefore-1;
    const winEnd    = nowMins+minutesBefore+1;

    const candidates = await Bookings.find({
      shop_id:         shopId,
      date:            todayStr,
      reminder_status: null,
      reminder_sent_at:null,
      deleted:         false,
    });
    // Filter to pending/confirmed/waitlist
    const eligible = candidates.filter(b => ["pending","confirmed","waitlist"].includes(b.status));

    for (const b of eligible) {
      try {
        const s24 = display12To24(b.time);
        if (!s24) continue;
        const slotMins = toMinutes(s24);
        if (slotMins<winStart||slotMins>winEnd) continue;

        const svcLabel = b.service==="Other"&&b.customService?`Other — ${b.customService}`:b.service;
        const shopName = config?.shopName||"Roadstar Tire";
        const template = config?.smsTemplates?.reminder||"Hi {firstName}, reminder: your {shopName} appointment is TODAY at {time} for {service}. See you soon! — {shopName}";
        const msgBody  = renderSmsTemplate(template, { firstName:b.firstName, shopName, time:b.time, service:svcLabel, date:b.date, reviewLink:config?.googleReviewLink||"" });

        console.log(`[Reminder][${shopId}] Sending to ${b.phone} — ${b.time}`);

        let status="failed", twilioSid=null, error=null;
        try {
          const msg = await sendTwilioSMS(b.phone, msgBody);
          status="sent"; twilioSid=msg?.sid||null;
          console.log(`[Reminder][${shopId}] ✓ ${b.phone}`);
        } catch (err) {
          error=err.message;
          console.error(`[Reminder][${shopId}] ✗ ${b.phone}:`, err.message);
        }

        // Log to sms_log table
        await SmsLog.create({ bookingId:b.id, shopId, messageType:"reminder", body:msgBody, sentAt:new Date().toISOString(), status, twilioSid, error });

        // Update booking reminder fields
        await Bookings.update(b.id, shopId, {
          reminderSentAt: new Date().toISOString(),
          reminderStatus: status,
          reminderError:  error,
        });
      } catch (err) {
        console.error(`[Reminder][${shopId}] Unexpected:`, err.message);
      }
    }
  }
}

function startReminderScheduler() {
  console.log("[Reminder] Scheduler started — checking every 60 s");
  runReminderCheck().catch(console.error);
  setInterval(() => runReminderCheck().catch(console.error), 60_000);
}

module.exports = { startReminderScheduler };
