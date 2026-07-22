/**
 * First-time staff mobile OTP verification.
 * Delivers OTP via SMS / WhatsApp deep links (no SMS gateway required).
 * Local/demo also surfaces the code on-screen so counters can verify without a gateway.
 */

import { normalizePhone, whatsAppNumber } from "./share.js";

const OTP_KEY = "trip_tap_staff_otp";
const OTP_TTL_MS = 5 * 60 * 1000;

function readPending() {
  try {
    const raw = sessionStorage.getItem(OTP_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writePending(data) {
  if (data) sessionStorage.setItem(OTP_KEY, JSON.stringify(data));
  else sessionStorage.removeItem(OTP_KEY);
}

export function clearStaffOtp() {
  writePending(null);
}

export function getPendingStaffOtp() {
  const pending = readPending();
  if (!pending) return null;
  if (Date.now() > pending.expiresAt) {
    writePending(null);
    return null;
  }
  return pending;
}

export function maskPhone(phone) {
  const digits = normalizePhone(phone).replace(/\D/g, "");
  if (digits.length < 4) return "****";
  return `${digits.slice(0, 2)}${"*".repeat(Math.max(4, digits.length - 4))}${digits.slice(-2)}`;
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function otpMessage(code) {
  return `Travel Sewa verification code: ${code}. Valid for 5 minutes. Do not share this code.`;
}

/** Open SMS compose to the registered number with OTP text. */
export function openOtpSms(phone, code) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error("Staff phone is missing");
  const body = encodeURIComponent(otpMessage(code));
  const a = document.createElement("a");
  a.href = `sms:${normalized}?&body=${body}`;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Open WhatsApp chat to the registered number with OTP text. */
export function openOtpWhatsApp(phone, code) {
  const wa = whatsAppNumber(phone);
  if (!wa) throw new Error("Staff phone is missing");
  const text = encodeURIComponent(otpMessage(code));
  window.open(`https://wa.me/${wa}?text=${text}`, "_blank", "noopener,noreferrer");
}

/**
 * Create and store a new OTP for a staff member.
 * @returns {{ code: string, maskedPhone: string, expiresAt: number, staffId: string }}
 */
export function issueStaffOtp(staff) {
  if (!staff?.id) throw new Error("Staff account required");
  if (!staff.phone?.trim()) throw new Error("No registered mobile number for this staff");
  const code = generateOtp();
  const pending = {
    staffId: staff.id,
    phone: staff.phone.trim(),
    code,
    expiresAt: Date.now() + OTP_TTL_MS,
    createdAt: Date.now(),
  };
  writePending(pending);
  return {
    code,
    maskedPhone: maskPhone(staff.phone),
    expiresAt: pending.expiresAt,
    staffId: staff.id,
  };
}

export function verifyStaffOtp(inputCode) {
  const pending = getPendingStaffOtp();
  if (!pending) throw new Error("OTP expired — request a new code");
  const code = String(inputCode || "").replace(/\D/g, "");
  if (code.length !== 6) throw new Error("Enter the 6-digit OTP");
  if (code !== pending.code) throw new Error("Incorrect OTP");
  const staffId = pending.staffId;
  writePending(null);
  return staffId;
}

export function isStaffPhoneVerified(staff) {
  return !!(staff && staff.phoneVerified);
}
