require("dotenv").config();
const express  = require("express");
const cors     = require("cors");
const helmet   = require("helmet");
const morgan   = require("morgan");
const rateLimit = require("express-rate-limit");

const connectDB      = require("./config/db");
const bookingRoutes  = require("./routes/bookings");

// ── Connect to MongoDB ────────────────────────────────────────────────────────
connectDB();

const app = express();

// ── Security headers ─────────────────────────────────────────────────────────
app.use(helmet());

// ── CORS — allow your Shopify store + local dev ───────────────────────────────
const allowedOrigins = [
  process.env.CLIENT_ORIGIN,          // e.g. https://your-store.myshopify.com
  "http://localhost:3000",
  "http://localhost:3001", // ADDED THIS
  "http://localhost:5173",
].filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow requests with no origin (server-to-server, Postman, etc.)
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-admin-secret"],
  })
);

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: "10kb" }));

// ── Request logging (dev only) ────────────────────────────────────────────────
if (process.env.NODE_ENV !== "production") {
  app.use(morgan("dev"));
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Public booking endpoint — 10 requests per 15 min per IP
const bookLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: "Too many booking attempts. Try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/book", bookLimit);

// General API limit — 100 req / 15 min
const apiLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api", apiLimit);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api", bookingRoutes);

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok", time: new Date() }));

// ── 404 handler ──────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ success: false, message: "Route not found" }));

// ── Global error handler ─────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: err.message || "Server error" });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () =>
  console.log(`Roadstar API running on http://localhost:${PORT}`)
);
