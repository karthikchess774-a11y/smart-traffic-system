const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");
const crypto = require("node:crypto");
const express = require("express");
const cors = require("cors");
const path = require("path");
const mongoose = require("mongoose");
const nodemailer = require("nodemailer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const app = express();
const PORT = Number(process.env.PORT || 3000);
const FRONTEND_DIR = path.join(__dirname, "../frontend");
const JWT_SECRET = process.env.JWT_SECRET;
const MONGODB_URI = process.env.MONGODB_URI;
const COOKIE_NAME = "smart_traffic_token";

if (!JWT_SECRET || JWT_SECRET.length < 32) {
    throw new Error("JWT_SECRET must be set in backend/.env and contain at least 32 characters.");
}
if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is missing. Add your MongoDB Atlas connection string to backend/.env.");
}

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "20kb" }));

const userSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    // Phone is optional. Account verification uses email OTP only; no SMS/DLT provider is required.
    phone: { type: String, trim: true },
    emailVerified: { type: Boolean, default: false },
    passwordHash: { type: String, required: true, select: false },
    passwordResetOtpHash: { type: String, select: false },
    passwordResetOtpExpiresAt: { type: Date, select: false },
    passwordResetAttempts: { type: Number, default: 0, select: false },
    tokenVersion: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
}, { versionKey: false });
const User = mongoose.model("User", userSchema);

const pendingRegistrationSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    phone: { type: String, trim: true },
    passwordHash: { type: String, required: true },
    emailOtpHash: { type: String, required: true },
    emailOtpExpiresAt: { type: Date, required: true },
    emailAttempts: { type: Number, default: 0 },
    resendCount: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true, index: { expires: 0 } }
}, { timestamps: true, versionKey: false });
const PendingRegistration = mongoose.model("PendingRegistration", pendingRegistrationSchema);

function readToken(req) {
    const cookieHeader = req.headers.cookie || "";
    const item = cookieHeader.split(";").map(v => v.trim()).find(v => v.startsWith(COOKIE_NAME + "="));
    return item ? decodeURIComponent(item.slice(COOKIE_NAME.length + 1)) : null;
}
async function verifyUser(req, res, next) {
    const token = readToken(req);
    if (!token) return res.status(401).json({ status: "error", message: "Please log in to continue." });
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        const user = await User.findById(payload.sub).select("tokenVersion");
        if (!user || Number(payload.tv || 0) !== Number(user.tokenVersion || 0)) {
            res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/" });
            return res.status(401).json({ status: "error", message: "Your session is no longer valid. Please log in again." });
        }
        req.auth = payload;
        next();
    } catch (_) {
        res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/" });
        return res.status(401).json({ status: "error", message: "Your session expired. Please log in again." });
    }
}
function setAuthCookie(res, user) {
    const token = jwt.sign({ sub: user._id.toString(), email: user.email, name: user.name, tv: Number(user.tokenVersion || 0) }, JWT_SECRET, { expiresIn: "7d" });
    res.cookie(COOKIE_NAME, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", maxAge: 7 * 24 * 60 * 60 * 1000, path: "/" });
}
function validatePassword(password) {
    if (typeof password !== "string" || password.length < 12 || password.length > 128 || Buffer.byteLength(password, "utf8") > 72) {
        return "Password must be 12–128 characters (maximum 72 UTF-8 bytes for bcrypt).";
    }
    if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
        return "Use at least one uppercase letter, lowercase letter, number, and special character.";
    }
    return null;
}
function clearAuthCookie(res) {
    res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/" });
}
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false, message: { status: "error", message: "Too many attempts. Please try again in 15 minutes." } });
const otpSendLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 4, standardHeaders: "draft-8", legacyHeaders: false, message: { status: "error", message: "Too many OTP requests. Please wait before trying again." } });

function normalizePhone(value) {
    const raw = String(value || "").trim().replace(/[\s()-]/g, "");
    if (!raw) return null;
    const phone = raw.startsWith("+") ? raw.slice(1) : raw;
    const normalized = /^\d{10}$/.test(phone) ? "91" + phone : phone;
    return /^[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
}
function makeOtp() { return String(crypto.randomInt(0, 1000000)).padStart(6, "0"); }
function hashOtp(otp, purpose) {
    return crypto.createHmac("sha256", JWT_SECRET).update(`${purpose}:${otp}`).digest("hex");
}
function safeEqualHex(a, b) {
    if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !/^[a-f0-9]+$/i.test(a) || !/^[a-f0-9]+$/i.test(b)) return false;
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
const emailTransporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.SMTP_EMAIL, pass: process.env.SMTP_APP_PASSWORD }
});
async function sendEmailOtp(email, otp, purpose = "registration") {
    if (!process.env.SMTP_EMAIL || !process.env.SMTP_APP_PASSWORD) throw new Error("Gmail SMTP credentials are missing.");
    const reset = purpose === "password-reset";
    const subject = reset ? "Your Smart Traffic password reset code" : "Your Smart Traffic email verification OTP";
    const description = reset ? "Use this code to reset your password" : "Your Smart Traffic email verification OTP is";
    const expiry = reset ? "10 minutes" : "5 minutes";
    await emailTransporter.sendMail({
        from: `"Smart Traffic" <${process.env.SMTP_EMAIL}>`, to: email, subject,
        text: `${description}: ${otp}. It expires in ${expiry}. Do not share this code.`,
        html: `<div style="background:#071426;color:white;padding:30px;font-family:Arial;border-radius:12px;"><h2>Smart Traffic ${reset ? "Password Reset" : "Verification"}</h2><p>${description}:</p><h1 style="letter-spacing:10px;color:#38bdf8;">${otp}</h1><p>This code expires in ${expiry}.</p><p>Do not share this code with anyone.</p></div>`
    });
}
async function issueRegistrationOtp(pending, isResend = false) {
    const otp = makeOtp();
    pending.emailOtpHash = hashOtp(otp, "registration");
    pending.emailOtpExpiresAt = new Date(Date.now() + 5 * 60 * 1000);
    pending.expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    pending.emailAttempts = 0;
    if (isResend) pending.resendCount += 1;
    await pending.save();
    await sendEmailOtp(pending.email, otp, "registration");
}

