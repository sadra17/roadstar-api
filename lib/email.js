// lib/email.js — email utility
// Supports two backends (pick one via env vars):
//   1. RESEND_API_KEY  → Resend (recommended, free tier is generous)
//   2. SMTP_HOST + SMTP_PORT + SMTP_USER + SMTP_PASS → any SMTP relay
// Falls back to console.log in dev when neither is configured.
"use strict";

const https = require("https");

/**
 * sendEmail({ to, subject, html, text })
 * Returns a promise. Throws on error.
 */
async function sendEmail({ to, subject, html, text }) {
  const from = process.env.SMTP_FROM || "Roadstar Dashboard <noreply@roadstartire.ca>";

  // ── Resend REST API (no extra package) ────────────────────────────────────────
  if (process.env.RESEND_API_KEY) {
    const body = JSON.stringify({ from, to, subject, html: html || `<p>${text}</p>` });
    return new Promise((resolve, reject) => {
      const req = https.request(
        { hostname: "api.resend.com", path: "/emails", method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Length": Buffer.byteLength(body) } },
        (res) => {
          let raw = "";
          res.on("data", d => { raw += d; });
          res.on("end", () => {
            const data = JSON.parse(raw || "{}");
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
            else reject(new Error(`Resend error ${res.statusCode}: ${data.message || raw}`));
          });
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  // ── Nodemailer SMTP fallback ───────────────────────────────────────────────────
  if (process.env.SMTP_HOST) {
    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || "587", 10),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    return transporter.sendMail({ from, to, subject, html, text });
  }

  // ── Dev fallback — print to console ───────────────────────────────────────────
  console.log(`\n[Email DEV — no RESEND_API_KEY or SMTP_HOST set]`);
  console.log(`  To      : ${to}`);
  console.log(`  Subject : ${subject}`);
  console.log(`  Body    : ${text || "(html only)"}\n`);
  return { dev: true };
}

/**
 * sendOtpEmail(email, code, shopName)
 * Sends the 6-digit login code with branded HTML template.
 */
async function sendOtpEmail(email, code, shopName = "Roadstar Tire") {
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#080c14;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:48px 16px">
      <table width="100%" style="max-width:420px;background:#0f1623;border-radius:16px;border:1px solid #1f2d45;padding:40px">
        <tr><td align="center" style="padding-bottom:32px">
          <div style="width:50px;height:50px;border-radius:50%;background:#192236;border:2px solid #2a3d58;display:flex;align-items:center;justify-content:center;margin:0 auto 16px">
            <span style="font-size:22px">🔑</span>
          </div>
          <div style="font-size:20px;font-weight:800;color:#F1F5F9;letter-spacing:0.04em">${shopName}</div>
          <div style="font-size:11px;color:#4B5A6E;letter-spacing:0.12em;text-transform:uppercase;margin-top:4px">Admin Dashboard</div>
        </td></tr>
        <tr><td align="center" style="padding-bottom:24px">
          <div style="font-size:15px;color:#94A3B8;margin-bottom:24px">Your login verification code:</div>
          <div style="font-size:48px;font-weight:900;letter-spacing:0.18em;color:#2563EB;background:#0c1a35;border:2px solid #172554;border-radius:12px;padding:20px 36px;display:inline-block">
            ${code}
          </div>
          <div style="font-size:13px;color:#4B5A6E;margin-top:20px">
            This code expires in <strong style="color:#94A3B8">10 minutes</strong>.<br>
            Do not share it with anyone.
          </div>
        </td></tr>
        <tr><td align="center">
          <div style="font-size:11px;color:#4B5A6E;border-top:1px solid #1f2d45;padding-top:20px">
            If you didn't request this, you can safely ignore this email.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return sendEmail({
    to:      email,
    subject: `${code} — Your ${shopName} login code`,
    html,
    text:    `Your ${shopName} login code is: ${code}\n\nThis code expires in 10 minutes. Do not share it with anyone.`,
  });
}

module.exports = { sendEmail, sendOtpEmail };
