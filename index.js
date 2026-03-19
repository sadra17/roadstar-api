require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const helmet    = require("helmet");
const morgan    = require("morgan");
const rateLimit = require("express-rate-limit");

const connectDB     = require("./config/db");
const bookingRoutes = require("./routes/bookings");

// ── Connect to MongoDB ────────────────────────────────────────────────────────
connectDB();

const app = express();

// ── Security headers ─────────────────────────────────────────────────────────
app.use(helmet());

// ── CORS ─────────────────────────────────────────────────────────────────────
// Allows:
//   • Any *.myshopify.com domain  (covers all Shopify storefronts)
//   • Your custom Shopify domain  (set CLIENT_ORIGIN on Render)
//   • Any localhost port          (React admin dashboard local dev)
//   • No-origin requests          (Postman, server-to-server)
const SHOPIFY_ORIGIN = process.env.CLIENT_ORIGIN || "";

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin)                              return cb(null, true); // Postman / server
      if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true); // any localhost
      if (origin.endsWith(".myshopify.com"))    return cb(null, true); // Shopify store
      if (SHOPIFY_ORIGIN && origin === SHOPIFY_ORIGIN) return cb(null, true); // custom domain
      console.warn(`CORS blocked origin: ${origin}`);
      cb(new Error(`Origin not allowed: ${origin}`));
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-admin-secret"],
  })
);

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: "10kb" }));

// ── Logging (dev only) ───────────────────────────────────────────────────────
if (process.env.NODE_ENV !== "production") {
  app.use(morgan("dev"));
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
const bookLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: "Too many booking attempts. Try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/book", bookLimit);

const apiLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api", apiLimit);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api", bookingRoutes);

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

// ── 404 ──────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ success: false, message: "Route not found" }));

// ── Global error handler ─────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err.message);
  res.status(500).json({ success: false, message: err.message || "Server error" });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () =>
  console.log(`Roadstar API running → http://localhost:${PORT}`)
);