app.post("/api/auth/register", otpSendLimiter, async (req, res) => {
    try {
        const name = String(req.body.name || "").trim();
        const email = String(req.body.email || "").trim().toLowerCase();
        const phone = normalizePhone(req.body.phone);
        const password = String(req.body.password || "");
        const passwordError = validatePassword(password);
        if (name.length < 2 || name.length > 80) return res.status(400).json({ status: "error", message: "Name must be between 2 and 80 characters." });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ status: "error", message: "Enter a valid email address." });
        if (passwordError) return res.status(400).json({ status: "error", message: passwordError });
        if (await User.exists({ email })) return res.status(409).json({ status: "error", message: "An account with this email already exists." });
        const passwordHash = await bcrypt.hash(password, 12);
        let pending = await PendingRegistration.findOne({ email });
        if (!pending) {
            pending = new PendingRegistration({ name, email, phone, passwordHash, resendCount: 0 });
            await issueRegistrationOtp(pending);
        } else {
            if (pending.resendCount >= 3) return res.status(429).json({ status: "error", message: "Verification resend limit reached. Please try again later." });
            pending.name = name;
            pending.phone = phone;
            pending.passwordHash = passwordHash;
            await issueRegistrationOtp(pending, true);
        }
        return res.status(202).json({ status: "success", message: "A verification code has been sent to your email. It expires in 5 minutes.", email });
    } catch (error) {
        console.error("Registration OTP error:", error.message);
        return res.status(502).json({ status: "error", message: "Could not send the verification email. Check SMTP configuration and try again." });
    }
});

app.post("/api/auth/verify-registration", authLimiter, async (req, res) => {
    try {
        const email = String(req.body.email || "").trim().toLowerCase();
        const emailOtp = String(req.body.emailOtp || "").trim();
        if (!/^\d{6}$/.test(emailOtp)) return res.status(400).json({ status: "error", message: "Enter the 6-digit email verification code." });
        const pending = await PendingRegistration.findOne({ email });
        if (!pending) return res.status(404).json({ status: "error", message: "Registration expired or not found. Please register again." });
        if (pending.emailOtpExpiresAt.getTime() < Date.now() || pending.expiresAt.getTime() < Date.now()) return res.status(410).json({ status: "error", message: "Verification code expired. Please request a new code." });
        if (pending.emailAttempts >= 5) return res.status(429).json({ status: "error", message: "Too many incorrect attempts. Request a new verification code." });
        const emailOk = safeEqualHex(pending.emailOtpHash, hashOtp(emailOtp, "registration"));
        if (!emailOk) {
            pending.emailAttempts += 1;
            await pending.save();
            return res.status(400).json({ status: "error", message: "The verification code is incorrect." });
        }
        const user = await User.create({ name: pending.name, email: pending.email, phone: pending.phone, passwordHash: pending.passwordHash, emailVerified: true });
        await PendingRegistration.deleteOne({ _id: pending._id });
        setAuthCookie(res, user);
        return res.status(201).json({ status: "success", message: "Email verified. Your account is active.", user: { name: user.name, email: user.email, phone: user.phone || null } });
    } catch (error) {
        if (error.code === 11000) return res.status(409).json({ status: "error", message: "An account with this email already exists." });
        console.error("OTP verification error:", error.message);
        return res.status(500).json({ status: "error", message: "Could not verify your account. Please try again." });
    }
});

app.post("/api/auth/resend-registration-otp", otpSendLimiter, async (req, res) => {
    try {
        const email = String(req.body.email || "").trim().toLowerCase();
        const pending = await PendingRegistration.findOne({ email });
        if (!pending) return res.status(404).json({ status: "error", message: "Pending registration not found. Please register again." });
        if (pending.resendCount >= 3) return res.status(429).json({ status: "error", message: "Resend limit reached. Please start registration again later." });
        await issueRegistrationOtp(pending, true);
        return res.json({ status: "success", message: "A new email verification code has been sent." });
    } catch (error) {
        console.error("OTP resend error:", error.message);
        return res.status(502).json({ status: "error", message: "Could not resend the verification email." });
    }
});

// Forgot password: always return the same response to avoid revealing registered email addresses.
app.post("/api/auth/forgot-password", otpSendLimiter, async (req, res) => {
    const generic = { status: "success", message: "If an account exists for that email, a password reset code has been sent." };
    try {
        const email = String(req.body.email || "").trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(200).json(generic);
        const user = await User.findOne({ email }).select("+passwordResetOtpHash +passwordResetOtpExpiresAt +passwordResetAttempts");
        if (!user || user.emailVerified === false) return res.status(200).json(generic);
        const otp = makeOtp();
        user.passwordResetOtpHash = hashOtp(otp, "password-reset");
        user.passwordResetOtpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
        user.passwordResetAttempts = 0;
        await user.save();
        try { await sendEmailOtp(email, otp, "password-reset"); }
        catch (mailError) { console.error("Password reset email failed:", mailError.message); }
        return res.status(200).json(generic);
    } catch (error) {
        console.error("Forgot password error:", error.message);
        return res.status(200).json(generic);
    }
});

app.post("/api/auth/reset-password", authLimiter, async (req, res) => {
    try {
        const email = String(req.body.email || "").trim().toLowerCase();
        const otp = String(req.body.otp || "").trim();
        const newPassword = String(req.body.newPassword || "");
        const passwordError = validatePassword(newPassword);
        if (!/^\d{6}$/.test(otp)) return res.status(400).json({ status: "error", message: "Enter the 6-digit reset code." });
        if (passwordError) return res.status(400).json({ status: "error", message: passwordError });
        const user = await User.findOne({ email }).select("+passwordHash +passwordResetOtpHash +passwordResetOtpExpiresAt +passwordResetAttempts");
        if (!user || !user.passwordResetOtpHash || !user.passwordResetOtpExpiresAt || user.passwordResetOtpExpiresAt.getTime() < Date.now()) {
            return res.status(400).json({ status: "error", message: "Invalid or expired reset code. Request a new one." });
        }
        if (user.passwordResetAttempts >= 5) return res.status(429).json({ status: "error", message: "Too many incorrect attempts. Request a new reset code." });
        if (!safeEqualHex(user.passwordResetOtpHash, hashOtp(otp, "password-reset"))) {
            user.passwordResetAttempts += 1;
            await user.save();
            return res.status(400).json({ status: "error", message: "Invalid or expired reset code. Request a new one." });
        }
        user.passwordHash = await bcrypt.hash(newPassword, 12);
        user.passwordResetOtpHash = undefined;
        user.passwordResetOtpExpiresAt = undefined;
        user.passwordResetAttempts = 0;
        user.tokenVersion = Number(user.tokenVersion || 0) + 1;
        await user.save();
        clearAuthCookie(res);
        return res.json({ status: "success", message: "Password reset successfully. Please log in with your new password." });
    } catch (error) {
        console.error("Password reset error:", error.message);
        return res.status(500).json({ status: "error", message: "Could not reset your password. Please try again." });
    }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
    try {
        const email = String(req.body.email || "").trim().toLowerCase();
        const password = String(req.body.password || "");
        const user = await User.findOne({ email }).select("+passwordHash");
        if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ status: "error", message: "Invalid email or password." });
        // Legacy accounts created before OTP was introduced remain usable; new accounts must pass both checks.
        if (user.emailVerified === false) return res.status(403).json({ status: "error", message: "Please verify your email before logging in." });
        setAuthCookie(res, user);
        return res.json({ status: "success", user: { name: user.name, email: user.email, phone: user.phone || null } });
    } catch (error) {
        console.error("Login error:", error.message);
        return res.status(500).json({ status: "error", message: "Login failed. Please try again." });
    }
});

