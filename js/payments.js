/**
 * Payment app integration + dynamic deposit QR payloads.
 * Config is scoped per admin workspace.
 */

import { getWorkspaceAdminId } from "./storage.js";

const KEY = "trip_tap_payment_apps";

const DEFAULTS = {
  esewa: {
    enabled: true,
    merchantId: "",
    merchantName: "Travel Sewa",
    /** Placeholders: {amount} {merchantId} {merchantName} {ref} {currency} */
    qrTemplate:
      "esewa://pay?aid={merchantId}&amt={amount}&pn={merchantName}&tn=TravelSewa-{ref}&cu={currency}",
  },
  khalti: {
    enabled: true,
    merchantId: "",
    merchantName: "Travel Sewa",
    qrTemplate:
      "khalti://payment?public_key={merchantId}&amount={amountPaisa}&product_identity=TravelSewa-{ref}&product_name={merchantName}",
  },
  fonepay: {
    enabled: true,
    merchantId: "",
    merchantName: "Travel Sewa",
    qrTemplate:
      "fonepay://pay?merchant={merchantId}&amount={amount}&remarks=TravelSewa-{ref}",
  },
  imepay: {
    enabled: true,
    merchantId: "",
    merchantName: "Travel Sewa",
    qrTemplate:
      "imepay://payment?MerchantCode={merchantId}&Amount={amount}&RefId=TravelSewa-{ref}",
  },
  bank: {
    enabled: true,
    bankName: "",
    accountName: "Travel Sewa",
    accountNumber: "",
    branch: "",
    qrTemplate:
      "BANK TRANSFER\nBank: {bankName}\nAccount: {accountName}\nNumber: {accountNumber}\nBranch: {branch}\nAmount: {currency} {amount}\nRef: TravelSewa-{ref}",
  },
};

export const DIGITAL_METHODS = ["esewa", "khalti", "fonepay", "imepay", "bank"];

function storageKey() {
  const adminId = getWorkspaceAdminId();
  return adminId ? `${KEY}_${adminId}` : KEY;
}

function readRaw(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function getPaymentAppsConfig() {
  try {
    const scoped = readRaw(storageKey());
    const legacy = storageKey() !== KEY ? readRaw(KEY) : null;
    const saved = scoped || legacy || {};
    return {
      esewa: { ...DEFAULTS.esewa, ...(saved.esewa || {}) },
      khalti: { ...DEFAULTS.khalti, ...(saved.khalti || {}) },
      fonepay: { ...DEFAULTS.fonepay, ...(saved.fonepay || {}) },
      imepay: { ...DEFAULTS.imepay, ...(saved.imepay || {}) },
      bank: { ...DEFAULTS.bank, ...(saved.bank || {}) },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function savePaymentAppsConfig(cfg) {
  const next = {
    esewa: { ...DEFAULTS.esewa, ...(cfg.esewa || {}) },
    khalti: { ...DEFAULTS.khalti, ...(cfg.khalti || {}) },
    fonepay: { ...DEFAULTS.fonepay, ...(cfg.fonepay || {}) },
    imepay: { ...DEFAULTS.imepay, ...(cfg.imepay || {}) },
    bank: { ...DEFAULTS.bank, ...(cfg.bank || {}) },
  };
  localStorage.setItem(storageKey(), JSON.stringify(next));
  return next;
}

export function methodLabel(method) {
  const map = {
    esewa: "eSewa",
    khalti: "Khalti",
    fonepay: "Fonepay",
    imepay: "IME Pay",
    bank: "Bank transfer",
    counter: "Counter",
    cash: "Cash",
  };
  return map[method] || method;
}

export function isDigitalPayment(method) {
  return DIGITAL_METHODS.includes(method);
}

function fillTemplate(tpl, vars) {
  return String(tpl || "").replace(/\{(\w+)\}/g, (_, key) =>
    vars[key] != null ? String(vars[key]) : ""
  );
}

/**
 * Build QR string for deposit amount + selected payment app.
 */
export function buildPaymentQrPayload({ method, amount, ref = "BOOKING" }) {
  const cfg = getPaymentAppsConfig();
  const app = cfg[method];
  if (!app) return null;
  const amt = Math.max(0, Number(amount) || 0);
  const vars = {
    amount: String(amt),
    amountPaisa: String(Math.round(amt * 100)),
    merchantId: app.merchantId || app.accountNumber || "",
    merchantName: app.merchantName || app.accountName || "Travel Sewa",
    bankName: app.bankName || "",
    accountName: app.accountName || app.merchantName || "",
    accountNumber: app.accountNumber || "",
    branch: app.branch || "",
    ref: String(ref).replace(/\s+/g, ""),
    currency: "NPR",
  };

  if (method === "bank") {
    if (!app.accountNumber && !app.bankName) {
      return `NPR ${amt} deposit · configure bank details in Settings`;
    }
  } else if (!app.merchantId) {
    return `${methodLabel(method)} · NPR ${amt} · set merchant ID in Settings · Ref TravelSewa-${vars.ref}`;
  }

  return fillTemplate(app.qrTemplate || DEFAULTS[method]?.qrTemplate, vars);
}

/** Render dynamic QR into a container element (canvas or img fallback). */
export async function renderPaymentQr(container, payload) {
  if (!container) return;
  container.innerHTML = "";
  if (!payload) {
    container.innerHTML = `<p class="muted">Select a digital payment method and enter deposit amount.</p>`;
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.className = "pay-qr-canvas";
  try {
    const mod = await import("https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm");
    const QRCode = mod.default || mod;
    await QRCode.toCanvas(canvas, payload, {
      width: 200,
      margin: 2,
      color: { dark: "#0b1a12", light: "#ffffff" },
      errorCorrectionLevel: "M",
    });
    container.appendChild(canvas);
  } catch {
    const img = document.createElement("img");
    img.className = "pay-qr-img";
    img.alt = "Payment QR";
    img.width = 200;
    img.height = 200;
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&ecc=M&data=${encodeURIComponent(payload)}`;
    container.appendChild(img);
  }
}
