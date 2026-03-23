// ─────────────────────────────────────────────────────────────────────────────
// index.js  v7.3
// ─────────────────────────────────────────────────────────────────────────────
"use strict";
require("dotenv").config();

const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const cors       = require("cors");
const helmet     = require("helmet");
const morgan     = require("morgan");
const rateLimit  = require("express-rate-limit");

const connectDB                        = require("./config/db");
const bookingRoutes                    = require("./routes/bookings");
const { purgeOldDeletedBookings }      = require("./routes/bookings");
const authRoutes                       = require("./routes/auth");
const { startReminderScheduler }       = require("./reminder");

// ── Start DB then background jobs ────────────────────────────────────────────
connectDB()
  .then(() => {
    startReminderScheduler();

    // Purge soft-deleted bookings older than 15 days.
    // Run immediately on startup, then every 6 hours.
    purgeOldDeletedBookings();
    setInterval(purgeOldDeletedBookings, 6 * 60 * 60 * 1000);
    console.log("[Cleanup] Auto-purge scheduler started — runs every 6 h");
  })
  .catch(err => { console.error("Startup:", err.message); process.exit(1); });

// ── Express + Socket.io ───────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*", methods: ["GET","POST"] } });

app.use((req, _res, next) => { req.io = io; next(); });
io.on("connection", s => {
  console.log("[Socket] connected:", s.id);
  s.on("disconnect", () => console.log("[Socket] disconnected:", s.id));
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({
  origin:         "*",
  methods:        ["GET","POST","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","x-admin-secret"],
}));
app.options("*", cors());
app.use(express.json({ limit: "10kb" }));
app.use(morgan("dev"));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const rl = (windowMs, max, msg) => rateLimit({
  windowMs, max,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: msg || "Too many requests. Please wait a moment." },
});
app.use("/api/book",       rl(15*60_000, 60,   "Too many booking attempts. Please wait a moment."));
app.use("/api/auth/login", rl(15*60_000, 15));
app.use("/api",            rl(15*60_000, 1000));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api",      bookingRoutes);
app.get("/health", (_req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

// ── Fallback ──────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ success: false, message: "Route not found" }));
app.use((err, _req, res, _next) => {
  console.error(err.message);
  res.status(500).json({ success: false, message: "Server error" });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Roadstar API v7.3 on port ${PORT}`));