app.post("/api/auth/change-password", verifyUser, authLimiter, async (req, res) => {
    try {
        const currentPassword = String(req.body.currentPassword || "");
        const newPassword = String(req.body.newPassword || "");
        const passwordError = validatePassword(newPassword);
        if (passwordError) return res.status(400).json({ status: "error", message: passwordError });
        const user = await User.findById(req.auth.sub).select("+passwordHash");
        if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) return res.status(401).json({ status: "error", message: "Current password is incorrect." });
        if (await bcrypt.compare(newPassword, user.passwordHash)) return res.status(400).json({ status: "error", message: "Choose a password different from your current password." });
        user.passwordHash = await bcrypt.hash(newPassword, 12);
        user.tokenVersion = Number(user.tokenVersion || 0) + 1;
        await user.save();
        clearAuthCookie(res);
        return res.json({ status: "success", message: "Password changed. Please log in again." });
    } catch (error) {
        console.error("Change password error:", error.message);
        return res.status(500).json({ status: "error", message: "Could not change your password. Please try again." });
    }
});

app.get("/api/auth/me", verifyUser, async (req, res) => {
    const user = await User.findById(req.auth.sub).select("name email phone emailVerified");
    if (!user) return res.status(401).json({ status: "error", message: "Account not found. Please log in again." });
    res.json({ status: "success", user: { name: user.name, email: user.email, phone: user.phone || null, emailVerified: user.emailVerified !== false } });
});

app.post("/api/auth/logout", (req, res) => {
    clearAuthCookie(res);
    res.json({ status: "success", message: "Logged out successfully." });
});

// Public health endpoint used by the dashboard's System Status indicator.
// The server starts only after MongoDB connects, but report readiness explicitly.
app.get("/api/status", (req, res) => {
    const databaseConnected = mongoose.connection.readyState === 1;
    return res.status(databaseConnected ? 200 : 503).json({
        status: databaseConnected ? "success" : "error",
        backend: "connected",
        database: databaseConnected ? "connected" : "disconnected",
        message: databaseConnected
            ? "Smart Traffic backend and MongoDB are connected."
            : "Backend is running but MongoDB is not connected."
    });
});

app.get("/", (req, res) => res.redirect("/login.html"));
app.get("/app", verifyUser, (req, res) => res.sendFile(path.join(FRONTEND_DIR, "index.html")));
app.use(express.static(FRONTEND_DIR, { index: false }));

// Require authentication for all application APIs except the public health check and auth endpoints.
app.use("/api", (req, res, next) => {
    if (req.path === "/status" || req.path.startsWith("/auth/")) return next();
    return verifyUser(req, res, next);
});

// =====================================================
// LIVE LOCATION STORAGE
// =====================================================

let latestLocation = null;


// =====================================================
// GPS DISTANCE CALCULATOR
// =====================================================

function calculateDistanceKm(
    lat1,
    lon1,
    lat2,
    lon2
) {

    const earthRadiusKm = 6371;

    const dLat =
        (lat2 - lat1) *
        Math.PI /
        180;

    const dLon =
        (lon2 - lon1) *
        Math.PI /
        180;

    const a =
        Math.sin(dLat / 2) *
        Math.sin(dLat / 2) +

        Math.cos(
            lat1 *
            Math.PI /
            180
        ) *

        Math.cos(
            lat2 *
            Math.PI /
            180
        ) *

        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);

    const c =
        2 *
        Math.atan2(
            Math.sqrt(a),
            Math.sqrt(1 - a)
        );

    return earthRadiusKm * c;
}


// =====================================================
// RECEIVE PHONE GPS LOCATION
// =====================================================

