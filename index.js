require("dotenv").config();
const express     = require("express");
const http        = require("http");
const { Server }  = require("socket.io");
const cors        = require("cors");
const helmet      = require("helmet");
const morgan      = require("morgan");
const rateLimit   = require("express-rate-limit");

const connectDB     = require("./config/db");
const bookingRoutes = require("./routes/bookings");
const authRoutes    = require("./routes/auth");

connectDB();

const app    = express();
const server = http.createServer(app);

// ── CRITICAL: Tell Express to trust Render's proxy ──────────────────────────
// Render (and most cloud platforms) sit behind a reverse proxy that adds
// X-Forwarded-For headers. Without this, express-rate-limit throws
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR and crashes incoming requests.
app.set("trust proxy", 1);

// ── Socket.io ─────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET","POST"] },
});
app.use((req, _res, next) => { req.io = io; next(); });
io.on("connection", (socket) => {
  console.log("[Socket] connected:", socket.id);
  socket.on("disconnect", () => console.log("[Socket] disconnected:", socket.id));
});

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({
  origin: "*",
  methods: ["GET","POST","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","x-admin-secret"],
}));
app.options("*", cors());
app.use(express.json({ limit: "10kb" }));
app.use(morgan("dev"));

// ── Rate limiting (trust proxy must be set first) ─────────────────────────────
app.use("/api/book", rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts. Try again in 15 minutes." },
}));
app.use("/api/auth/login", rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many login attempts." },
}));
app.use("/api", rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
}));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api",      bookingRoutes);

app.get("/health", (_req, res) => res.json({ status: "ok", time: new Date().toISOString() }));
app.use((_req, res) => res.status(404).json({ success: false, message: "Route not found" }));
app.use((err, _req, res, _next) => {
  console.error(err.message);
  res.status(500).json({ success: false, message: err.message || "Server error" });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Roadstar API running on port ${PORT}`));
