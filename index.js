// index.js  v9-supabase
"use strict";
require("dotenv").config();

const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const cors       = require("cors");
const helmet     = require("helmet");
const morgan     = require("morgan");
const rateLimit  = require("express-rate-limit");

const { connectDB }               = require("./config/supabase");
const bookingRoutes               = require("./routes/bookings");
const { purgeOldDeletedBookings } = require("./routes/bookings");
const authRoutes                  = require("./routes/auth");
const settingsRoutes              = require("./routes/settings");
const userRoutes                  = require("./routes/users");
const auditRoutes                 = require("./routes/auditLog");
const analyticsRoutes             = require("./routes/analytics");
const shopRoutes                  = require("./routes/shops");
const { startReminderScheduler }  = require("./reminder");

connectDB().then(() => {
  startReminderScheduler();
  purgeOldDeletedBookings();
  setInterval(purgeOldDeletedBookings, 6*60*60*1000);
  console.log("[Cleanup] Auto-purge scheduler started");
}).catch(err => { console.error("Startup:", err.message); process.exit(1); });

// ── S2: CORS origin whitelist ─────────────────────────────────────────────────
// Set ALLOWED_ORIGINS in Render env vars (comma-separated) to restrict access.
// Example: https://roadstar-dashboard.vercel.app,https://roadstartire.ca
// Falls back to * so existing deployments keep working until the env var is set.
const _rawOrigins = process.env.ALLOWED_ORIGINS;
const ALLOWED_ORIGINS = _rawOrigins
  ? _rawOrigins.split(",").map(o => o.trim())
  : "*";

if (!_rawOrigins) {
  console.warn("[CORS] ALLOWED_ORIGINS env var not set — defaulting to *. Set it to lock down origins.");
}

const corsOptions = {
  origin: ALLOWED_ORIGINS,
  methods: ["GET","POST","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","x-admin-secret","x-shop-id"],
};

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: ALLOWED_ORIGINS, methods: ["GET","POST"] } });
app.use((req,_res,next) => { req.io=io; next(); });

io.on("connection", socket => {
  socket.on("join_shop", (shopId) => { if (shopId) socket.join(`shop:${shopId}`); });
});

app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({ limit:"10kb" }));
// Use 'combined' in production to avoid leaking request details in dev format
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

const rl = (wMs,max,msg) => rateLimit({ windowMs:wMs, max, standardHeaders:true, legacyHeaders:false, message:{success:false,message:msg||"Too many requests."} });
app.use("/api/book",              rl(15*60_000, 60, "Too many booking attempts."));
app.use("/api/auth/login",        rl(15*60_000, 15));
app.use("/api/auth/request-otp",  rl(15*60_000, 10, "Too many code requests. Try again in 15 minutes."));
app.use("/api/auth/verify-otp",   rl(15*60_000, 20));
app.use("/api",                   rl(15*60_000, 1000));

app.use("/api/auth", authRoutes);
app.use("/api",      settingsRoutes);
app.use("/api",      bookingRoutes);
app.use("/api",      userRoutes);
app.use("/api",      auditRoutes);
app.use("/api",      analyticsRoutes);
app.use("/api",      shopRoutes);

app.get("/health", (_req,res) => res.json({ status:"ok", version:"9.0-supabase", db:"supabase", time:new Date().toISOString() }));
app.use((_req,res) => res.status(404).json({ success:false, message:"Route not found" }));
app.use((err,_req,res,_next) => { console.error(err.message); res.status(500).json({ success:false, message:"Server error" }); });

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Roadstar API v9-supabase on port ${PORT}`));