app.post(
    "/api/location",
    (req, res) => {

        try {

            const {
                latitude,
                longitude,
                accuracy,
                speed
            } = req.body;


            if (
                typeof latitude !== "number" ||
                typeof longitude !== "number" ||
                !Number.isFinite(latitude) ||
                !Number.isFinite(longitude)
            ) {

                return res.status(400).json({

                    status: "error",

                    message:
                        "Invalid latitude or longitude."

                });

            }


            if (
                latitude < -90 ||
                latitude > 90 ||
                longitude < -180 ||
                longitude > 180
            ) {

                return res.status(400).json({

                    status: "error",

                    message:
                        "GPS coordinates are outside valid range."

                });

            }


            // -------------------------------------------------
            // GPS JUMP PROTECTION
            // -------------------------------------------------

            if (latestLocation) {

                const distanceKm =
                    calculateDistanceKm(

                        latestLocation.latitude,
                        latestLocation.longitude,

                        latitude,
                        longitude

                    );


                const previousTime =
                    latestLocation.timestamp;


                const currentTime =
                    Date.now();


                const elapsedSeconds =
                    Math.max(

                        (
                            currentTime -
                            previousTime
                        ) / 1000,

                        1

                    );


                const MAX_SPEED_KMH = 180;


                const maximumAllowedDistanceKm =
                    Math.max(

                        0.5,

                        (
                            MAX_SPEED_KMH *
                            elapsedSeconds
                        ) / 3600

                    );


                console.log(
                    "📏 GPS Distance:",
                    distanceKm.toFixed(3),
                    "km"
                );


                console.log(
                    "⏱️ GPS Time:",
                    elapsedSeconds.toFixed(1),
                    "seconds"
                );


                console.log(
                    "🚗 Maximum Allowed:",
                    maximumAllowedDistanceKm.toFixed(3),
                    "km"
                );


                if (
                    distanceKm >
                    maximumAllowedDistanceKm
                ) {

                    console.log("");

                    console.log(
                        "========================================"
                    );

                    console.log(
                        "🚫 GPS JUMP REJECTED"
                    );

                    console.log(
                        "========================================"
                    );


                    console.log(
                        "📍 Previous:",
                        latestLocation.latitude,
                        latestLocation.longitude
                    );


                    console.log(
                        "📍 New:",
                        latitude,
                        longitude
                    );


                    console.log(
                        "📏 Jump Distance:",
                        distanceKm.toFixed(2),
                        "km"
                    );


                    console.log(
                        "🚗 Allowed Distance:",
                        maximumAllowedDistanceKm.toFixed(2),
                        "km"
                    );


                    console.log(
                        "========================================"
                    );

                    console.log("");


                    return res.json({

                        status:
                            "ignored",

                        message:
                            "GPS jump rejected because the movement is physically impossible.",

                        location:
                            latestLocation,

                        rejectedLocation: {

                            latitude,

                            longitude

                        }

                    });

                }

            }


            // -------------------------------------------------
            // ACCEPT LOCATION
            // -------------------------------------------------

            latestLocation = {

                latitude,

                longitude,

                accuracy:
                    typeof accuracy === "number"
                        ? accuracy
                        : null,

                speed:
                    typeof speed === "number"
                        ? speed
                        : null,

                timestamp:
                    Date.now()

            };


            console.log("");

            console.log(
                "📍 Live Location ACCEPTED:"
            );

            console.log(
                "Latitude:",
                latitude
            );

            console.log(
                "Longitude:",
                longitude
            );

            console.log(
                "Accuracy:",
                accuracy
            );

            console.log(
                "Speed:",
                speed
            );


            res.json({

                status:
                    "success",

                message:
                    "Location received successfully.",

                location:
                    latestLocation

            });


        } catch (error) {

            console.error(
                "Location POST Error:",
                error
            );


            res.status(500).json({

                status:
                    "error",

                message:
                    "Unable to save location."

            });

        }

    }
);


// =====================================================
// GET LATEST PHONE LOCATION
// =====================================================

app.get(
    "/api/location",
    (req, res) => {

        if (!latestLocation) {

            return res.json({

                status:
                    "success",

                location:
                    null,

                message:
                    "No location received yet."

            });

        }


        res.json({

            status:
                "success",

            location:
                latestLocation

        });

    }
);


// =====================================================
// GET TOMTOM API KEY
// =====================================================

function getTomTomKey() {

    return process.env.TOMTOM_API_KEY;

}

// =====================================================
// TOMTOM FLOW SEGMENT API + RATE-LIMIT GUARD
// =====================================================
const trafficScanCache = new Map();
let tomTomRateLimitedUntil = 0;
const TRAFFIC_SCAN_CACHE_MS = 60 * 1000;
const TOMTOM_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
let manualTrafficScanInProgress = false;

function classifyFlowSegment(flow) {
    const currentSpeed = Number(flow.currentSpeed);
    const freeFlowSpeed = Number(flow.freeFlowSpeed);
    const isClosed = flow.roadClosure === true;

    if (isClosed) return "HEAVY";
    if (!Number.isFinite(currentSpeed) || !Number.isFinite(freeFlowSpeed) || freeFlowSpeed <= 0) {
        return "UNKNOWN";
    }

    // Project heuristic: classify by reduction from the road's free-flow speed.
    // 15-29% reduction = MODERATE; 30%+ reduction = HEAVY.
    const reduction = Math.max(0, 1 - (currentSpeed / freeFlowSpeed));
    if (reduction >= 0.30) return "HEAVY";
    if (reduction >= 0.15) return "MODERATE";
    return "NORMAL";
}

async function getTomTomFlowSegment(latitude, longitude) {
    const apiKey = getTomTomKey();
    if (!apiKey) throw new Error("TomTom API key is missing from backend .env.");

    if (Date.now() < tomTomRateLimitedUntil) {
        const waitSeconds = Math.ceil((tomTomRateLimitedUntil - Date.now()) / 1000);
        const error = new Error(`TomTom rate limit cooldown active. Retry in ${waitSeconds} seconds.`);
        error.code = "LOCAL_RATE_LIMIT_COOLDOWN";
        throw error;
    }

    const url = "https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json" +
        `?key=${encodeURIComponent(apiKey)}` +
        `&point=${encodeURIComponent(`${latitude},${longitude}`)}` +
        "&unit=kmph";

    const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" }
    });

    let data = {};
    try { data = await response.json(); } catch (_) {}

    if (response.status === 429) {
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterSeconds = Number(retryAfterHeader);
        const cooldownMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : TOMTOM_RATE_LIMIT_COOLDOWN_MS;
        tomTomRateLimitedUntil = Math.max(tomTomRateLimitedUntil, Date.now() + cooldownMs);
        const error = new Error(`TomTom rate limit reached. Pausing traffic requests for ${Math.ceil(cooldownMs / 1000)} seconds to protect your quota.`);
        error.code = "TOMTOM_RATE_LIMIT";
        throw error;
    }

    if (!response.ok) {
        const message = data?.error?.description || data?.detailedError?.message ||
            data?.message || `TomTom Flow Segment API failed (HTTP ${response.status}).`;
        const error = new Error(message);
        error.code = `TOMTOM_HTTP_${response.status}`;
        throw error;
    }

    if (!data.flowSegmentData) {
        throw new Error("TomTom response did not contain flowSegmentData.");
    }

    return data.flowSegmentData;
}




// =====================================================
// CALL TOMTOM ROUTING API
// =====================================================

// Shared routing cache prevents the main dashboard and compass widget from
// issuing duplicate TomTom requests for the same nearby coordinates.
const tomTomRouteCache = new Map();
const TOMTOM_ROUTE_CACHE_MS = 90 * 1000;

