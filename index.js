require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const helmet    = require("helmet");
const morgan    = require("morgan");
const rateLimit = require("express-rate-limit");

const connectDB     = require("./config/db");
const bookingRoutes = require("./routes/bookings");

connectDB();

const app = express();

app.use(helmet({ crossOriginResourcePolicy: false }));

// ── CORS: open to all origins (admin protected by x-admin-secret header) ─────
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-admin-secret"],
}));
app.options("*", cors());

app.use(express.json({ limit: "10kb" }));
app.use(morgan("dev"));

// Rate limiting
const bookLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: "Too many attempts. Try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/book", bookLimit);

const apiLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api", apiLimit);

app.use("/api", bookingRoutes);

app.get("/health", (_req, res) =>
  res.json({ status: "ok", time: new Date().toISOString() })
);

app.use((_req, res) =>
  res.status(404).json({ success: false, message: "Route not found" })
);

app.use((err, _req, res, _next) => {
  console.error(err.message);
  res.status(500).json({ success: false, message: err.message || "Server error" });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () =>
  console.log(`Roadstar API running on port ${PORT}`)
);
