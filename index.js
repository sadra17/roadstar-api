require("dotenv").config();
const express     = require("express");
const http        = require("http");
const { Server }  = require("socket.io");
const cors        = require("cors");
const helmet      = require("helmet");
const morgan      = require("morgan");
const rateLimit   = require("express-rate-limit");

const connectDB       = require("./config/db");
const bookingRoutes   = require("./routes/bookings");
const authRoutes      = require("./routes/auth");

connectDB();

const app    = express();
const server = http.createServer(app);   // wrap express in http for Socket.io

// ── Socket.io ─────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_ORIGIN || "*",
    methods: ["GET", "POST"],
  },
});

// Attach io to every request so routes can emit events
app.use((req, _res, next) => { req.io = io; next(); });

io.on("connection", (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);
  socket.on("disconnect", () =>
    console.log(`[Socket] Client disconnected: ${socket.id}`)
  );
});

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: false }));

const allowedOrigins = [
  process.env.CLIENT_ORIGIN,
  "http://localhost:3000",
  "http://localhost:5173",
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.some(o => origin === o || origin.endsWith(".myshopify.com"))) {
      return cb(null, true);
    }
    cb(new Error(`CORS blocked: ${origin}`));
  },
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-admin-secret"],
  credentials: true,
}));
app.options("*", cors());

app.use(express.json({ limit: "10kb" }));
app.use(morgan("dev"));

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use("/api/book", rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  message: { success: false, message: "Too many attempts. Try again in 15 minutes." },
}));
app.use("/api/auth/login", rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { success: false, message: "Too many login attempts." },
}));
app.use("/api", rateLimit({ windowMs: 15 * 60 * 1000, max: 500 }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api",      bookingRoutes);

app.get("/health", (_req, res) =>
  res.json({ status: "ok", time: new Date().toISOString() })
);

app.use((_req, res) => res.status(404).json({ success: false, message: "Route not found" }));
app.use((err, _req, res, _next) => {
  console.error(err.message);
  res.status(500).json({ success: false, message: err.message || "Server error" });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Roadstar API v2 running on port ${PORT}`));