async function getTomTomRoute(

    fromLat,
    fromLon,
    toLat,
    toLon,
    maxAlternatives = 0

) {

    if (Date.now() < tomTomRateLimitedUntil) {
        const waitSeconds = Math.ceil((tomTomRateLimitedUntil - Date.now()) / 1000);
        const error = new Error(`TomTom rate limit cooldown active. Retry in ${waitSeconds} seconds.`);
        error.code = "LOCAL_RATE_LIMIT_COOLDOWN";
        throw error;
    }

    const cacheKey = [
        Number(fromLat).toFixed(3), Number(fromLon).toFixed(3),
        Number(toLat).toFixed(3), Number(toLon).toFixed(3), maxAlternatives
    ].join(":");
    const cachedRoute = tomTomRouteCache.get(cacheKey);
    if (cachedRoute && Date.now() - cachedRoute.timestamp < TOMTOM_ROUTE_CACHE_MS) {
        return cachedRoute.data;
    }

    const apiKey =
        getTomTomKey();


    if (!apiKey) {

        throw new Error(
            "TomTom API key is missing from .env"
        );

    }


    const locations =
        `${fromLat},${fromLon}:${toLat},${toLon}`;


    const url =
        "https://api.tomtom.com/maps/orbis/routing/" +
        "calculateRoute/" +
        encodeURIComponent(locations) +
        "/json" +
        "?apiVersion=2" +
        "&traffic=live" +
        "&routeType=fast" +
        "&travelMode=car" +
        `&maxAlternatives=${maxAlternatives}` +
        "&sectionType=traffic" +
        "&key=" +
        encodeURIComponent(apiKey);


    const response =
        await fetch(

            url,

            {

                method:
                    "GET",

                headers: {

                    "TomTom-Api-Version":
                        "2",

                    "Accept":
                        "application/json"

                }

            }

        );


    let data = {};
    try {
        data = await response.json();
    } catch (_) {}

    if (response.status === 429) {
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterSeconds = Number(retryAfterHeader);
        const cooldownMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : TOMTOM_RATE_LIMIT_COOLDOWN_MS;
        tomTomRateLimitedUntil = Math.max(tomTomRateLimitedUntil, Date.now() + cooldownMs);
        const error = new Error(`TomTom routing rate limit reached. Pausing requests for ${Math.ceil(cooldownMs / 1000)} seconds.`);
        error.code = "TOMTOM_RATE_LIMIT";
        throw error;
    }

    if (!response.ok) {

        console.error(
            "TomTom API Error:",
            data
        );


        throw new Error(

            data?.detailedError?.message ||

            data?.error?.description ||

            "TomTom API request failed."

        );

    }


    tomTomRouteCache.set(cacheKey, { timestamp: Date.now(), data });
    return data;

}


// =====================================================
// TOMTOM LIVE TRAFFIC + ROUTING
// =====================================================

app.get(
    "/api/tomtom-route",
    async (req, res) => {

        try {

            const {

                fromLat,
                fromLon,
                toLat,
                toLon

            } = req.query;


            if (
                !fromLat ||
                !fromLon ||
                !toLat ||
                !toLon
            ) {

                return res.status(400).json({

                    status:
                        "error",

                    message:
                        "Please provide fromLat, fromLon, toLat and toLon."

                });

            }


            console.log(
                "🛣️ TomTom Route Request"
            );


            console.log(
                "FROM:",
                fromLat,
                fromLon
            );


            console.log(
                "TO:",
                toLat,
                toLon
            );


            const data =
                await getTomTomRoute(

                    fromLat,
                    fromLon,

                    toLat,
                    toLon,

                    2

                );


            console.log(
                "✅ TomTom Routing Success"
            );


            res.json({

                status:
                    "success",

                data:
                    data

            });


        } catch (error) {

            console.error(
                "TomTom Route Error:",
                error
            );


            res.status(500).json({

                status:
                    "error",

                message:
                    "Unable to get TomTom route data.",

                error:
                    error.message

            });

        }

    }
);


// =====================================================
// ALTERNATE ROUTE RECOMMENDATION
// =====================================================

app.get(
    "/api/alternate-route",
    async (req, res) => {

        try {

            const {

                fromLat,
                fromLon,
                toLat,
                toLon

            } = req.query;


            if (
                !fromLat ||
                !fromLon ||
                !toLat ||
                !toLon
            ) {

                return res.status(400).json({

                    status:
                        "error",

                    message:
                        "Please provide fromLat, fromLon, toLat and toLon."

                });

            }


            const data =
                await getTomTomRoute(

                    fromLat,
                    fromLon,

                    toLat,
                    toLon,

                    2

                );


            if (
                !data.routes ||
                data.routes.length === 0
            ) {

                return res.json({

                    status:
                        "success",

                    recommendation:
                        null,

                    routes:
                        [],

                    message:
                        "No routes were found."

                });

            }


            const routes =
                data.routes.map(

                    (route, index) => {

                        const summary =
                            route.summary || {};


                        const travelTime =
                            summary.travelTimeInSeconds || 0;


                        const trafficDelay =
                            summary.trafficDelayInSeconds || 0;


                        const distance =
                            summary.lengthInMeters || 0;


                        return {

                            routeNumber:
                                index + 1,

                            travelTimeInSeconds:
                                travelTime,

                            travelTimeMinutes:
                                Math.round(
                                    travelTime / 60
                                ),

                            trafficDelayInSeconds:
                                trafficDelay,

                            trafficDelayMinutes:
                                Math.round(
                                    trafficDelay / 60
                                ),

                            distanceInMeters:
                                distance,

                            distanceKm:
                                Number(
                                    (
                                        distance / 1000
                                    ).toFixed(2)
                                ),

                            effectiveTravelTime:
                                travelTime

                        };

                    }

                );


            let recommendedIndex = 0;


            for (
                let i = 1;
                i < routes.length;
                i++
            ) {

                if (

                    routes[i].effectiveTravelTime
                    <
                    routes[
                        recommendedIndex
                    ].effectiveTravelTime

                ) {

                    recommendedIndex =
                        i;

                }

                else if (

                    routes[i].effectiveTravelTime
                    ===
                    routes[
                        recommendedIndex
                    ].effectiveTravelTime

                ) {

                    if (

                        routes[i]
                            .trafficDelayInSeconds
                        <
                        routes[
                            recommendedIndex
                        ]
                            .trafficDelayInSeconds

                    ) {

                        recommendedIndex =
                            i;

                    }

                }

            }


            const recommendedRoute =
                routes[recommendedIndex];


            const currentRoute =
                routes[0];


            let timeSaved =

                currentRoute
                    .travelTimeInSeconds

                -

                recommendedRoute
                    .travelTimeInSeconds;


            if (timeSaved < 0) {

                timeSaved = 0;

            }


            const isAlternateBetter =

                recommendedRoute.routeNumber !== 1 &&

                timeSaved > 0;


            let recommendationMessage;


            if (isAlternateBetter) {

                recommendationMessage =

                    `⭐ Alternate Route ${recommendedRoute.routeNumber} ` +

                    `is recommended. ` +

                    `It may save approximately ` +

                    `${Math.round(
                        timeSaved / 60
                    )} minutes.`;

            }

            else {

                recommendationMessage =

                    "🟢 Current route is currently the fastest available route.";

            }


            res.json({

                status:
                    "success",

                recommendation: {

                    routeNumber:
                        recommendedRoute.routeNumber,

                    message:
                        recommendationMessage,

                    isAlternateBetter:
                        isAlternateBetter,

                    timeSavedInSeconds:
                        timeSaved,

                    timeSavedMinutes:
                        Math.round(
                            timeSaved / 60
                        )

                },

                routes:
                    routes,

                tomtomRoutes:
                    data.routes

            });


        } catch (error) {

            console.error(
                "Alternate Route Error:",
                error
            );


            res.status(500).json({

                status:
                    "error",

                message:
                    "Unable to calculate alternate route.",

                error:
                    error.message

            });

        }

    }
);


// =====================================================
// DESTINATION POINT CALCULATOR
// =====================================================

function destinationPoint(

    latitude,
    longitude,
    distanceKm,
    bearingDegrees

) {

    const earthRadiusKm =
        6371;


    const bearing =
        bearingDegrees *
        Math.PI /
        180;


    const lat1 =
        latitude *
        Math.PI /
        180;


    const lon1 =
        longitude *
        Math.PI /
        180;


    const angularDistance =
        distanceKm /
        earthRadiusKm;


    const lat2 =
        Math.asin(

            Math.sin(lat1) *
            Math.cos(angularDistance)

            +

            Math.cos(lat1) *
            Math.sin(angularDistance) *
            Math.cos(bearing)

        );


    const lon2 =

        lon1 +

        Math.atan2(

            Math.sin(bearing) *
            Math.sin(angularDistance) *
            Math.cos(lat1),

            Math.cos(angularDistance)

            -

            Math.sin(lat1) *
            Math.sin(lat2)

        );


    return {

        latitude:
            lat2 *
            180 /
            Math.PI,

        longitude:
            lon2 *
            180 /
            Math.PI

    };

}


// =====================================================
// ROAD-AWARE 5 KM TRAFFIC MONITOR
// =====================================================

app.get(
    "/api/traffic-monitor",
    async (req, res) => {

        try {

            if (!latestLocation) {

                return res.json({

                    status:
                        "success",

                    traffic:
                        null,

                    monitoring:
                        null,

                    message:
                        "Waiting for phone location."

                });

            }


            const apiKey =
                getTomTomKey();


            if (!apiKey) {

                return res.status(500).json({

                    status:
                        "error",

                    message:
                        "TomTom API key is missing."

                });

            }


            const centerLatitude =
                latestLocation.latitude;


            const centerLongitude =
                latestLocation.longitude;


            const monitoringRadiusKm =
                5;

            if (Date.now() < tomTomRateLimitedUntil) {
                const waitSeconds = Math.ceil((tomTomRateLimitedUntil - Date.now()) / 1000);
                return res.status(429).json({
                    status: "rate_limited",
                    traffic: null,
                    monitoring: null,
                    message: `TomTom rate limit cooldown active. Try again in about ${waitSeconds} seconds.`
                });
            }

            console.log("");

            console.log(
                "========================================"
            );

            console.log(
                "🚦 ROAD-AWARE 5 KM TRAFFIC MONITOR"
            );

            console.log(
                "========================================"
            );

            console.log(
                "📍 Center:",
                centerLatitude,
                centerLongitude
            );

            console.log(
                "⭕ Radius:",
                monitoringRadiusKm,
                "km"
            );


            const directions = [

    {
        name: "NORTH",
        bearing: 0
    },

    {
        name: "EAST",
        bearing: 90
    },

    {
        name: "SOUTH",
        bearing: 180
    },

    {
        name: "WEST",
        bearing: 270
    }

];


            const directionResults = [];


            for (
                const direction
                of directions
            ) {

                const target =
                    destinationPoint(

                        centerLatitude,

                        centerLongitude,

                        monitoringRadiusKm,

                        direction.bearing

                    );


                console.log(
                    `🚦 Checking ${direction.name}:`,
                    target.latitude,
                    target.longitude
                );


                try {

                    const data =
                        await getTomTomRoute(

                            centerLatitude,

                            centerLongitude,

                            target.latitude,

                            target.longitude,

                            0

                        );


                    if (
                        !data.routes ||
                        data.routes.length === 0
                    ) {

                        directionResults.push({

                            direction:
                                direction.name,

                            bearing:
                                direction.bearing,

                            latitude:
                                target.latitude,

                            longitude:
                                target.longitude,

                            available:
                                false,

                            delayInSeconds:
                                0,

                            travelTimeInSeconds:
                                0,

                            distanceInMeters:
                                0

                        });


                        continue;

                    }


                    const route =
                        data.routes[0];


                    const summary =
                        route.summary || {};


                    const trafficDelay =
                        Number(
                            summary.trafficDelayInSeconds
                        ) || 0;


                    const travelTime =
                        Number(
                            summary.travelTimeInSeconds
                        ) || 0;


                    const distance =
                        Number(
                            summary.lengthInMeters
                        ) || 0;


                    directionResults.push({

                        direction:
                            direction.name,

                        bearing:
                            direction.bearing,

                        latitude:
                            target.latitude,

                        longitude:
                            target.longitude,

                        available:
                            true,

                        delayInSeconds:
                            trafficDelay,

                        delayMinutes:
                            Number(
                                (
                                    trafficDelay /
                                    60
                                ).toFixed(1)
                            ),

                        travelTimeInSeconds:
                            travelTime,

                        travelTimeMinutes:
                            Number(
                                (
                                    travelTime /
                                    60
                                ).toFixed(1)
                            ),

                        distanceInMeters:
                            distance,

                        distanceKm:
                            Number(
                                (
                                    distance /
                                    1000
                                ).toFixed(2)
                            )

                    });


                    console.log(
                        `   ${direction.name}:`,
                        `${trafficDelay}s delay`,
                        `${Math.round(
                            travelTime / 60
                        )} min travel`
                    );


                } catch (directionError) {

                    console.error(
                        `❌ ${direction.name} failed:`,
                        directionError.message
                    );


                    directionResults.push({

                        direction:
                            direction.name,

                        bearing:
                            direction.bearing,

                        latitude:
                            target.latitude,

                        longitude:
                            target.longitude,

                        available:
                            false,

                        delayInSeconds:
                            0,

                        travelTimeInSeconds:
                            0,

                        distanceInMeters:
                            0,

                        error:
                            directionError.message

                    });

                }

            }


            const validResults =
                directionResults.filter(

                    result =>
                        result.available === true

                );


            if (
                validResults.length === 0
            ) {

                return res.json({

                    status:
                        "success",

                    traffic:
                        null,

                    monitoring: {

                        center: {

                            latitude:
                                centerLatitude,

                            longitude:
                                centerLongitude

                        },

                        radiusKm:
                            monitoringRadiusKm,

                        directions:
                            directionResults

                    },

                    message:
                        "No traffic routes available."

                });

            }


            let worstDirection =
                validResults[0];


            for (
                let i = 1;
                i < validResults.length;
                i++
            ) {

                if (

                    validResults[i]
                        .delayInSeconds

                    >

                    worstDirection
                        .delayInSeconds

                ) {

                    worstDirection =
                        validResults[i];

                }

            }


            const maximumDelay =
                worstDirection
                    .delayInSeconds;


            const totalDelay =
                validResults.reduce(

                    (
                        total,
                        result
                    ) => {

                        return (
                            total +
                            result.delayInSeconds
                        );

                    },

                    0

                );


            const averageDelay =
                totalDelay /
                validResults.length;


            let level;

            let message;


            if (
                maximumDelay >= 300
            ) {

                level =
                    "HEAVY";

                message =
                    "🚨 Heavy traffic detected within the monitoring area.";

            }


            else if (
                maximumDelay >= 120
            ) {

                level =
                    "MODERATE";

                message =
                    "🟠 Moderate traffic detected within the monitoring area.";

            }


            else {

                level =
                    "NORMAL";

                message =
                    "🟢 Traffic is normal within the monitoring area.";

            }


            console.log("");

            console.log(
                "🚦 Traffic Level:",
                level
            );

            console.log(
                "⏱️ Maximum Delay:",
                maximumDelay,
                "seconds"
            );

            console.log(
                "📊 Average Delay:",
                averageDelay.toFixed(1),
                "seconds"
            );

            console.log(
                "📍 Worst Direction:",
                worstDirection.direction
            );

            console.log(
                "========================================"
            );


            res.json({

                status:
                    "success",


                traffic: {

                    level:

                        level,


                    message:

                        message,


                    delayInSeconds:

                        maximumDelay,


                    delay:

                        `${Math.round(
                            maximumDelay / 60
                        )} minutes`,


                    averageDelayInSeconds:

                        Number(
                            averageDelay.toFixed(1)
                        ),


                    averageDelayMinutes:

                        Number(
                            (
                                averageDelay /
                                60
                            ).toFixed(1)
                        ),


                    worstDirection:

                        worstDirection.direction,


                    worstBearing:

                        worstDirection.bearing,


                    latitude:

                        centerLatitude,


                    longitude:

                        centerLongitude,


                    timestamp:

                        Date.now()

                },


                monitoring: {

                    center: {

                        latitude:

                            centerLatitude,

                        longitude:

                            centerLongitude

                    },


                    radiusKm:

                        monitoringRadiusKm,


                    directions:

                        directionResults,


                    directionsChecked:

                        validResults.length,


                    totalDirections:

                        directions.length

                }

            });


        }

        catch (error) {

            console.error(
                "❌ Traffic Monitor Error:",
                error
            );


            res.status(500).json({

                status:
                    "error",

                message:
                    "Unable to monitor traffic.",

                error:
                    error.message

            });

        }

    }
);


// =====================================================
// MANUAL TRAFFIC SCAN AT USER-SELECTED CENTER/RADIUS
// =====================================================

app.get("/api/traffic-scan", async (req, res) => {
    try {
        const latitude = Number(req.query.latitude);
        const longitude = Number(req.query.longitude);
        const radiusKm = Number(req.query.radiusKm);

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
            latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
            return res.status(400).json({
                status: "error",
                message: "Valid latitude and longitude are required."
            });
        }

        if (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 20) {
            return res.status(400).json({
                status: "error",
                message: "radiusKm must be between 1 and 20."
            });
        }

        if (!getTomTomKey()) {
            return res.status(500).json({
                status: "error",
                message: "TomTom API key is missing from backend .env."
            });
        }

        const cacheKey = `${latitude.toFixed(5)},${longitude.toFixed(5)},${radiusKm}`;
        const cached = trafficScanCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < TRAFFIC_SCAN_CACHE_MS) {
            return res.json({ ...cached.payload, cached: true, message: `${cached.payload.message} (cached result)` });
        }

        // Prevent button clicks and background polling from launching overlapping 12-call scans.
        if (manualTrafficScanInProgress) {
            return res.status(429).json({
                status: "busy",
                message: "A traffic scan is already running. Please wait for it to finish before starting another scan."
            });
        }
        if (Date.now() < tomTomRateLimitedUntil) {
            const waitSeconds = Math.ceil((tomTomRateLimitedUntil - Date.now()) / 1000);
            return res.status(429).json({
                status: "rate_limited",
                message: `TomTom temporarily rate-limited this app. Automatic retries are paused; please try again in about ${waitSeconds} seconds.`
            });
        }
        manualTrafficScanInProgress = true;

        // 12-point sample: four cardinal bearings at three distances from center.
        // This improves coverage but does not inspect every road in the selected circle.
        const bearings = [
            { name: "NORTH", bearing: 0 },
            { name: "EAST", bearing: 90 },
            { name: "SOUTH", bearing: 180 },
            { name: "WEST", bearing: 270 }
        ];
        const rings = [
            { name: "INNER", fraction: 0.35 },
            { name: "MIDDLE", fraction: 0.65 },
            { name: "OUTER", fraction: 0.90 }
        ];
        const samples = [];
        for (const ring of rings) {
            for (const bearing of bearings) {
                samples.push({
                    name: `${bearing.name}-${ring.name}`,
                    direction: bearing.name,
                    ring: ring.name,
                    bearing: bearing.bearing,
                    distanceKm: Math.max(0.3, radiusKm * ring.fraction)
                });
            }
        }

        const directionResults = [];
        let rateLimitHit = false;

        for (let i = 0; i < samples.length; i++) {
            const sample = samples[i];
            const target = destinationPoint(latitude, longitude, sample.distanceKm, sample.bearing);
            try {
                const flow = await getTomTomFlowSegment(target.latitude, target.longitude);
                const currentSpeed = Number(flow.currentSpeed);
                const freeFlowSpeed = Number(flow.freeFlowSpeed);
                const level = classifyFlowSegment(flow);
                const reductionPercent = Number.isFinite(currentSpeed) && freeFlowSpeed > 0
                    ? Math.max(0, Math.round((1 - currentSpeed / freeFlowSpeed) * 100))
                    : null;

                directionResults.push({
                    direction: sample.name,
                    cardinalDirection: sample.direction,
                    ring: sample.ring,
                    bearing: sample.bearing,
                    distanceFromCenterKm: Number(sample.distanceKm.toFixed(2)),
                    latitude: target.latitude,
                    longitude: target.longitude,
                    available: level !== "UNKNOWN",
                    level,
                    currentSpeedKmph: Number.isFinite(currentSpeed) ? currentSpeed : null,
                    freeFlowSpeedKmph: Number.isFinite(freeFlowSpeed) ? freeFlowSpeed : null,
                    speedReductionPercent: reductionPercent,
                    confidence: flow.confidence ?? null,
                    roadClosure: flow.roadClosure === true,
                    currentTravelTimeSeconds: flow.currentTravelTime ?? null,
                    freeFlowTravelTimeSeconds: flow.freeFlowTravelTime ?? null
                });
            } catch (sampleError) {
                console.error(`Manual scan ${sample.name} flow error:`, sampleError.message);
                const isRateLimit = sampleError.code === "TOMTOM_RATE_LIMIT" ||
                    sampleError.code === "LOCAL_RATE_LIMIT_COOLDOWN";
                if (isRateLimit) rateLimitHit = true;

                directionResults.push({
                    direction: sample.name,
                    cardinalDirection: sample.direction,
                    ring: sample.ring,
                    bearing: sample.bearing,
                    distanceFromCenterKm: Number(sample.distanceKm.toFixed(2)),
                    latitude: target.latitude,
                    longitude: target.longitude,
                    available: false,
                    level: "UNKNOWN",
                    error: sampleError.message
                });

                // Stop requesting upstream data after a rate-limit response.
                if (rateLimitHit) {
                    for (const remaining of samples.slice(i + 1)) {
                        const remainingTarget = destinationPoint(
                            latitude, longitude, remaining.distanceKm, remaining.bearing
                        );
                        directionResults.push({
                            direction: remaining.name,
                            cardinalDirection: remaining.direction,
                            ring: remaining.ring,
                            bearing: remaining.bearing,
                            distanceFromCenterKm: Number(remaining.distanceKm.toFixed(2)),
                            latitude: remainingTarget.latitude,
                            longitude: remainingTarget.longitude,
                            available: false,
                            level: "UNKNOWN",
                            error: "Skipped to protect the API quota after rate limiting."
                        });
                    }
                    break;
                }
            }
        }

        const validResults = directionResults.filter(item => item.available && item.level !== "UNKNOWN");
        let level = "UNKNOWN";
        let message = "Traffic data unavailable. No normal-traffic conclusion can be made.";
        let worstDirection = null;

        const rank = { NORMAL: 1, MODERATE: 2, HEAVY: 3 };
        for (const item of validResults) {
            if (!worstDirection || rank[item.level] > rank[worstDirection.level]) worstDirection = item;
        }

        if (validResults.length > 0) {
            level = worstDirection.level;
            message = `Traffic summary based on ${validResults.length} of ${samples.length} sampled road segments across three distance bands. It does not cover every road in the selected circle.`;
            if (validResults.length < 4) message += " Some directions are unavailable.";
        }

        const payload = {
            status: "success",
            message,
            traffic: {
                level,
                worstDirection: worstDirection ? worstDirection.direction : null,
                maximumDelayInSeconds: null,
                timestamp: Date.now(),
                directionsWithData: validResults.length,
                totalDirections: samples.length,
                samplesWithData: validResults.length,
                totalSamples: samples.length
            },
            monitoring: {
                center: { latitude, longitude },
                radiusKm,
                directions: directionResults,
                directionsChecked: validResults.length,
                totalDirections: samples.length,
                samplesChecked: validResults.length,
                totalSamples: samples.length
            }
        };

        // Cache only fully successful scans; never cache partial/rate-limit failures as NORMAL.
        if (validResults.length === samples.length) trafficScanCache.set(cacheKey, { timestamp: Date.now(), payload });
        return res.json(payload);
    } catch (error) {
        console.error("Manual traffic scan error:", error);
        return res.status(500).json({
            status: "error",
            message: "Unable to scan traffic for the selected area.",
            error: error.message
        });
    } finally {
        manualTrafficScanInProgress = false;
    }
});


// =====================================================
// START SERVER
// =====================================================

mongoose.connect(MONGODB_URI)
    .then(async () => {
        // Migration: older versions used a required, non-sparse unique phone index.
        // Drop it before creating the sparse index so email-only registrations can coexist.
        try { await User.collection.dropIndex("phone_1"); } catch (error) { if (error.codeName !== "IndexNotFound" && error.code !== 27) throw error; }
        await User.collection.createIndex({ phone: 1 }, { unique: true, sparse: true, name: "phone_sparse_unique" });
        console.log("MongoDB connected successfully.");
        app.listen(PORT, () => {
            console.log("\n========================================");
            console.log("🚦 Smart Traffic System Backend");
            console.log(`🌐 http://localhost:${PORT}`);
            console.log("🔐 Authentication enabled");
            console.log("⭕ Moving traffic monitoring enabled");
            console.log("========================================\n");
        });
    })
    .catch(error => {
        console.error("MongoDB connection failed:", error.message);
        process.exit(1);
    });
