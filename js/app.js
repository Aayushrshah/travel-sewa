import {
  createBus,
  createRoute,
  createTicket,
  createCounterStaff,
  createExpense,
  computePricing,
  summarizeBusDay,
  DEFAULT_CITIES,
} from "./models.js";
import {
  db,
  tryEnableFirebase,
  getStorageMode,
  resolveLoginFromPin,
  unlockSession,
  lockSession,
  isUnlocked,
  getCurrentRole,
  getCurrentStaffId,
  getWorkspaceAdminId,
  setWorkspaceAdminId,
  clearLocalAutoDemoData,
  isAutoDemoBus,
  isAutoDemoStaff,
  isAdmin,
  isGuest,
  isSignedIn,
  getStaffPin,
  setStaffPin,
  assertUniqueStaffPin,
  ROLES,
} from "./storage.js";
import {
  adminSignin,
  adminSignup,
  adminForgotPassword,
  signInWithGoogle,
  completeGoogleRedirectIfAny,
  getSavedAdminUser,
  clearSavedAdminUser,
  changePasswordLocal,
  hasLocalAdminAccounts,
} from "./adminAuth.js";
import { initFirebaseFromSavedConfig, ensureDefaultFirebaseConfigSaved } from "./firebase.config.js";
import {
  issueStaffOtp,
  verifyStaffOtp,
  clearStaffOtp,
  getPendingStaffOtp,
  isStaffPhoneVerified,
  openOtpSms,
  openOtpWhatsApp,
} from "./staffOtp.js";
import { openWhatsApp, openSms } from "./share.js";
import {
  buildPaymentQrPayload,
  renderPaymentQr,
  isDigitalPayment,
  methodLabel,
  getPaymentAppsConfig,
  savePaymentAppsConfig,
} from "./payments.js";
import { downloadTicketPdf, downloadBusManifestPdf } from "./pdf.js";
import { defaultSeatLayout, normalizeSeatLayout, renderSeatChart } from "./seats.js";

const state = {
  selectedRoute: null,
  selectedBus: null,
  travelDate: null,
  selectedSeats: [],
  passenger: null,
  takenSeats: [],
  vehicleMode: "bus",
  dashBusId: null,
  editingStaffId: null,
  editingBusId: null,
  currentStaff: null,
  staffAssignedSeats: [],
  staffAssignedBusId: "",
  pendingStaffLogin: null, // { staff } awaiting OTP on first login
  resumeBookingAfterAuth: false,
  depositPaymentDone: false,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ---------- Theme (light / dark) ---------- */
const THEME_KEY = "travel_sewa_theme";

function getTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function applyTheme(theme) {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* ignore */
  }
  $$("[data-theme-toggle]").forEach((btn) => {
    btn.setAttribute("aria-label", next === "dark" ? "Switch to light mode" : "Switch to dark mode");
    btn.title = next === "dark" ? "Light mode" : "Dark mode";
  });
}

function toggleTheme() {
  applyTheme(getTheme() === "dark" ? "light" : "dark");
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-theme-toggle]");
  if (btn) toggleTheme();
});

applyTheme(
  (() => {
    try {
      return localStorage.getItem(THEME_KEY) || getTheme();
    } catch {
      return getTheme();
    }
  })()
);

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 2600);
}

/**
 * Themed confirm popup (replaces window.confirm).
 * @returns {Promise<boolean>}
 */
function confirmDialog({
  title = "Confirm",
  message = "Are you sure?",
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  danger = true,
} = {}) {
  const modal = $("#confirm-modal");
  const titleEl = $("#confirm-modal-title");
  const msgEl = $("#confirm-modal-message");
  const okBtn = $("#confirm-modal-ok");
  const cancelBtn = $("#confirm-modal-cancel");
  if (!modal || !okBtn || !cancelBtn) {
    return Promise.resolve(window.confirm(message));
  }

  titleEl.textContent = title;
  msgEl.textContent = message;
  okBtn.textContent = confirmLabel;
  cancelBtn.textContent = cancelLabel;
  okBtn.className = danger ? "btn btn-danger" : "btn btn-primary";
  modal.hidden = false;
  okBtn.focus();

  return new Promise((resolve) => {
    const finish = (value) => {
      modal.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onOk = (e) => {
      e.preventDefault();
      finish(true);
    };
    const onCancel = (e) => {
      e.preventDefault();
      finish(false);
    };
    const onBackdrop = (e) => {
      if (e.target.closest("[data-confirm-cancel]")) finish(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") finish(false);
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
  });
}

function money(n, currency = "NPR") {
  return `${currency} ${Number(n).toLocaleString()}`;
}

/* ---------- Auth / PIN ---------- */

function showApp(unlocked) {
  $("#pin-gate").hidden = unlocked;
  $("#app").hidden = !unlocked;
  const resumeNote = $("#auth-resume-note");
  if (resumeNote) {
    resumeNote.hidden = !state.resumeBookingAfterAuth;
  }
  if (unlocked) applyRoleUI();
}

async function applyRoleUI() {
  const role = getCurrentRole() || ROLES.guest;
  const admin = role === ROLES.admin;
  const guest = role === ROLES.guest;
  document.body.classList.toggle("is-staff", role === ROLES.staff);
  document.body.classList.toggle("is-admin", admin);
  document.body.classList.toggle("is-guest", guest);

  const staffId = getCurrentStaffId();
  state.currentStaff = null;
  if (staffId) {
    state.currentStaff =
      (await db.getStaff()).find((s) => s.id === staffId) ||
      (await db.getStaffByIdGlobal(staffId)) ||
      null;
  }

  const badge = $("#role-badge");
  const adminUser = getSavedAdminUser();
  if (admin) {
    badge.textContent = adminUser?.username || "Admin";
    badge.title = adminUser?.email || "Admin account";
  } else if (guest) {
    badge.textContent = "Guest";
    badge.title = "Browse only — sign in to confirm bookings";
  } else if (state.currentStaff) {
    badge.textContent = state.currentStaff.fullName.split(" ")[0];
    badge.title = `${state.currentStaff.fullName} · ${state.currentStaff.counterCode}`;
  } else {
    badge.textContent = "User";
    badge.title = "";
  }
  badge.classList.toggle("admin", admin);
  badge.classList.toggle("staff", role === ROLES.staff);
  badge.classList.toggle("guest", guest);

  const bookSub = $("#book-sub");
  if (bookSub) {
    bookSub.textContent = guest
      ? "Search routes and seats without an account. Sign in when you confirm."
      : state.vehicleMode === "micro-ev"
        ? "Search Micro EV shuttles, pick seats, and confirm."
        : "Search routes, pick seats, and save full passenger details.";
  }
  refreshHomeGreeting();
  const guestBanner = $("#guest-banner");
  if (guestBanner) guestBanner.hidden = !guest;

  const settingsSub = $("#settings-sub");
  if (settingsSub) settingsSub.remove();

  const staffPinPanel = $("#staff-pin-panel");
  if (staffPinPanel) staffPinPanel.hidden = admin || guest;

  // Settings tabs: users only see Account
  const payTab = document.querySelector('[data-settings-tab="payments"]');
  const dataTab = document.querySelector('[data-settings-tab="data"]');
  if (payTab) payTab.hidden = !admin;
  if (dataTab) dataTab.hidden = !admin;
  if (!admin) setSettingsTab("account");

  const accountLabel = $("#admin-account-label");
  if (accountLabel && admin) {
    if (adminUser) {
      accountLabel.textContent = `${adminUser.username} · ${adminUser.email}${
        adminUser.provider === "google" ? " · Google" : ""
      }`;
    } else {
      accountLabel.textContent = "Admin";
    }
  }

  const lockBtn = $("#btn-lock");
  if (lockBtn) {
    lockBtn.textContent = guest ? "Sign in" : "Lock";
    lockBtn.title = guest ? "Sign in to confirm bookings" : "Lock workspace";
  }

  const confirmBtn = $("#confirm-book");
  if (confirmBtn) {
    confirmBtn.textContent = guest ? "Sign in to confirm" : "Confirm & save";
  }

  if ((guest || !admin) && ($("#view-fleet").classList.contains("active") || $("#view-admin").classList.contains("active"))) {
    $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === "book"));
    $$(".view").forEach((v) => v.classList.remove("active"));
    $("#view-book").classList.add("active");
  }
  if (guest && !$("#view-book").classList.contains("active")) {
    $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === "book"));
    $$(".view").forEach((v) => v.classList.remove("active"));
    $("#view-book").classList.add("active");
  }
}

/** Open auth gate while keeping in-memory booking; used for guests confirming. */
function promptSignIn(message) {
  state.resumeBookingAfterAuth = !!(state.selectedRoute && state.selectedSeats?.length);
  $("#pin-gate").hidden = false;
  $("#app").hidden = true;
  const resumeNote = $("#auth-resume-note");
  if (resumeNote) {
    resumeNote.hidden = !state.resumeBookingAfterAuth;
    resumeNote.textContent = state.resumeBookingAfterAuth
      ? "Sign in to confirm your pending booking"
      : "Sign in for full workspace access";
  }
  setAuthRole("admin");
  setAuthMode(hasLocalAdminAccounts() ? "signin" : "signup");
  if (message) toast(message);
}

async function finishAuthAndResume(welcomeMsg) {
  const resume =
    state.resumeBookingAfterAuth && state.selectedRoute && state.selectedSeats?.length
      ? {
          selectedRoute: state.selectedRoute,
          selectedBus: state.selectedBus,
          selectedSeats: [...state.selectedSeats],
          travelDate: state.travelDate,
          passenger: state.passenger,
          takenSeats: [...(state.takenSeats || [])],
        }
      : null;

  showApp(true);
  await bootstrapApp({ preserveBooking: !!resume });
  if (welcomeMsg) toast(welcomeMsg);

  if (resume) {
    state.resumeBookingAfterAuth = false;
    state.selectedRoute = resume.selectedRoute;
    state.selectedBus = resume.selectedBus;
    state.selectedSeats = resume.selectedSeats;
    state.travelDate = resume.travelDate;
    state.passenger = resume.passenger;
    state.takenSeats = resume.takenSeats;

    $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === "book"));
    $$(".view").forEach((v) => v.classList.remove("active"));
    $("#view-book").classList.add("active");
    openBookFlow(state.vehicleMode || "bus", { announce: false });
    $("#trip-results").hidden = true;
    $("#booking-wizard").hidden = false;
    if (state.passenger) {
      renderConfirm();
      setWizardStep(3);
      toast("Signed in — tap Confirm & save to finish");
    } else {
      setWizardStep(2);
      syncDepositHint();
      toast("Signed in — finish passenger details and confirm");
    }
  } else {
    state.resumeBookingAfterAuth = false;
  }
}

async function enterAsGuest() {
  unlockSession(ROLES.guest, null);
  state.resumeBookingAfterAuth = false;
  showApp(true);
  await bootstrapApp();
  toast("Guest mode — search buses freely, sign in to confirm");
}

function setAuthRole(role) {
  $$(".auth-role-tab").forEach((b) => b.classList.toggle("active", b.dataset.authRole === role));
  $("#auth-admin-pane").hidden = role !== "admin";
  $("#auth-staff-pane").hidden = role !== "staff";
  if (role === "staff") {
    showStaffPinStep();
    clearPinDigits();
  }
}

function showStaffPinStep() {
  state.pendingStaffLogin = null;
  clearStaffOtp();
  $("#staff-step-pin").hidden = false;
  $("#staff-step-otp").hidden = true;
  const err = $("#pin-error");
  if (err) err.hidden = true;
  const otpErr = $("#staff-otp-error");
  if (otpErr) otpErr.hidden = true;
  const demo = $("#staff-otp-demo");
  if (demo) {
    demo.hidden = true;
    demo.textContent = "";
  }
}

function showStaffOtpStep(staff, issued) {
  state.pendingStaffLogin = { staff };
  $("#staff-step-pin").hidden = true;
  $("#staff-step-otp").hidden = false;
  $("#staff-otp-sub").textContent = `OTP sent to ${issued.maskedPhone}`;
  const demo = $("#staff-otp-demo");
  if (demo) {
    demo.hidden = false;
    demo.textContent = `OTP for registered mobile: ${issued.code}`;
  }
  const input = $("#staff-otp-input");
  if (input) {
    input.value = "";
    input.focus();
  }
  showAuthError("staff-otp-error", "");
}

async function completeStaffLogin(staff) {
  if (!staff?.ownerAdminId) {
    throw new Error("This user is not linked to an admin — ask your admin to re-add the account");
  }
  unlockSession(ROLES.staff, staff.id, staff.ownerAdminId);
  state.pendingStaffLogin = null;
  clearStaffOtp();
  await finishAuthAndResume(`Signed in as ${staff.fullName}`);
}

function sendOtpToStaff(staff) {
  return issueStaffOtp(staff);
}

function setAuthMode(mode) {
  $$(".auth-mode-tab").forEach((b) => b.classList.toggle("active", b.dataset.authMode === mode));
  $("#admin-signin-form").hidden = mode !== "signin";
  $("#admin-signup-form").hidden = mode !== "signup";
  $("#admin-forgot-form").hidden = mode !== "forgot";
  ["admin-signin-error", "admin-signup-error", "admin-forgot-error"].forEach((id) => {
    const el = $(`#${id}`);
    if (el) el.hidden = true;
  });
}

function showAuthError(id, message) {
  const el = $(`#${id}`);
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
}

async function enterAsAdmin(user) {
  if (!user?.id) throw new Error("Invalid admin account");
  unlockSession(ROLES.admin, null, user.id);
  await finishAuthAndResume(`Signed in as ${user.username || "Admin"}`);
}

$$(".auth-role-tab").forEach((btn) => {
  btn.addEventListener("click", () => setAuthRole(btn.dataset.authRole));
});

$$(".auth-mode-tab").forEach((btn) => {
  btn.addEventListener("click", () => setAuthMode(btn.dataset.authMode));
});

$("#btn-forgot-link")?.addEventListener("click", () => setAuthMode("forgot"));

$("#admin-signin-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(e.target).entries());
  showAuthError("admin-signin-error", "");
  try {
    const user = await adminSignin(fd);
    await enterAsAdmin(user);
  } catch (err) {
    showAuthError("admin-signin-error", err.message || "Sign in failed");
  }
});

$("#admin-signup-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(e.target).entries());
  showAuthError("admin-signup-error", "");
  try {
    const user = await adminSignup(fd);
    await enterAsAdmin(user);
  } catch (err) {
    showAuthError("admin-signup-error", err.message || "Sign up failed");
  }
});

$("#admin-forgot-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(e.target).entries());
  showAuthError("admin-forgot-error", "");
  try {
    await adminForgotPassword({ ...fd, mode: "local" });
    toast("Password updated — sign in with your new password");
    setAuthMode("signin");
    e.target.reset();
  } catch (err) {
    showAuthError("admin-forgot-error", err.message || "Reset failed");
  }
});

$("#btn-send-reset-email")?.addEventListener("click", async () => {
  const form = $("#admin-forgot-form");
  const email = form?.email?.value;
  showAuthError("admin-forgot-error", "");
  try {
    await adminForgotPassword({ email, mode: "email" });
    toast("Reset email sent — check your inbox");
  } catch (err) {
    showAuthError("admin-forgot-error", err.message || "Could not send reset email");
  }
});

$("#btn-google-signin")?.addEventListener("click", async () => {
  showAuthError("admin-signin-error", "");
  const btn = $("#btn-google-signin");
  if (btn) {
    btn.disabled = true;
    btn.dataset.label = btn.dataset.label || btn.textContent;
    btn.textContent = "Opening Google…";
  }
  try {
    ensureDefaultFirebaseConfigSaved();
    await initFirebaseFromSavedConfig();
    const user = await signInWithGoogle();
    if (!user) return; // redirect in progress
    await enterAsAdmin(user);
  } catch (err) {
    showAuthError("admin-signin-error", err.message || "Google sign-in failed");
    setAuthMode("signin");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = btn.dataset.label || "Sign in with Google";
    }
  }
});

function setupPinInputs() {
  const digits = $$(".pin-digit");
  digits.forEach((input, i) => {
    input.addEventListener("input", () => {
      input.value = input.value.replace(/\D/g, "").slice(0, 1);
      if (input.value && i < digits.length - 1) digits[i + 1].focus();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !input.value && i > 0) digits[i - 1].focus();
    });
    input.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 4);
      text.split("").forEach((ch, idx) => {
        if (digits[idx]) digits[idx].value = ch;
      });
      digits[Math.min(text.length, 3)].focus();
    });
  });
}

function readPinDigits() {
  return $$(".pin-digit")
    .map((i) => i.value)
    .join("");
}

function clearPinDigits() {
  $$(".pin-digit").forEach((i) => (i.value = ""));
  $$(".pin-digit")[0]?.focus();
}

$("#pin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pin = readPinDigits();
  const err = $("#pin-error");
  const login = await resolveLoginFromPin(pin);
  if (!login || login.role !== ROLES.staff) {
    err.hidden = false;
    err.textContent = "Incorrect PIN. Try again.";
    clearPinDigits();
    return;
  }
  err.hidden = true;

  if (!login.staff) {
    err.hidden = false;
    err.textContent = "Use a user PIN from your admin (shared PIN login is disabled).";
    clearPinDigits();
    return;
  }

  if (!login.staff.ownerAdminId) {
    err.hidden = false;
    err.textContent = "This user is not linked to an admin — ask them to re-add your account.";
    clearPinDigits();
    return;
  }

  // Counter staff profile: first login requires mobile OTP
  if (!isStaffPhoneVerified(login.staff)) {
    if (!login.staff.phone?.trim()) {
      err.hidden = false;
      err.textContent = "No mobile number on this account — ask admin to add one.";
      clearPinDigits();
      return;
    }
    try {
      const issued = sendOtpToStaff(login.staff);
      showStaffOtpStep(login.staff, issued);
      toast(`OTP sent to ${issued.maskedPhone}`);
    } catch (sendErr) {
      err.hidden = false;
      err.textContent = sendErr.message || "Could not send OTP";
    }
    return;
  }
  try {
    await completeStaffLogin(login.staff);
  } catch (loginErr) {
    err.hidden = false;
    err.textContent = loginErr.message || "Sign in failed";
    clearPinDigits();
  }
});

$("#staff-otp-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(e.target).entries());
  showAuthError("staff-otp-error", "");
  try {
    const staffId = verifyStaffOtp(fd.otp);
    const pending = state.pendingStaffLogin?.staff;
    if (!pending || pending.id !== staffId) throw new Error("Session mismatch — start again from PIN");
    await db.updateStaff(staffId, {
      phoneVerified: true,
      phoneVerifiedAt: new Date().toISOString(),
    });
    const fresh = (await db.getStaffByIdGlobal(staffId)) || pending;
    await completeStaffLogin(fresh);
  } catch (err) {
    showAuthError("staff-otp-error", err.message || "OTP verification failed");
  }
});

$("#btn-resend-otp")?.addEventListener("click", () => {
  const staff = state.pendingStaffLogin?.staff;
  if (!staff) return showStaffPinStep();
  try {
    const issued = sendOtpToStaff(staff);
    showStaffOtpStep(staff, issued);
    toast(`OTP resent to ${issued.maskedPhone}`);
  } catch (err) {
    showAuthError("staff-otp-error", err.message || "Could not resend OTP");
  }
});

$("#btn-otp-sms")?.addEventListener("click", () => {
  const staff = state.pendingStaffLogin?.staff;
  const pending = getPendingStaffOtp();
  if (!staff || !pending) return showAuthError("staff-otp-error", "Request an OTP first");
  try {
    openOtpSms(staff.phone, pending.code);
    toast("Opening SMS with OTP…");
  } catch (err) {
    showAuthError("staff-otp-error", err.message || "SMS failed");
  }
});

$("#btn-otp-whatsapp")?.addEventListener("click", () => {
  const staff = state.pendingStaffLogin?.staff;
  const pending = getPendingStaffOtp();
  if (!staff || !pending) return showAuthError("staff-otp-error", "Request an OTP first");
  try {
    openOtpWhatsApp(staff.phone, pending.code);
    toast("Opening WhatsApp with OTP…");
  } catch (err) {
    showAuthError("staff-otp-error", err.message || "WhatsApp failed");
  }
});

$("#btn-otp-back")?.addEventListener("click", () => {
  showStaffPinStep();
  clearPinDigits();
});

$("#btn-lock").addEventListener("click", () => {
  if (isGuest()) {
    promptSignIn("Sign in to confirm your booking");
    return;
  }
  lockSession();
  clearSavedAdminUser();
  clearStaffOtp();
  state.pendingStaffLogin = null;
  state.resumeBookingAfterAuth = false;
  document.body.classList.remove("is-staff", "is-admin", "is-guest");
  showApp(false);
  setAuthRole("admin");
  setAuthMode(hasLocalAdminAccounts() ? "signin" : "signup");
  clearPinDigits();
});

$("#btn-guest-mode")?.addEventListener("click", () => enterAsGuest());
$("#btn-guest-signin")?.addEventListener("click", () => {
  promptSignIn("Sign in to confirm your booking");
});

/* ---------- Navigation ---------- */

$$(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.adminOnly !== undefined && !isAdmin()) {
      toast("Admin only");
      return;
    }
    if (btn.dataset.signedInOnly !== undefined && !isSignedIn()) {
      promptSignIn("Sign in to open this section");
      return;
    }
    $$(".nav-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    $$(".view").forEach((v) => v.classList.remove("active"));
    $(`#view-${btn.dataset.view}`).classList.add("active");
    if (btn.dataset.view === "book") resetBookView();
    if (btn.dataset.view === "tickets") {
      setPassengerHistoryMode(false);
      renderTickets();
    }
    if (btn.dataset.view === "fleet") {
      renderFleet();
      updateFleetSeatPreview();
    }
    if (btn.dataset.view === "dashboard") renderDashboard();
    if (btn.dataset.view === "expenses") renderExpenses();
    if (btn.dataset.view === "admin") renderAdmin();
    if (btn.dataset.view === "settings") refreshSettings();
  });
});

function goToView(view) {
  const btn = $$(`.nav-btn[data-view="${view}"]`)[0];
  if (btn) btn.click();
}

/* ---------- Seed / cities ---------- */

async function seedDemo() {
  const b1 = createBus({
    busNumber: "TT-101",
    displayName: "Travel Sewa Express",
    operator: "Travel Sewa Express",
    busType: "2x2 Sofa Seater",
    seatLayout: defaultSeatLayout({ rows: 8, includeRear: true }),
  });
  b1.isDemo = true;
  const b2 = createBus({
    busNumber: "TT-202",
    displayName: "Travel Sewa Nightliner",
    operator: "Travel Sewa Nightliner",
    busType: "2x2 Sofa Seater",
    seatLayout: defaultSeatLayout({ rows: 7, includeRear: false }),
  });
  b2.isDemo = true;
  await db.saveBus(b1);
  await db.saveBus(b2);

  const trips = [
    {
      bus: b1,
      from: "Kathmandu",
      to: "Pokhara",
      departureTime: "07:30",
      arrivalTime: "14:00",
      baseFare: 1200,
    },
    {
      bus: b1,
      from: "Pokhara",
      to: "Kathmandu",
      departureTime: "08:00",
      arrivalTime: "14:30",
      baseFare: 1200,
    },
    {
      bus: b2,
      from: "Kathmandu",
      to: "Chitwan",
      departureTime: "21:00",
      arrivalTime: "04:30",
      baseFare: 900,
    },
    {
      bus: b2,
      from: "Butwal",
      to: "Kathmandu",
      departureTime: "20:30",
      arrivalTime: "05:00",
      baseFare: 1100,
    },
  ];

  for (const t of trips) {
    const route = createRoute({
      busId: t.bus.id,
      busNumber: t.bus.busNumber,
      operator: t.bus.operator,
      busType: t.bus.busType,
      from: t.from,
      to: t.to,
      departureTime: t.departureTime,
      arrivalTime: t.arrivalTime,
      baseFare: t.baseFare,
      totalSeats: t.bus.totalSeats,
      seatLayout: t.bus.seatLayout,
      amenities: t.bus.amenities,
      displayName: t.bus.displayName,
    });
    route.isDemo = true;
    await db.saveRoute(route);
  }

  const existingStaff = await db.getStaff();
  if (!existingStaff.length) {
    const s1 = createCounterStaff({
      fullName: "Ram Thapa",
      phone: "9801112233",
      email: "ram@travelsewa.com",
      counterCode: "C-01",
      counterLocation: "Kathmandu Bus Park — Counter 1",
      city: "Kathmandu",
      shift: "Morning",
      pin: "1111",
      notes: "Demo counter staff",
      assignedBusId: b1.id,
      assignedSeats: ["A1", "A2", "B1", "B2"],
    });
    s1.isDemo = true;
    await db.saveStaff(s1);
    const s2 = createCounterStaff({
      fullName: "Sita Gurung",
      phone: "9802223344",
      email: "sita@travelsewa.com",
      counterCode: "C-02",
      counterLocation: "Pokhara Lakeside Counter",
      city: "Pokhara",
      shift: "Evening",
      pin: "2222",
      notes: "Demo counter staff",
      assignedBusId: b2.id,
      assignedSeats: ["A1", "A2", "A3", "A4"],
    });
    s2.isDemo = true;
    await db.saveStaff(s2);
  }
  toast("Demo fleet loaded");
}

function fillCities(cities) {
  const from = $("#from-city");
  const to = $("#to-city");
  const list = $("#city-list");
  const opts = cities.map((c) => `<option value="${c}">${c}</option>`).join("");
  from.innerHTML = `<option value="">Select</option>${opts}`;
  to.innerHTML = `<option value="">Select</option>${opts}`;
  list.innerHTML = cities.map((c) => `<option value="${c}"></option>`).join("");
}

async function refreshCityOptions() {
  const routes = await db.getRoutes();
  const set = new Set(DEFAULT_CITIES);
  routes.forEach((r) => {
    set.add(r.from);
    set.add(r.to);
  });
  fillCities([...set].sort());
}

/* ---------- Home hub ---------- */

function refreshHomeGreeting() {
  const el = $("#home-greeting");
  if (!el) return;
  const adminUser = getSavedAdminUser();
  const role = getCurrentRole();
  let name = "traveler";
  if (role === ROLES.admin && adminUser?.username) name = adminUser.username;
  else if (state.currentStaff?.fullName) name = state.currentStaff.fullName.split(" ")[0];
  else if (role === ROLES.guest) name = "Guest";
  el.textContent = `Namaste, ${name}`;
}

function showHomeHub() {
  const hub = $("#home-hub");
  const flow = $("#book-flow");
  if (hub) hub.hidden = false;
  if (flow) flow.hidden = true;
  state.vehicleMode = "bus";
}

function openBookFlow(mode = "bus", { announce = true } = {}) {
  state.vehicleMode = mode === "micro-ev" ? "micro-ev" : "bus";
  const hub = $("#home-hub");
  const flow = $("#book-flow");
  if (hub) hub.hidden = true;
  if (flow) {
    flow.hidden = false;
    flow.dataset.vehicle = state.vehicleMode;
  }
  const title = $("#book-flow-title");
  const findBtn = $("#btn-find-trips");
  if (state.vehicleMode === "micro-ev") {
    if (title) title.textContent = "Book a Micro EV";
    if (findBtn) findBtn.textContent = "Find Micro EV";
    if (announce) toast("Micro EV booking — search available shuttles");
  } else {
    if (title) title.textContent = "Book a bus";
    if (findBtn) findBtn.textContent = "Find buses";
  }
  applyRoleUI();
  const date = $("#travel-date");
  if (date && !date.value) date.valueAsDate = new Date(Date.now() + 86400000);
}

function handleHomeAction(action) {
  switch (action) {
    case "buses":
      openBookFlow("bus");
      break;
    case "micro-ev":
      openBookFlow("micro-ev");
      break;
    case "tickets":
      if (!isSignedIn()) return promptSignIn("Sign in to view your tickets");
      goToView("tickets");
      break;
    case "find":
      if (!isSignedIn()) return promptSignIn("Sign in to find passenger tickets");
      goToView("tickets");
      setTimeout(() => {
        setPassengerHistoryMode(true);
        renderPassengerHistory();
        $("#passenger-history-name")?.focus();
      }, 0);
      break;
    case "tours":
      toast("Tours — coming soon");
      break;
    case "hotels":
      toast("Hotels — coming soon");
      break;
    case "rentals":
      toast("Rentals — coming soon");
      break;
    case "flights":
      toast("Flights — coming soon");
      break;
    default:
      break;
  }
}

document.querySelectorAll("[data-home-action]").forEach((btn) => {
  btn.addEventListener("click", () => handleHomeAction(btn.dataset.homeAction));
});

$("#btn-home-back")?.addEventListener("click", () => {
  resetBookView();
  showHomeHub();
});

$$(".promo-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    $$(".promo-chip").forEach((c) => c.classList.toggle("active", c === chip));
    const filter = chip.dataset.promoFilter || "all";
    $$("#promo-scroller .promo-card").forEach((card) => {
      card.hidden = filter !== "all" && card.dataset.promoType !== filter;
    });
  });
});

/* ---------- Book flow ---------- */

function resetBookView() {
  const results = $("#trip-results");
  const wizard = $("#booking-wizard");
  const seatMap = $("#seat-map");
  if (results) {
    results.hidden = true;
    results.innerHTML = "";
  }
  if (wizard) wizard.hidden = true;
  if (seatMap) seatMap.innerHTML = "";
  state.selectedRoute = null;
  state.selectedBus = null;
  state.selectedSeats = [];
  state.passenger = null;
  state.takenSeats = [];
  state.depositPaymentDone = false;
  clearDepositPaymentDone();
  showHomeHub();
}

$("#travel-date").valueAsDate = new Date(Date.now() + 86400000);
resetBookView();
refreshHomeGreeting();

$("#search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const from = $("#from-city").value;
  const to = $("#to-city").value;
  const date = $("#travel-date").value;
  if (from === to) {
    toast("From and To must be different");
    return;
  }
  const routes = await db.getRoutes();
  const buses = await db.getBuses();
  const matches = routes.filter((r) => r.active && r.from === from && r.to === to);
  const box = $("#trip-results");
  $("#booking-wizard").hidden = true;
  $("#seat-map").innerHTML = "";
  box.hidden = false;

  if (!matches.length) {
    const emptyLabel = state.vehicleMode === "micro-ev" ? "Micro EV shuttles" : "buses";
    box.innerHTML = `<div class="empty">No ${emptyLabel} on this route yet. Admin can add one under Fleet.</div>`;
    return;
  }

  const cards = [];
  for (const r of matches) {
    const bus = buses.find((b) => b.id === r.busId);
    const layout = normalizeSeatLayout(r.seatLayout || bus?.seatLayout, r.totalSeats);
    const taken = await db.getTakenSeats(r.id, date);
    const remaining = Math.max(0, layout.totalSeats - taken.length);
    const amenities = r.amenities?.length ? r.amenities : bus?.amenities || [];
    cards.push(`
    <article class="trip-card">
      <div class="trip-card-top">
        <div>
          <h3>${escapeHtml(r.displayName || r.operator || r.busNumber)}</h3>
          <div class="muted" style="font-style:italic">${escapeHtml(r.busType)} · ${escapeHtml(r.busNumber)}</div>
        </div>
        <div class="seats-left">${remaining} seats remaining</div>
      </div>
      <div class="trip-meta">
        <span>${r.departureTime} – ${r.arrivalTime}</span>
        <span class="fare">Rs. ${Number(r.baseFare).toLocaleString()}</span>
      </div>
      <div class="amenity-row">
        ${amenities.map((a) => `<span class="amenity-pill">${escapeHtml(a)}</span>`).join("")}
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:0.75rem;flex-wrap:wrap">
        <button type="button" class="view-details" data-pick="${r.id}">VIEW DETAILS / SELECT SEATS ▾</button>
        <button type="button" class="btn btn-primary" data-pick="${r.id}">Select seats</button>
      </div>
    </article>`);
  }
  box.innerHTML = cards.join("");

  box.querySelectorAll("[data-pick]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const route = matches.find((m) => m.id === btn.dataset.pick);
      const bus = buses.find((b) => b.id === route.busId);
      startBooking(route, bus, date);
    });
  });
});

async function startBooking(route, bus, travelDate) {
  state.selectedRoute = {
    ...route,
    seatLayout: normalizeSeatLayout(route.seatLayout || bus?.seatLayout, route.totalSeats),
    totalSeats: normalizeSeatLayout(route.seatLayout || bus?.seatLayout, route.totalSeats).totalSeats,
    amenities: route.amenities?.length ? route.amenities : bus?.amenities || [],
    displayName: route.displayName || bus?.displayName || route.operator,
  };
  state.selectedBus = bus || null;
  state.travelDate = travelDate;
  state.passenger = null;
  state.takenSeats = await db.getTakenSeats(route.id, travelDate);

  // Pre-select this staff's assigned seats on this bus (marked selected)
  const mine =
    state.currentStaff?.assignedBusId === state.selectedRoute.busId
      ? state.currentStaff.assignedSeats || []
      : [];
  state.selectedSeats = mine.filter((id) => !state.takenSeats.includes(id)).slice(0, 4);

  $("#trip-results").hidden = true;
  $("#booking-wizard").hidden = false;
  const hub = $("#home-hub");
  const flow = $("#book-flow");
  if (hub) hub.hidden = true;
  if (flow) flow.hidden = false;
  $("#seat-bus-title").textContent = state.selectedRoute.displayName || state.selectedRoute.busNumber;
  $("#seat-bus-meta").textContent = `${state.selectedRoute.busType} · ${state.selectedRoute.departureTime} – ${state.selectedRoute.arrivalTime}`;
  setWizardStep(1);
  renderSeatMap();
}

function setWizardStep(n) {
  $$(".wizard-steps .step").forEach((s) => s.classList.toggle("active", Number(s.dataset.step) === n));
  ["seats", "passenger", "confirm"].forEach((name, i) => {
    $(`#step-${name}`).classList.toggle("active", i + 1 === n);
  });
}

function updateSeatBar() {
  const count = state.selectedSeats.length;
  const total = (state.selectedRoute?.baseFare || 0) * count;
  $("#seat-count-label").textContent = `${count} Seat`;
  $("#seat-total-label").textContent = `Rs ${total.toLocaleString()}`;
  $("#seat-bar-count").textContent = `${count} Seat`;
  $("#seat-bar-total").textContent = `Rs ${total.toLocaleString()}`;
  $("#to-passenger").disabled = count === 0;
}

async function renderSeatMap() {
  const layout = state.selectedRoute.seatLayout;
  const busId = state.selectedRoute.busId;
  const allStaff = await db.getStaff();

  // Seats assigned to other counters on this bus → unavailable
  const othersTaken = allStaff
    .filter((s) => s.status === "active" && s.assignedBusId === busId && s.id !== getCurrentStaffId())
    .flatMap((s) => s.assignedSeats || []);

  const taken = [...new Set([...state.takenSeats, ...othersTaken])].filter(
    (id) => !state.selectedSeats.includes(id)
  );

  renderSeatChart($("#seat-map"), {
    layout,
    taken,
    selected: state.selectedSeats,
    fare: state.selectedRoute.baseFare,
    onToggle: (seatId) => {
      if (state.selectedSeats.includes(seatId)) {
        state.selectedSeats = state.selectedSeats.filter((s) => s !== seatId);
      } else {
        if (state.selectedSeats.length >= 4) {
          toast("Max 4 seats per booking");
          return;
        }
        state.selectedSeats.push(seatId);
      }
      renderSeatMap();
    },
  });
  $("#seat-map")?.classList.add("seat-map-scrollable");
  updateSeatBar();
}

$("#cancel-booking").addEventListener("click", () => {
  $("#booking-wizard").hidden = true;
  $("#seat-map").innerHTML = "";
  $("#trip-results").hidden = false;
});

$("#to-passenger").addEventListener("click", () => {
  setWizardStep(2);
  syncDepositHint();
});
$("#back-seats").addEventListener("click", () => setWizardStep(1));
$("#back-passenger").addEventListener("click", () => setWizardStep(2));

$("#passenger-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  state.passenger = Object.fromEntries(fd.entries());
  renderConfirm();
  setWizardStep(3);
});

function renderConfirm() {
  const r = state.selectedRoute;
  const p = state.passenger;
  const pricing = computePricing(r.baseFare, state.selectedSeats.length, {
    depositAmount: p.depositAmount,
    paymentMethod: p.paymentMethod,
  });
  const showQr =
    isDigitalPayment(p.paymentMethod) && pricing.depositAmount > 0 && !state.depositPaymentDone;
  const paidNote =
    isDigitalPayment(p.paymentMethod) && state.depositPaymentDone
      ? `<p class="ok-text" style="margin-top:0.85rem"><strong>Deposit paid via ${escapeHtml(methodLabel(p.paymentMethod))}</strong> — QR closed.</p>`
      : "";
  $("#confirm-summary").innerHTML = `
    <h3>Review booking</h3>
    <dl>
      <dt>Route</dt><dd>${r.from} → ${r.to}</dd>
      <dt>Date</dt><dd>${state.travelDate}</dd>
      <dt>Bus</dt><dd>${r.busNumber} · ${r.busType} · ${r.operator}</dd>
      <dt>Time</dt><dd>${r.departureTime} → ${r.arrivalTime}</dd>
      <dt>Seats</dt><dd>${state.selectedSeats.join(", ")}</dd>
      <dt>Passenger</dt><dd>${escapeHtml(p.fullName)} · ${escapeHtml(p.phone)}</dd>
      <dt>Pick-up</dt><dd>${escapeHtml(p.pickupAddress || "—")}</dd>
      <dt>ID</dt><dd>${escapeHtml(p.idType)} ${escapeHtml(p.idNumber)}</dd>
      <dt>Luggage</dt><dd>${p.luggagePieces || 0} pcs · ${p.luggageWeight || 0} kg${p.luggageDesc ? ` · ${escapeHtml(p.luggageDesc)}` : ""}</dd>
      <dt>Total</dt><dd><strong>${money(pricing.total)}</strong></dd>
      <dt>Deposit / advance</dt><dd><strong>${money(pricing.depositAmount)}</strong></dd>
      <dt>Due</dt><dd><strong class="${pricing.dueAmount > 0 ? "due-text" : "ok-text"}">${money(pricing.dueAmount)}</strong></dd>
      <dt>Status</dt><dd><strong>${String(pricing.paymentStatus).toUpperCase()}</strong> · ${escapeHtml(methodLabel(p.paymentMethod))}</dd>
    </dl>
    ${paidNote}
    ${
      showQr
        ? `<div class="pay-qr-panel confirm-pay-qr">
            <div class="pay-qr-head">
              <div>
                <strong>${escapeHtml(methodLabel(p.paymentMethod))} QR</strong>
                <p class="muted">Deposit ${money(pricing.depositAmount)} — scan to pay</p>
              </div>
            </div>
            <div id="confirm-pay-qr-box" class="pay-qr-box"></div>
            <button type="button" class="btn btn-primary btn-sm" id="btn-confirm-payment-received" style="margin-top:0.75rem">Payment received — hide QR</button>
          </div>`
        : ""
    }
  `;
  if (showQr) {
    const payload = buildPaymentQrPayload({
      method: p.paymentMethod,
      amount: pricing.depositAmount,
      ref: `CFM${Date.now().toString(36).slice(-5).toUpperCase()}`,
    });
    renderPaymentQr($("#confirm-pay-qr-box"), payload);
    $("#btn-confirm-payment-received")?.addEventListener("click", () => {
      markDepositPaymentDone();
      renderConfirm();
    });
  }
}

$("#confirm-book").addEventListener("click", async () => {
  if (!isSignedIn()) {
    promptSignIn("Sign in to confirm and save this booking");
    return;
  }
  const r = state.selectedRoute;
  const p = state.passenger;
  const pricing = computePricing(r.baseFare, state.selectedSeats.length, {
    depositAmount: p.depositAmount,
    paymentMethod: p.paymentMethod,
  });
  try {
    await db.lockSeats(r.id, state.travelDate, state.selectedSeats);
    const ticket = createTicket({
      passenger: p,
      trip: {
        routeId: r.id,
        busId: r.busId,
        busNumber: r.busNumber,
        operator: r.operator,
        busType: r.busType,
        from: r.from,
        to: r.to,
        travelDate: state.travelDate,
        departureTime: r.departureTime,
        arrivalTime: r.arrivalTime,
        seatNumbers: state.selectedSeats,
      },
      luggage: {
        pieces: p.luggagePieces,
        weightKg: p.luggageWeight,
        description: p.luggageDesc,
      },
      pricing,
      notes: p.notes || "",
    });
    if (state.currentStaff) {
      ticket.bookedBy = {
        staffId: state.currentStaff.id,
        fullName: state.currentStaff.fullName,
        counterCode: state.currentStaff.counterCode,
        counterLocation: state.currentStaff.counterLocation,
      };
    } else if (isAdmin()) {
      ticket.bookedBy = { staffId: null, fullName: "Admin", counterCode: "ADMIN", counterLocation: "Head office" };
    }
    await db.saveTicket(ticket);
    toast(`Booked ${ticket.bookingRef} · Deposit ${money(pricing.depositAmount)} · Due ${money(pricing.dueAmount)}`);
    resetBookView();
    $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === "tickets"));
    $$(".view").forEach((v) => v.classList.remove("active"));
    $("#view-tickets").classList.add("active");
    renderTickets();
  } catch (err) {
    toast(err.message || "Booking failed");
  }
});

function syncDepositHint() {
  const hint = $("#deposit-hint");
  if (!hint || !state.selectedRoute) return;
  const seats = state.selectedSeats.length || 1;
  const deposit = Number($("#deposit-amount")?.value || 0);
  const pricing = computePricing(state.selectedRoute.baseFare, seats, { depositAmount: deposit });
  hint.innerHTML = `Total <strong>${money(pricing.total)}</strong> · Deposit <strong>${money(pricing.depositAmount)}</strong> · Due <strong>${money(pricing.dueAmount)}</strong> (${pricing.paymentStatus})`;
  syncPaymentQr();
}

function markDepositPaymentDone({ silent = false } = {}) {
  const already = state.depositPaymentDone;
  state.depositPaymentDone = true;
  const method = $("#payment-method")?.value || "digital";
  const deposit = Number($("#deposit-amount")?.value || 0);
  const active = $("#pay-qr-active");
  const done = $("#pay-qr-done");
  if (active) active.hidden = true;
  if (done) {
    done.hidden = false;
    const msg = $("#pay-qr-done-msg");
    if (msg) {
      msg.textContent = `${methodLabel(method)} deposit ${money(deposit)} received — QR hidden.`;
    }
  }
  const amountBadge = $("#pay-qr-amount");
  if (amountBadge) {
    amountBadge.textContent = "Paid";
    amountBadge.className = "badge pay-paid";
  }
  $("#pay-qr-sub").textContent = "Payment completed";
  if (!silent && !already) toast("Payment received — QR hidden");
}

function clearDepositPaymentDone() {
  state.depositPaymentDone = false;
  const active = $("#pay-qr-active");
  const done = $("#pay-qr-done");
  if (active) active.hidden = false;
  if (done) done.hidden = true;
  const amountBadge = $("#pay-qr-amount");
  if (amountBadge) amountBadge.className = "badge pay-partial";
}

async function syncPaymentQr() {
  const panel = $("#pay-qr-panel");
  if (!panel) return;
  const method = $("#payment-method")?.value || "counter";
  const deposit = Number($("#deposit-amount")?.value || 0);
  const digital = isDigitalPayment(method);

  if (!digital) {
    panel.hidden = true;
    clearDepositPaymentDone();
    return;
  }

  panel.hidden = false;
  $("#pay-qr-title").textContent = `${methodLabel(method)} payment QR`;
  $("#pay-qr-amount").textContent = money(deposit);
  $("#pay-qr-amount").className = "badge pay-partial";

  // After payment is confirmed, keep QR hidden
  if (state.depositPaymentDone) {
    markDepositPaymentDone({ silent: true });
    return;
  }

  clearDepositPaymentDone();

  if (deposit <= 0) {
    $("#pay-qr-sub").textContent = "Enter a deposit amount to generate the QR";
    $("#pay-qr-box").innerHTML = `<p class="muted">Deposit amount required</p>`;
    $("#pay-qr-payload").textContent = "";
    return;
  }

  const cfg = getPaymentAppsConfig();
  const app = cfg[method];
  if (app && app.enabled === false) {
    $("#pay-qr-sub").textContent = `${methodLabel(method)} is disabled in Settings`;
    $("#pay-qr-box").innerHTML = `<p class="muted">Enable ${methodLabel(method)} under Settings → Payment apps</p>`;
    return;
  }

  const ref = `DEP${Date.now().toString(36).slice(-6).toUpperCase()}`;
  const payload = buildPaymentQrPayload({ method, amount: deposit, ref });
  $("#pay-qr-sub").textContent = `Scan with ${methodLabel(method)} · deposit ${money(deposit)}`;
  $("#pay-qr-payload").textContent = payload || "";
  await renderPaymentQr($("#pay-qr-box"), payload);
}

$("#deposit-amount")?.addEventListener("input", () => {
  // Amount change invalidates a previous “paid” confirmation
  if (state.depositPaymentDone) clearDepositPaymentDone();
  syncDepositHint();
});
$("#payment-method")?.addEventListener("change", () => {
  clearDepositPaymentDone();
  syncPaymentQr();
});
$("#passenger-form")?.addEventListener("input", (e) => {
  if (e.target?.name === "depositAmount") {
    if (state.depositPaymentDone) clearDepositPaymentDone();
    syncDepositHint();
  }
});

$("#btn-toggle-qr-payload")?.addEventListener("click", () => {
  const pre = $("#pay-qr-payload");
  if (!pre) return;
  pre.hidden = !pre.hidden;
  $("#btn-toggle-qr-payload").textContent = pre.hidden ? "Show QR data" : "Hide QR data";
});

$("#btn-payment-received")?.addEventListener("click", () => {
  const deposit = Number($("#deposit-amount")?.value || 0);
  const method = $("#payment-method")?.value;
  if (!isDigitalPayment(method)) return;
  if (deposit <= 0) {
    toast("Enter deposit amount first");
    return;
  }
  markDepositPaymentDone();
});

$("#btn-show-qr-again")?.addEventListener("click", () => {
  clearDepositPaymentDone();
  syncPaymentQr();
});

/* ---------- Tickets ---------- */

function sortTickets(tickets, sortKey) {
  const list = [...tickets];
  switch (sortKey) {
    case "oldest":
      return list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    case "name":
      return list.sort((a, b) => a.passenger.fullName.localeCompare(b.passenger.fullName));
    case "fare-high":
      return list.sort((a, b) => b.pricing.total - a.pricing.total);
    case "fare-low":
      return list.sort((a, b) => a.pricing.total - b.pricing.total);
    case "bus":
      return list.sort((a, b) => a.trip.busNumber.localeCompare(b.trip.busNumber));
    case "date":
      return list.sort((a, b) => a.trip.travelDate.localeCompare(b.trip.travelDate));
    case "newest":
    default:
      return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

function ticketCardHtml(t) {
  const L = t.luggage || { pieces: 0, weightKg: 0, description: "" };
  const payStatus = t.pricing.paymentStatus || "paid";
  const deposit = Number(t.pricing.depositAmount ?? (payStatus === "paid" ? t.pricing.total : 0));
  const due = Number(t.pricing.dueAmount ?? (payStatus === "paid" ? 0 : t.pricing.total));
  return `
    <article class="ticket-card">
      <header>
        <div>
          <h3>${t.bookingRef}</h3>
          <div class="muted">${escapeHtml(t.trip.from)} → ${escapeHtml(t.trip.to)} · ${t.trip.travelDate}</div>
        </div>
        <div class="badge-stack">
          <span class="badge ${t.status}">${t.status}</span>
          <span class="badge pay-${payStatus}">${payStatus}</span>
        </div>
      </header>
      <div class="ticket-grid">
        <div><strong>Passenger</strong>${escapeHtml(t.passenger.fullName)}</div>
        <div><strong>Phone</strong>${escapeHtml(t.passenger.phone)}</div>
        <div><strong>Pick-up</strong>${escapeHtml(t.passenger.pickupAddress || "—")}</div>
        <div><strong>Seats</strong>${(t.trip.seatNumbers || []).join(", ")}</div>
        <div><strong>Bus</strong>${escapeHtml(t.trip.busNumber)} · ${t.trip.departureTime}</div>
        <div><strong>Luggage</strong>${L.pieces || 0} pcs · ${L.weightKg || 0} kg</div>
        <div><strong>Total</strong>${money(t.pricing.total, t.pricing.currency)}</div>
        <div><strong>Deposit</strong>${money(deposit, t.pricing.currency)}</div>
        <div><strong>Due</strong>${money(due, t.pricing.currency)}</div>
        <div><strong>Method</strong>${escapeHtml(t.pricing.paymentMethod || "counter")}</div>
        <div><strong>Booked by</strong>${escapeHtml(t.bookedBy?.fullName || "—")}${t.bookedBy?.counterCode ? ` · ${escapeHtml(t.bookedBy.counterCode)}` : ""}</div>
      </div>
      ${t.notes ? `<p class="muted" style="margin:0.75rem 0 0">Note: ${escapeHtml(t.notes)}</p>` : ""}
      <div class="ticket-actions">
        <button type="button" class="btn btn-whatsapp" data-wa="${t.id}">WhatsApp</button>
        <button type="button" class="btn btn-sms" data-sms="${t.id}">SMS</button>
        <button type="button" class="btn btn-pdf" data-pdf="${t.id}">PDF</button>
        ${
          t.status !== "cancelled" && due > 0
            ? `<button type="button" class="btn btn-primary" data-pay-full="${t.id}">Collect due</button>`
            : ""
        }
        ${
          t.status !== "cancelled"
            ? `<button type="button" class="btn btn-danger" data-cancel="${t.id}">Cancel</button>`
            : ""
        }
      </div>
    </article>`;
}

function bindTicketListActions(list, refreshFn) {
  async function ticketById(id) {
    return (await db.getTickets()).find((x) => x.id === id);
  }

  list.querySelectorAll("[data-wa]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        openWhatsApp(await ticketById(btn.dataset.wa));
        toast("Opening WhatsApp…");
      } catch (err) {
        toast(err.message || "WhatsApp failed");
      }
    });
  });

  list.querySelectorAll("[data-sms]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        openSms(await ticketById(btn.dataset.sms));
        toast("Opening Messages…");
      } catch (err) {
        toast(err.message || "SMS failed");
      }
    });
  });

  list.querySelectorAll("[data-pdf]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        downloadTicketPdf(await ticketById(btn.dataset.pdf));
        toast("PDF downloaded");
      } catch (err) {
        toast(err.message || "PDF failed");
      }
    });
  });

  list.querySelectorAll("[data-pay-full]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ticket = await ticketById(btn.dataset.payFull);
      if (!ticket) return;
      const total = Number(ticket.pricing.total || 0);
      await db.updateTicket(ticket.id, {
        pricing: {
          ...ticket.pricing,
          depositAmount: total,
          dueAmount: 0,
          paymentStatus: "paid",
        },
      });
      toast("Due collected — ticket fully paid");
      refreshFn();
      if ($("#view-dashboard").classList.contains("active")) renderDashboard();
    });
  });

  list.querySelectorAll("[data-cancel]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ticket = await ticketById(btn.dataset.cancel);
      if (!ticket) return;
      const ok = await confirmDialog({
        title: "Cancel ticket",
        message: `Cancel booking ${ticket.bookingRef}? Seats will be released.`,
        confirmLabel: "Cancel ticket",
      });
      if (!ok) return;
      await db.releaseSeats(ticket.trip.routeId, ticket.trip.travelDate, ticket.trip.seatNumbers);
      await db.updateTicket(ticket.id, { status: "cancelled" });
      toast("Ticket cancelled");
      refreshFn();
    });
  });
}

function setPassengerHistoryMode(on) {
  const panel = $("#passenger-history-panel");
  const toolbar = $("#ticket-toolbar");
  const list = $("#tickets-list");
  const btn = $("#btn-passenger-history");
  if (!panel) return;
  panel.hidden = !on;
  if (toolbar) toolbar.hidden = on;
  if (list) list.hidden = on;
  if (btn) btn.classList.toggle("btn-primary", on);
  if (btn) btn.classList.toggle("btn-secondary", !on);
}

async function renderPassengerHistory() {
  const nameQ = ($("#passenger-history-name")?.value || "").toLowerCase().trim();
  const addrQ = ($("#passenger-history-address")?.value || "").toLowerCase().trim();
  const list = $("#passenger-history-list");
  const summary = $("#passenger-history-summary");
  if (!list) return;

  if (!nameQ && !addrQ) {
    if (summary) {
      summary.hidden = false;
      summary.textContent = "Enter a passenger name and/or pick-up address to search.";
    }
    list.innerHTML = `<div class="empty">Search by name or address to see trip history.</div>`;
    return;
  }

  let tickets = await db.getTickets();
  tickets = tickets.filter((t) => {
    const name = (t.passenger?.fullName || "").toLowerCase();
    const addr = (t.passenger?.pickupAddress || "").toLowerCase();
    if (nameQ && !name.includes(nameQ)) return false;
    if (addrQ && !addr.includes(addrQ)) return false;
    return true;
  });
  tickets = sortTickets(tickets, "newest");

  if (!tickets.length) {
    if (summary) {
      summary.hidden = false;
      summary.textContent = "No passengers matched that name/address.";
    }
    list.innerHTML = `<div class="empty">No history found. Try another name or address.</div>`;
    return;
  }

  const groups = new Map();
  for (const t of tickets) {
    const phone = (t.passenger?.phone || "").replace(/\D/g, "");
    const key =
      phone ||
      `${(t.passenger?.fullName || "").toLowerCase().trim()}|${(t.passenger?.pickupAddress || "")
        .toLowerCase()
        .trim()}`;
    if (!groups.has(key)) {
      groups.set(key, {
        fullName: t.passenger.fullName,
        phone: t.passenger.phone,
        pickupAddress: t.passenger.pickupAddress || "",
        tickets: [],
      });
    }
    groups.get(key).tickets.push(t);
  }

  if (summary) {
    summary.hidden = false;
    summary.textContent = `${groups.size} passenger${groups.size === 1 ? "" : "s"} · ${tickets.length} trip${tickets.length === 1 ? "" : "s"}`;
  }

  list.innerHTML = [...groups.values()]
    .map((g) => {
      const trips = g.tickets.length;
      const last = g.tickets[0];
      return `
        <section class="passenger-history-group">
          <h4>${escapeHtml(g.fullName)}</h4>
          <p class="passenger-history-meta">
            ${escapeHtml(g.phone || "No phone")}
            · Pick-up: ${escapeHtml(g.pickupAddress || "—")}
            · ${trips} trip${trips === 1 ? "" : "s"}
            · Last: ${escapeHtml(last.trip.from)} → ${escapeHtml(last.trip.to)} (${last.trip.travelDate})
          </p>
          <div class="tickets-list">
            ${g.tickets.map((t) => ticketCardHtml(t)).join("")}
          </div>
        </section>`;
    })
    .join("");

  bindTicketListActions(list, () => renderPassengerHistory());
}

async function renderTickets() {
  if (!$("#passenger-history-panel")?.hidden) {
    await renderPassengerHistory();
    return;
  }

  const q = ($("#ticket-search").value || "").toLowerCase().trim();
  const status = $("#ticket-filter").value;
  const pay = $("#ticket-pay-filter").value;
  const sortKey = $("#ticket-sort").value;
  let tickets = await db.getTickets();

  if (status !== "all") tickets = tickets.filter((t) => t.status === status);
  if (pay !== "all") {
    tickets = tickets.filter((t) => (t.pricing.paymentStatus || "paid") === pay);
  }
  if (q) {
    tickets = tickets.filter((t) => {
      const L = t.luggage || {};
      const hay = [
        t.bookingRef,
        t.passenger.fullName,
        t.passenger.phone,
        t.passenger.email,
        t.passenger.pickupAddress,
        t.trip.from,
        t.trip.to,
        t.trip.busNumber,
        t.pricing.paymentStatus,
        L.description,
        ...(t.trip.seatNumbers || []),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }

  tickets = sortTickets(tickets, sortKey);
  const list = $("#tickets-list");
  if (!tickets.length) {
    list.innerHTML = `<div class="empty">No tickets match your search. Try Reset or book a trip.</div>`;
    return;
  }

  list.innerHTML = tickets.map((t) => ticketCardHtml(t)).join("");
  bindTicketListActions(list, () => renderTickets());
}

$("#ticket-toolbar").addEventListener("submit", (e) => {
  e.preventDefault();
  renderTickets();
});

$("#btn-ticket-reset").addEventListener("click", () => {
  $("#ticket-search").value = "";
  $("#ticket-filter").value = "all";
  $("#ticket-pay-filter").value = "all";
  $("#ticket-sort").value = "newest";
  renderTickets();
});

$("#ticket-sort").addEventListener("change", () => renderTickets());
$("#ticket-filter").addEventListener("change", () => renderTickets());
$("#ticket-pay-filter").addEventListener("change", () => renderTickets());

$("#btn-passenger-history")?.addEventListener("click", () => {
  const open = $("#passenger-history-panel")?.hidden;
  setPassengerHistoryMode(!!open);
  if (open) {
    renderPassengerHistory();
    $("#passenger-history-name")?.focus();
  } else {
    renderTickets();
  }
});

$("#btn-passenger-history-close")?.addEventListener("click", () => {
  setPassengerHistoryMode(false);
  renderTickets();
});

$("#passenger-history-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  renderPassengerHistory();
});

$("#btn-passenger-history-reset")?.addEventListener("click", () => {
  if ($("#passenger-history-name")) $("#passenger-history-name").value = "";
  if ($("#passenger-history-address")) $("#passenger-history-address").value = "";
  renderPassengerHistory();
});

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/* ---------- Dashboard ---------- */

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function renderDashboard() {
  const dateInput = $("#dash-date");
  if (!dateInput.value) dateInput.value = $("#travel-date")?.value || todayIso();
  const travelDate = dateInput.value;

  const [buses, tickets] = await Promise.all([db.getBuses(), db.getTickets()]);
  const summaries = buses.map((b) => summarizeBusDay(b, tickets, travelDate));

  const active = summaries.filter((s) => s.passengerCount > 0);
  const paidSum = summaries.reduce((n, s) => n + s.paidTotal, 0);
  const dueSum = summaries.reduce((n, s) => n + s.dueTotal, 0);
  const pax = summaries.reduce((n, s) => n + s.passengerCount, 0);
  const bags = summaries.reduce((n, s) => n + s.luggagePieces, 0);

  $("#dash-stats").innerHTML = `
    <div class="stat-card"><span class="stat-label">Buses</span><strong>${buses.length}</strong><small>${active.length} with bookings</small></div>
    <div class="stat-card"><span class="stat-label">Passengers</span><strong>${pax}</strong><small>${travelDate}</small></div>
    <div class="stat-card accent-paid"><span class="stat-label">Paid</span><strong>${money(paidSum)}</strong><small>collected</small></div>
    <div class="stat-card accent-due"><span class="stat-label">Due</span><strong>${money(dueSum)}</strong><small>outstanding</small></div>
    <div class="stat-card"><span class="stat-label">Luggage</span><strong>${bags}</strong><small>pieces</small></div>
  `;

  if (!buses.length) {
    $("#dash-buses").innerHTML = `<div class="empty">No buses yet. Admin can add fleet or load demo data.</div>`;
    $("#dash-detail").hidden = true;
    return;
  }

  if (!state.dashBusId || !buses.some((b) => b.id === state.dashBusId)) {
    state.dashBusId = buses[0].id;
  }

  $("#dash-buses").innerHTML = summaries
    .map((s) => {
      const fill = s.seatsTotal ? Math.round((s.seatsBooked / s.seatsTotal) * 100) : 0;
      const selected = state.dashBusId === s.bus.id ? "selected" : "";
      return `
      <button type="button" class="bus-card ${selected}" data-bus="${s.bus.id}">
        <div class="bus-card-top">
          <h3>${escapeHtml(s.bus.busNumber)}</h3>
          <span class="badge">${escapeHtml(s.bus.busType)}</span>
        </div>
        <p class="muted">${escapeHtml(s.bus.operator)}</p>
        <div class="seat-bar"><i style="width:${fill}%"></i></div>
        <div class="bus-metrics">
          <span>${s.passengerCount} pax</span>
          <span>${s.seatsBooked}/${s.seatsTotal} seats</span>
          <span>${s.luggagePieces} bags</span>
        </div>
        <div class="bus-money">
          <span class="ok-text">Paid ${money(s.paidTotal)}</span>
          <span class="due-text">Due ${money(s.dueTotal)}</span>
        </div>
      </button>`;
    })
    .join("");

  $("#dash-buses").querySelectorAll("[data-bus]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.dashBusId = btn.dataset.bus;
      renderDashboard();
    });
  });

  const summary = summaries.find((s) => s.bus.id === state.dashBusId);
  renderDashDetail(summary);
}

function renderDashDetail(summary) {
  const box = $("#dash-detail");
  if (!summary) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const rows = summary.tickets.length
    ? summary.tickets
        .slice()
        .sort((a, b) => ((a.trip.seatNumbers || [])[0] || "").localeCompare((b.trip.seatNumbers || [])[0] || ""))
        .map((t) => {
          const L = t.luggage || {};
          const pay = t.pricing.paymentStatus || "paid";
          return `<tr>
            <td>${(t.trip.seatNumbers || []).join(", ")}</td>
            <td>${escapeHtml(t.passenger.fullName)}<div class="muted">${escapeHtml(t.bookingRef)}</div></td>
            <td>${escapeHtml(t.passenger.phone)}</td>
            <td>${escapeHtml(t.trip.from)} → ${escapeHtml(t.trip.to)}</td>
            <td>${L.pieces || 0} · ${L.weightKg || 0}kg<div class="muted">${escapeHtml(L.description || "")}</div></td>
            <td><span class="badge pay-${pay}">${pay}</span></td>
            <td>${money(t.pricing.total, t.pricing.currency)}
              <div class="muted">Dep ${money(t.pricing.depositAmount ?? 0)} · Due ${money(t.pricing.dueAmount ?? 0)}</div>
            </td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="7" class="muted">No bookings for this bus on ${summary.travelDate}.</td></tr>`;

  box.innerHTML = `
    <div class="dash-detail-head">
      <div>
        <h3>${escapeHtml(summary.bus.busNumber)} · ${escapeHtml(summary.bus.busType)}</h3>
        <p class="muted">${escapeHtml(summary.bus.operator)} · ${summary.travelDate} · ${summary.passengerCount} passengers</p>
      </div>
      <button type="button" class="btn btn-primary" id="btn-bus-pdf">Download bus PDF</button>
    </div>
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>Seat</th><th>Passenger</th><th>Phone</th><th>Route</th><th>Luggage</th><th>Pay</th><th>Total</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  $("#btn-bus-pdf").addEventListener("click", async () => {
    try {
      const allExpenses = await db.getExpenses();
      const expenses = allExpenses.filter(
        (e) =>
          e.expenseDate === summary.travelDate &&
          (e.busId === summary.bus.id ||
            (e.busNumber && e.busNumber === summary.bus.busNumber))
      );
      downloadBusManifestPdf({ ...summary, expenses });
      toast("Bus PDF downloaded");
    } catch (err) {
      toast(err.message || "PDF failed");
    }
  });
}

$("#dash-date").addEventListener("change", () => {
  state.dashBusId = null;
  renderDashboard();
});

/* ---------- Expenses ---------- */

async function fillExpenseBusSelect() {
  const buses = await db.getBuses();
  const sel = $("#expense-bus");
  if (!sel) return;
  sel.innerHTML =
    `<option value="">None</option>` +
    buses.map((b) => `<option value="${b.id}">${escapeHtml(b.busNumber)} · ${escapeHtml(b.displayName || b.operator)}</option>`).join("");
}

/** Admin sees all expenses; each staff only sees their own entries. */
function expensesVisibleToCurrentUser(list) {
  if (isAdmin()) return list;
  const staffId = getCurrentStaffId();
  if (!staffId) return [];
  return list.filter((e) => e.createdBy?.role === "staff" && e.createdBy?.staffId === staffId);
}

async function renderExpenses() {
  await fillExpenseBusSelect();
  if ($("#expense-date") && !$("#expense-date").value) {
    $("#expense-date").value = new Date().toISOString().slice(0, 10);
  }

  const q = ($("#expense-search").value || "").toLowerCase().trim();
  let list = expensesVisibleToCurrentUser(await db.getExpenses());
  if (q) {
    list = list.filter((e) =>
      [e.title, e.category, e.notes, e.busNumber, e.createdBy?.name]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }

  const total = list.reduce((n, e) => n + Number(e.amount || 0), 0);
  const scopeLabel = isAdmin() ? "all staff + admin" : "your entries only";
  $("#expense-total-label").textContent = `Total recorded: ${money(total)} (${list.length} · ${scopeLabel})`;

  const box = $("#expenses-list");
  if (!list.length) {
    box.innerHTML = `<div class="empty">${
      isAdmin()
        ? "No expenses yet. Add the first entry on the left."
        : "No expenses of yours yet. Other staff entries stay private."
    }</div>`;
    return;
  }

  box.innerHTML = list
    .map(
      (e) => `
    <article class="ticket-card">
      <header>
        <div>
          <h3>${escapeHtml(e.title)}</h3>
          <div class="muted">${escapeHtml(e.category)} · ${e.expenseDate}</div>
        </div>
        <span class="badge pay-due">${money(e.amount)}</span>
      </header>
      <div class="ticket-grid">
        <div><strong>Bus</strong>${escapeHtml(e.busNumber || "—")}</div>
        ${
          isAdmin()
            ? `<div><strong>Added by</strong>${escapeHtml(e.createdBy?.name || "—")} (${escapeHtml(e.createdBy?.role || "")}${
                e.createdBy?.counterCode ? ` · ${escapeHtml(e.createdBy.counterCode)}` : ""
              })</div>`
            : ""
        }
        <div><strong>Notes</strong>${escapeHtml(e.notes || "—")}</div>
        <div><strong>Created</strong>${new Date(e.createdAt).toLocaleString()}</div>
      </div>
      <div class="ticket-actions">
        <button type="button" class="btn btn-danger" data-del-exp="${e.id}">Delete</button>
      </div>
    </article>`
    )
    .join("");

  box.querySelectorAll("[data-del-exp]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.delExp;
      const all = await db.getExpenses();
      const expense = all.find((e) => e.id === id);
      if (!expense) return;
      if (!isAdmin()) {
        const staffId = getCurrentStaffId();
        if (expense.createdBy?.staffId !== staffId) {
          toast("You can only delete your own expenses");
          return;
        }
      }
      const ok = await confirmDialog({
        title: "Delete expense",
        message: `Delete “${expense.title}”? This cannot be undone.`,
        confirmLabel: "Delete",
      });
      if (!ok) return;
      await db.deleteExpense(id);
      toast("Expense deleted");
      renderExpenses();
    });
  });
}

$("#expense-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(e.target).entries());
  const buses = await db.getBuses();
  const bus = buses.find((b) => b.id === fd.busId);
  const createdBy = isAdmin()
    ? { role: "admin", name: "Admin" }
    : {
        role: "staff",
        name: state.currentStaff?.fullName || "Staff",
        staffId: getCurrentStaffId(),
        counterCode: state.currentStaff?.counterCode || "",
      };

  await db.saveExpense(
    createExpense({
      title: fd.title,
      category: fd.category,
      amount: fd.amount,
      expenseDate: fd.expenseDate,
      notes: fd.notes,
      busId: bus?.id || "",
      busNumber: bus?.busNumber || "",
      createdBy,
    })
  );
  e.target.reset();
  if ($("#expense-date")) $("#expense-date").value = new Date().toISOString().slice(0, 10);
  toast("Expense saved");
  renderExpenses();
});

$("#expense-search")?.addEventListener("input", () => renderExpenses());

/* ---------- Admin: counter staff ---------- */

function resetStaffForm() {
  state.editingStaffId = null;
  state.staffAssignedSeats = [];
  state.staffAssignedBusId = "";
  $("#staff-form").reset();
  $("#staff-edit-id").value = "";
  $("#staff-form-title").textContent = "Add counter staff";
  $("#staff-form-sub").textContent =
    "Create login access for a counter. First login verifies the registered mobile with OTP, then uses this PIN.";
  $("#staff-form-submit").textContent = "Save staff";
  const status = $("#staff-form").status;
  if (status) status.value = "active";
  renderStaffSeatAssign();
}

async function fillStaffBusSelect(selectedId = "") {
  const buses = await db.getBuses();
  const sel = $("#staff-bus-select");
  if (!sel) return;
  sel.innerHTML =
    `<option value="">Select bus seat chart…</option>` +
    buses
      .map(
        (b) =>
          `<option value="${b.id}" ${b.id === selectedId ? "selected" : ""}>${escapeHtml(b.busNumber)} · ${escapeHtml(b.displayName || b.operator)} (${b.totalSeats} seats)</option>`
      )
      .join("");
}

async function renderStaffSeatAssign() {
  const map = $("#staff-seat-map");
  const summary = $("#staff-seat-summary");
  const busId = $("#staff-bus-select")?.value || state.staffAssignedBusId || "";
  state.staffAssignedBusId = busId;

  if (!map) return;

  if (!busId) {
    map.innerHTML = `<div class="empty">Select a bus above to assign seats.</div>`;
    if (summary) summary.textContent = "No seats assigned yet";
    return;
  }

  const buses = await db.getBuses();
  const bus = buses.find((b) => b.id === busId);
  if (!bus) {
    map.innerHTML = `<div class="empty">Bus not found.</div>`;
    return;
  }

  const layout = normalizeSeatLayout(bus.seatLayout, bus.totalSeats);

  // Seats already assigned to other staff on this bus
  const allStaff = await db.getStaff();
  const takenByOthers = allStaff
    .filter((s) => s.status === "active" && s.assignedBusId === busId && s.id !== state.editingStaffId)
    .flatMap((s) => s.assignedSeats || []);

  renderSeatChart(map, {
    layout,
    taken: takenByOthers,
    selected: state.staffAssignedSeats,
    assignMode: true,
    onToggle: (seatId) => {
      if (state.staffAssignedSeats.includes(seatId)) {
        state.staffAssignedSeats = state.staffAssignedSeats.filter((s) => s !== seatId);
      } else {
        state.staffAssignedSeats.push(seatId);
      }
      renderStaffSeatAssign();
    },
  });

  if (summary) {
    summary.textContent = state.staffAssignedSeats.length
      ? `Assigned seats (selected): ${state.staffAssignedSeats.join(", ")}`
      : "No seats assigned yet — tap seats to mark selected";
  }
}

async function renderAdmin() {
  if (!isAdmin()) {
    toast("Admin only");
    goToView("book");
    return;
  }

  const [staff, tickets, buses] = await Promise.all([db.getStaff(), db.getTickets(), db.getBuses()]);
  await fillStaffBusSelect(state.staffAssignedBusId || $("#staff-bus-select")?.value || "");
  renderStaffSeatAssign();

  const active = staff.filter((s) => s.status === "active").length;
  const inactive = staff.length - active;

  $("#admin-overview").innerHTML = `
    <div class="stat-card"><span class="stat-label">Counter staff</span><strong>${staff.length}</strong><small>${active} active · ${inactive} inactive</small></div>
    <div class="stat-card"><span class="stat-label">Tickets</span><strong>${tickets.length}</strong><small>all time</small></div>
    <div class="stat-card"><span class="stat-label">Fleet buses</span><strong>${buses.length}</strong><small>registered</small></div>
    <div class="stat-card accent-paid"><span class="stat-label">Access</span><strong>Full</strong><small>admin permissions</small></div>
  `;

  const q = ($("#staff-search").value || "").toLowerCase().trim();
  let list = [...staff];
  if (q) {
    list = list.filter((s) =>
      [s.fullName, s.phone, s.email, s.counterCode, s.counterLocation, s.city, s.shift, ...(s.assignedSeats || [])]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }

  const box = $("#staff-list");
  if (!list.length) {
    box.innerHTML = `<div class="empty">No counter staff yet. Add the first counter account on the left.</div>`;
    return;
  }

  box.innerHTML = list
    .map((s) => {
      const bus = buses.find((b) => b.id === s.assignedBusId);
      const seats = (s.assignedSeats || []).join(", ") || "—";
      return `
    <article class="staff-card ${s.status}">
      <header>
        <div>
          <h4>${escapeHtml(s.fullName)}</h4>
          <div class="muted">${escapeHtml(s.counterCode)} · ${escapeHtml(s.counterLocation)}</div>
        </div>
        <div class="badge-stack">
          <span class="badge ${s.status === "active" ? "confirmed" : "cancelled"}">${s.status}</span>
          <span class="badge ${s.phoneVerified ? "pay-paid" : "pay-due"}">${
            s.phoneVerified ? "Mobile verified" : "OTP pending"
          }</span>
        </div>
      </header>
      <div class="ticket-grid">
        <div><strong>Phone</strong>${escapeHtml(s.phone)}</div>
        <div><strong>City</strong>${escapeHtml(s.city || "—")}</div>
        <div><strong>Shift</strong>${escapeHtml(s.shift)}</div>
        <div><strong>Bus</strong>${escapeHtml(bus?.busNumber || "Not set")}</div>
        <div class="span-seats"><strong>Assigned seats</strong><span class="seat-tags">${escapeHtml(seats)}</span></div>
      </div>
      ${s.notes ? `<p class="muted" style="margin:0.6rem 0 0">${escapeHtml(s.notes)}</p>` : ""}
      <div class="ticket-actions">
        <button type="button" class="btn btn-secondary" data-edit-staff="${s.id}">Edit</button>
        ${
          s.phoneVerified
            ? `<button type="button" class="btn btn-ghost" data-reset-otp="${s.id}">Reset mobile verify</button>`
            : ""
        }
        <button type="button" class="btn btn-ghost" data-toggle-staff="${s.id}">${s.status === "active" ? "Deactivate" : "Activate"}</button>
        <button type="button" class="btn btn-danger" data-del-staff="${s.id}">Remove</button>
      </div>
    </article>`;
    })
    .join("");

  box.querySelectorAll("[data-edit-staff]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const member = (await db.getStaff()).find((x) => x.id === btn.dataset.editStaff);
      if (!member) return;
      state.editingStaffId = member.id;
      state.staffAssignedSeats = [...(member.assignedSeats || [])];
      state.staffAssignedBusId = member.assignedBusId || "";
      const form = $("#staff-form");
      form.fullName.value = member.fullName;
      form.phone.value = member.phone;
      form.email.value = member.email || "";
      form.counterCode.value = member.counterCode;
      form.counterLocation.value = member.counterLocation;
      form.city.value = member.city || "";
      form.shift.value = member.shift || "Morning";
      form.pin.value = member.pin;
      form.status.value = member.status || "active";
      form.notes.value = member.notes || "";
      $("#staff-edit-id").value = member.id;
      $("#staff-form-title").textContent = "Edit counter staff";
      $("#staff-form-sub").textContent = `Updating ${member.fullName} — assigned seats stay marked selected`;
      $("#staff-form-submit").textContent = "Update staff";
      await fillStaffBusSelect(member.assignedBusId || "");
      renderStaffSeatAssign();
      form.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  box.querySelectorAll("[data-reset-otp]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const member = (await db.getStaff()).find((x) => x.id === btn.dataset.resetOtp);
      if (!member) return;
      const ok = await confirmDialog({
        title: "Reset verification",
        message: `Require OTP again for ${member.fullName} on next login?`,
        confirmLabel: "Reset",
        danger: true,
      });
      if (!ok) return;
      await db.updateStaff(member.id, { phoneVerified: false, phoneVerifiedAt: null });
      toast("Mobile verification reset — OTP required on next login");
      renderAdmin();
    });
  });

  box.querySelectorAll("[data-toggle-staff]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const member = (await db.getStaff()).find((x) => x.id === btn.dataset.toggleStaff);
      if (!member) return;
      const next = member.status === "active" ? "inactive" : "active";
      await db.updateStaff(member.id, { status: next });
      toast(`${member.fullName} marked ${next}`);
      renderAdmin();
    });
  });

  box.querySelectorAll("[data-del-staff]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const member = (await db.getStaff()).find((x) => x.id === btn.dataset.delStaff);
      if (!member) return;
      const ok = await confirmDialog({
        title: "Remove user",
        message: `Remove ${member.fullName} from counter users?`,
        confirmLabel: "Remove",
      });
      if (!ok) return;
      await db.deleteStaff(member.id);
      if (state.editingStaffId === member.id) resetStaffForm();
      toast("Staff removed");
      renderAdmin();
    });
  });
}

$("#staff-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!isAdmin()) return toast("Admin only");
  const fd = Object.fromEntries(new FormData(e.target).entries());
  const busId = $("#staff-bus-select")?.value || "";
  if (!busId) {
    toast("Select a bus to assign seats");
    return;
  }
  if (!state.staffAssignedSeats.length) {
    toast("Assign at least one seat (tap seats to mark selected)");
    return;
  }
  try {
    await assertUniqueStaffPin(fd.pin, state.editingStaffId || null);
    const seatPayload = {
      assignedBusId: busId,
      assignedSeats: [...state.staffAssignedSeats],
    };
    if (state.editingStaffId) {
      const existing = (await db.getStaff()).find((s) => s.id === state.editingStaffId);
      const phoneChanged = existing && existing.phone.trim() !== fd.phone.trim();
      await db.updateStaff(state.editingStaffId, {
        fullName: fd.fullName.trim(),
        phone: fd.phone.trim(),
        email: (fd.email || "").trim(),
        counterCode: fd.counterCode.trim().toUpperCase(),
        counterLocation: fd.counterLocation.trim(),
        city: (fd.city || "").trim(),
        shift: fd.shift,
        pin: fd.pin,
        status: fd.status,
        notes: (fd.notes || "").trim(),
        ...seatPayload,
        ...(phoneChanged ? { phoneVerified: false, phoneVerifiedAt: null } : {}),
      });
      toast(phoneChanged ? "Staff updated — new number needs OTP on next login" : "Staff updated");
    } else {
      const member = createCounterStaff({ ...fd, ...seatPayload });
      member.status = fd.status || "active";
      await db.saveStaff(member);
      toast(`Added ${member.fullName} with ${member.assignedSeats.length} seats`);
    }
    resetStaffForm();
    renderAdmin();
  } catch (err) {
    toast(err.message || "Could not save staff");
  }
});

$("#staff-form-reset").addEventListener("click", () => resetStaffForm());
$("#staff-search").addEventListener("input", () => renderAdmin());
$("#staff-bus-select")?.addEventListener("change", () => {
  state.staffAssignedSeats = [];
  state.staffAssignedBusId = $("#staff-bus-select").value;
  renderStaffSeatAssign();
});

$$("[data-goto]").forEach((btn) => {
  btn.addEventListener("click", () => goToView(btn.dataset.goto));
});

/* ---------- Fleet ---------- */

async function refreshRouteBusSelect(selectedId = "") {
  const buses = await db.getBuses();
  const sel = $("#route-bus");
  if (!sel) return;
  if (!buses.length) {
    sel.innerHTML = `<option value="">Add a bus first…</option>`;
    return;
  }
  sel.innerHTML = buses
    .map(
      (b) =>
        `<option value="${b.id}" ${b.id === selectedId ? "selected" : ""}>${escapeHtml(b.busNumber)} · ${escapeHtml(
          b.displayName || b.operator
        )}</option>`
    )
    .join("");
}

function setFleetPreviewVisible(visible) {
  const panel = $("#fleet-preview-panel");
  const options = $("#fleet-layout-options");
  const workspace = $("#fleet-workspace");
  const hint = $("#fleet-save-hint");
  if (panel) panel.hidden = !visible;
  if (options) options.hidden = !visible;
  if (workspace) workspace.classList.toggle("preview-open", !!visible);
  if (hint) hint.textContent = visible ? "Ready to save" : "Pick a seat layout before saving";
}

function resetBusForm() {
  state.editingBusId = null;
  const form = $("#bus-form");
  if (!form) return;
  form.reset();
  $("#bus-edit-id").value = "";
  // Restore placeholder option as selected
  const layoutSel = $("#layout-type");
  if (layoutSel) {
    layoutSel.value = "";
    const placeholder = layoutSel.querySelector('option[value=""]');
    if (placeholder) placeholder.selected = true;
  }
  if (form.seatRows) form.seatRows.value = 8;
  if (form.includeRear) form.includeRear.checked = true;
  $$('#bus-form input[name="amenity"]').forEach((el) => {
    el.checked = ["Night", "Music System", "Fan", "Comfortable Seats"].includes(el.value);
  });
  $("#bus-form-title").textContent = "Add bus & route";
  $("#bus-form-sub").textContent = "Bus details, seat layout, and an optional trip in one place.";
  $("#bus-form-submit").textContent = "Save bus";
  const mode = $("#bus-form-mode");
  if (mode) {
    mode.textContent = "New";
    mode.className = "badge";
  }
  setFleetPreviewVisible(false);
  const preview = $("#fleet-seat-preview");
  if (preview) preview.innerHTML = "";
  const countEl = $("#seat-count-preview");
  if (countEl) countEl.textContent = "Choose a layout to see seat count";
}

function fillBusForm(bus) {
  state.editingBusId = bus.id;
  const form = $("#bus-form");
  $("#bus-edit-id").value = bus.id;
  form.busNumber.value = bus.busNumber || "";
  form.displayName.value = bus.displayName || bus.operator || "";
  form.operator.value = bus.operator || "";
  form.busType.value = bus.busType || "2x2 Sofa Seater";
  const layout = bus.seatLayout || {};
  const layoutType = layout.type === "grid" ? "grid" : "2x2";
  form.layoutType.value = layoutType;
  form.seatRows.value = layout.rows || Math.max(4, Math.ceil((bus.totalSeats || 32) / 4));
  form.includeRear.checked = layout.includeRear !== false;
  const amSet = new Set(bus.amenities || []);
  $$('#bus-form input[name="amenity"]').forEach((el) => {
    el.checked = amSet.has(el.value);
  });
  // Clear optional route fields when editing bus
  if (form.routeFrom) form.routeFrom.value = "";
  if (form.routeTo) form.routeTo.value = "";
  if (form.routeDeparture) form.routeDeparture.value = "";
  if (form.routeArrival) form.routeArrival.value = "";
  if (form.routeFare) form.routeFare.value = "";
  $("#bus-form-title").textContent = "Edit bus";
  $("#bus-form-sub").textContent = `Updating ${bus.busNumber} — change seat layout to refresh the chart.`;
  $("#bus-form-submit").textContent = "Update bus";
  const mode = $("#bus-form-mode");
  if (mode) {
    mode.textContent = "Editing";
    mode.className = "badge pay-partial";
  }
  setFleetPreviewVisible(true);
  updateFleetSeatPreview();
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function renderFleet() {
  const [buses, routes] = await Promise.all([db.getBuses(), db.getRoutes()]);

  const busCount = $("#fleet-bus-count");
  if (busCount) busCount.textContent = `${buses.length} bus${buses.length === 1 ? "" : "es"} in fleet`;
  const routeCount = $("#fleet-route-count");
  if (routeCount) routeCount.textContent = `${routes.length} trip${routes.length === 1 ? "" : "s"}`;

  const busList = $("#fleet-bus-list");
  if (!busList) return;

  if (!buses.length) {
    busList.innerHTML = `<div class="empty">No buses yet. Add one above or load demo data in Settings.</div>`;
  } else {
    busList.innerHTML = buses
      .map((b) => {
        const tripCount = routes.filter((r) => r.busId === b.id).length;
        const seats = b.totalSeats || b.seatLayout?.totalSeats || 0;
        const amenities = (b.amenities || []).slice(0, 4).join(" · ") || "—";
        return `
      <article class="fleet-bus-card ${state.editingBusId === b.id ? "is-editing" : ""}">
        <header>
          <div>
            <h4>${escapeHtml(b.busNumber)}</h4>
            <div class="muted">${escapeHtml(b.displayName || b.operator)}</div>
          </div>
          <span class="badge">${escapeHtml(b.busType || "Bus")}</span>
        </header>
        <div class="fleet-bus-meta">
          <div><strong>Operator</strong>${escapeHtml(b.operator)}</div>
          <div><strong>Seats</strong>${seats} · ${escapeHtml(b.seatLayout?.type || "2x2")}</div>
          <div><strong>Trips</strong>${tripCount}</div>
          <div class="span-full"><strong>Amenities</strong>${escapeHtml(amenities)}</div>
        </div>
        <div class="ticket-actions">
          <button type="button" class="btn btn-secondary" data-edit-bus="${b.id}">Edit</button>
          <button type="button" class="btn btn-danger" data-del-bus="${b.id}">Delete</button>
        </div>
      </article>`;
      })
      .join("");
  }

  busList.querySelectorAll("[data-edit-bus]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const bus = (await db.getBuses()).find((b) => b.id === btn.dataset.editBus);
      if (!bus) return;
      fillBusForm(bus);
    });
  });

  busList.querySelectorAll("[data-del-bus]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const bus = (await db.getBuses()).find((b) => b.id === btn.dataset.delBus);
      if (!bus) return;
      const linked = (await db.getRoutes()).filter((r) => r.busId === bus.id).length;
      const msg = linked
        ? `Delete ${bus.busNumber}? This also removes ${linked} scheduled trip(s).`
        : `Delete bus ${bus.busNumber}?`;
      const ok = await confirmDialog({
        title: "Delete bus",
        message: msg,
        confirmLabel: "Delete",
      });
      if (!ok) return;
      await db.deleteBus(bus.id);
      if (state.editingBusId === bus.id) resetBusForm();
      toast(`${bus.busNumber} deleted`);
      renderFleet();
      await refreshCityOptions();
    });
  });

  const routeList = $("#fleet-route-list");
  if (!routeList) return;
  if (!routes.length) {
    routeList.innerHTML = `<div class="empty">No trips yet. Add route details in the bus form above when saving.</div>`;
  } else {
    routeList.innerHTML = routes
      .map(
        (r) => `
      <article class="fleet-route-card">
        <header>
          <div>
            <h4>${escapeHtml(r.from)} → ${escapeHtml(r.to)}</h4>
            <div class="muted">${escapeHtml(r.busNumber)} · ${r.departureTime} → ${r.arrivalTime}</div>
          </div>
          <span class="badge pay-paid">${money(r.baseFare)}</span>
        </header>
        <div class="ticket-actions">
          <button type="button" class="btn btn-danger" data-del-route="${r.id}">Delete trip</button>
        </div>
      </article>`
      )
      .join("");
  }

  routeList.querySelectorAll("[data-del-route]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: "Delete trip",
        message: "Delete this scheduled trip?",
        confirmLabel: "Delete",
      });
      if (!ok) return;
      await db.deleteRoute(btn.dataset.delRoute);
      toast("Trip deleted");
      renderFleet();
    });
  });
}

async function saveInlineRouteForBus(bus, fd) {
  const from = (fd.routeFrom || "").trim();
  const to = (fd.routeTo || "").trim();
  const departureTime = fd.routeDeparture || "";
  const arrivalTime = fd.routeArrival || "";
  const baseFare = Number(fd.routeFare || 0);
  if (!from && !to && !departureTime && !arrivalTime && !baseFare) return false;
  if (!from || !to || !departureTime || !arrivalTime || !baseFare) {
    throw new Error("To save a trip, fill From, To, Departure, Arrival, and Fare");
  }
  const layout = normalizeSeatLayout(bus.seatLayout, bus.totalSeats);
  await db.saveRoute(
    createRoute({
      busId: bus.id,
      from,
      to,
      departureTime,
      arrivalTime,
      baseFare,
      busNumber: bus.busNumber,
      operator: bus.operator,
      busType: bus.busType,
      displayName: bus.displayName || bus.operator,
      totalSeats: layout.totalSeats,
      seatLayout: layout,
      amenities: bus.amenities || [],
    })
  );
  return true;
}

$("#bus-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!isAdmin()) return toast("Admin only");
  const fd = Object.fromEntries(new FormData(e.target).entries());
  if (!fd.layoutType) {
    toast("Select a seat layout first");
    return;
  }
  const amenities = $$('#bus-form input[name="amenity"]:checked').map((el) => el.value);
  const layout = defaultSeatLayout({
    rows: Number(fd.seatRows || 8),
    includeRear: Boolean(e.target.includeRear?.checked),
    layout: fd.layoutType || "2x2",
  });
  const payload = {
    busNumber: fd.busNumber.trim().toUpperCase(),
    displayName: fd.displayName.trim(),
    operator: fd.operator.trim(),
    busType: fd.busType,
    seatLayout: layout,
    totalSeats: layout.totalSeats,
    amenities,
  };

  try {
    let savedBus = null;
    if (state.editingBusId) {
      const busId = state.editingBusId;
      savedBus = await db.updateBus(busId, payload);
      const allRoutes = await db.getRoutes();
      await db.replaceRoutes(
        allRoutes.map((r) =>
          r.busId === busId
            ? {
                ...r,
                busNumber: payload.busNumber,
                operator: payload.operator,
                busType: payload.busType,
                displayName: payload.displayName,
                totalSeats: payload.totalSeats,
                seatLayout: payload.seatLayout,
                amenities: payload.amenities,
                updatedAt: new Date().toISOString(),
              }
            : r
        )
      );
    } else {
      savedBus = await db.saveBus(createBus(payload));
    }

    let tripSaved = false;
    try {
      tripSaved = await saveInlineRouteForBus(savedBus, fd);
    } catch (routeErr) {
      toast(routeErr.message);
      await refreshCityOptions();
      renderFleet();
      return;
    }

    toast(
      state.editingBusId
        ? tripSaved
          ? "Bus updated · trip added"
          : "Bus updated"
        : tripSaved
          ? "Bus & trip saved"
          : "Bus saved with seat chart"
    );
    resetBusForm();
    await refreshCityOptions();
    renderFleet();
  } catch (err) {
    toast(err.message || "Could not save bus");
  }
});

$("#bus-form-reset")?.addEventListener("click", () => resetBusForm());

function updateFleetSeatPreview() {
  const layoutType = $("#layout-type")?.value || "";
  if (!layoutType) {
    setFleetPreviewVisible(false);
    const preview = $("#fleet-seat-preview");
    if (preview) preview.innerHTML = "";
    return;
  }
  setFleetPreviewVisible(true);
  const rows = Number($("#seat-rows")?.value || 8);
  const includeRear = Boolean($("#include-rear")?.checked);
  const layout = defaultSeatLayout({ rows, includeRear, layout: layoutType });
  const preview = $("#fleet-seat-preview");
  if (!preview) return;
  const countEl = $("#seat-count-preview");
  if (countEl) countEl.textContent = `${layout.totalSeats} seats · live preview`;
  renderSeatChart(preview, { layout, preview: true, taken: [], selected: [] });
}

$("#layout-type")?.addEventListener("change", () => {
  updateFleetSeatPreview();
});

["seat-rows", "include-rear"].forEach((id) => {
  $(`#${id}`)?.addEventListener("input", updateFleetSeatPreview);
  $(`#${id}`)?.addEventListener("change", updateFleetSeatPreview);
});

/* ---------- Settings ---------- */

function setSettingsTab(tab) {
  const allowed = isAdmin() ? ["account", "payments", "data"] : ["account"];
  const next = allowed.includes(tab) ? tab : "account";
  $$(".settings-tab").forEach((b) => b.classList.toggle("active", b.dataset.settingsTab === next));
  $$(".settings-pane").forEach((p) => {
    const id = p.id?.replace("settings-pane-", "");
    const on = id === next;
    p.classList.toggle("active", on);
    p.hidden = !on;
  });
}

$$(".settings-tab").forEach((btn) => {
  btn.addEventListener("click", () => setSettingsTab(btn.dataset.settingsTab));
});

function refreshSettings() {
  applyRoleUI();
  const modeLabel = $("#storage-mode-label");
  if (modeLabel) {
    modeLabel.textContent =
      getStorageMode() === "firebase"
        ? "Connected to Firestore — bookings, fleet, users, and expenses sync to the cloud."
        : "Using this device only (local storage). Firestore is not connected.";
  }
  const payForm = $("#payment-apps-form");
  if (payForm) {
    const pay = getPaymentAppsConfig();
    payForm.esewaEnabled.checked = pay.esewa.enabled !== false;
    payForm.esewaId.value = pay.esewa.merchantId || "";
    payForm.esewaName.value = pay.esewa.merchantName || "";
    payForm.khaltiEnabled.checked = pay.khalti.enabled !== false;
    payForm.khaltiId.value = pay.khalti.merchantId || "";
    payForm.khaltiName.value = pay.khalti.merchantName || "";
    payForm.fonepayEnabled.checked = pay.fonepay.enabled !== false;
    payForm.fonepayId.value = pay.fonepay.merchantId || "";
    payForm.fonepayName.value = pay.fonepay.merchantName || "";
    payForm.imepayEnabled.checked = pay.imepay.enabled !== false;
    payForm.imepayId.value = pay.imepay.merchantId || "";
    payForm.imepayName.value = pay.imepay.merchantName || "";
    payForm.bankEnabled.checked = pay.bank.enabled !== false;
    payForm.bankName.value = pay.bank.bankName || "";
    payForm.bankAccountName.value = pay.bank.accountName || "";
    payForm.bankAccountNumber.value = pay.bank.accountNumber || "";
    payForm.bankBranch.value = pay.bank.branch || "";
  }
  setSettingsTab(document.querySelector(".settings-tab.active")?.dataset.settingsTab || "account");
}

$("#payment-apps-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!isAdmin()) return toast("Admin only");
  const fd = Object.fromEntries(new FormData(e.target).entries());
  savePaymentAppsConfig({
    esewa: {
      enabled: Boolean(e.target.esewaEnabled?.checked),
      merchantId: (fd.esewaId || "").trim(),
      merchantName: (fd.esewaName || "Travel Sewa").trim() || "Travel Sewa",
    },
    khalti: {
      enabled: Boolean(e.target.khaltiEnabled?.checked),
      merchantId: (fd.khaltiId || "").trim(),
      merchantName: (fd.khaltiName || "Travel Sewa").trim() || "Travel Sewa",
    },
    fonepay: {
      enabled: Boolean(e.target.fonepayEnabled?.checked),
      merchantId: (fd.fonepayId || "").trim(),
      merchantName: (fd.fonepayName || "Travel Sewa").trim() || "Travel Sewa",
    },
    imepay: {
      enabled: Boolean(e.target.imepayEnabled?.checked),
      merchantId: (fd.imepayId || "").trim(),
      merchantName: (fd.imepayName || "Travel Sewa").trim() || "Travel Sewa",
    },
    bank: {
      enabled: Boolean(e.target.bankEnabled?.checked),
      bankName: (fd.bankName || "").trim(),
      accountName: (fd.bankAccountName || "Travel Sewa").trim() || "Travel Sewa",
      accountNumber: (fd.bankAccountNumber || "").trim(),
      branch: (fd.bankBranch || "").trim(),
    },
  });
  toast("Payments saved");
});

/** Staff changes own PIN */
$("#pin-change-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (isAdmin()) return toast("Use Admin account to change password");
  const fd = Object.fromEntries(new FormData(e.target).entries());
  try {
    if (getCurrentStaffId()) {
      const member = (await db.getStaff()).find((s) => s.id === getCurrentStaffId());
      if (!member || fd.current !== member.pin) {
        toast("Current PIN is wrong");
        return;
      }
      if (fd.next !== fd.confirm) {
        toast("New PINs do not match");
        return;
      }
      await assertUniqueStaffPin(fd.next, member.id);
      await db.updateStaff(member.id, { pin: fd.next });
    } else {
      if (fd.current !== getStaffPin()) {
        toast("Current PIN is wrong");
        return;
      }
      if (fd.next !== fd.confirm) {
        toast("New PINs do not match");
        return;
      }
      setStaffPin(fd.next);
    }
    e.target.reset();
    toast("PIN updated");
  } catch (err) {
    toast(err.message);
  }
});

$("#admin-password-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!isAdmin()) return toast("Admin only");
  const adminUser = getSavedAdminUser();
  if (adminUser?.provider === "google") {
    toast("Google accounts manage password in your Google account");
    return;
  }
  const fd = Object.fromEntries(new FormData(e.target).entries());
  try {
    await changePasswordLocal({
      current: fd.current,
      next: fd.next,
      confirm: fd.confirm,
    });
    e.target.reset();
    toast("Password updated");
  } catch (err) {
    toast(err.message || "Could not update password");
  }
});

$("#staff-pin-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!isAdmin()) return toast("Admin only");
  const fd = Object.fromEntries(new FormData(e.target).entries());
  if (fd.next !== fd.confirm) {
    toast("New PINs do not match");
    return;
  }
  try {
    setStaffPin(fd.next);
    e.target.reset();
    toast("User PIN updated");
  } catch (err) {
    toast(err.message);
  }
});

$("#btn-seed")?.addEventListener("click", async () => {
  if (!isAdmin()) return toast("Admin only");
  await seedDemo();
  await refreshCityOptions();
  renderFleet();
});

$("#btn-clear")?.addEventListener("click", async () => {
  if (!isAdmin()) return toast("Admin only");
  const ok = await confirmDialog({
    title: "Clear tickets",
    message: "Clear all tickets? This cannot be undone.",
    confirmLabel: "Clear all",
  });
  if (!ok) return;
  await db.clearTickets();
  toast("Tickets cleared");
  renderTickets();
});

/* ---------- Boot ---------- */

/** Restore workspace admin id after page refresh (session still unlocked). */
/** Remove leftover auto-demo fleet/staff once per workspace (from earlier auto-seed). */
async function purgeAutoDemoDataOnce() {
  const adminId = getWorkspaceAdminId();
  if (!adminId || !isSignedIn()) return;

  clearLocalAutoDemoData();

  const flag = `trip_tap_auto_demo_purged_${adminId}`;
  if (localStorage.getItem(flag)) return;

  try {
    const buses = await db.getBuses();
    for (const bus of buses) {
      if (isAutoDemoBus(bus)) {
        await db.deleteBus(bus.id);
      }
    }
    const staff = await db.getStaff();
    for (const member of staff) {
      if (isAutoDemoStaff(member)) {
        await db.deleteStaff(member.id);
      }
    }
    const routes = await db.getRoutes();
    for (const route of routes) {
      if (route.isDemo || isAutoDemoBus(route)) {
        await db.deleteRoute(route.id);
      }
    }
  } catch (err) {
    console.warn("[Travel Sewa] Demo purge skipped", err);
    return;
  }

  localStorage.setItem(flag, "1");
}

async function restoreWorkspaceSession() {
  if (getWorkspaceAdminId()) return true;
  const role = getCurrentRole();
  if (role === ROLES.admin) {
    const adminUser = getSavedAdminUser();
    if (!adminUser?.id) return false;
    setWorkspaceAdminId(adminUser.id);
    return true;
  }
  if (role === ROLES.staff) {
    const staffId = getCurrentStaffId();
    if (!staffId) return false;
    const staff = await db.getStaffByIdGlobal(staffId);
    if (!staff?.ownerAdminId) return false;
    setWorkspaceAdminId(staff.ownerAdminId);
    return true;
  }
  return role === ROLES.guest;
}

async function bootstrapApp(opts = {}) {
  await initFirebaseFromSavedConfig();
  const cloud = await tryEnableFirebase();
  if (cloud) console.info("[Travel Sewa] Using Firestore");
  clearLocalAutoDemoData();
  await purgeAutoDemoDataOnce();
  await migrateBusLayouts();
  await refreshCityOptions();
  await applyRoleUI();
  refreshSettings();
  if (!opts.preserveBooking) resetBookView();
  // Fleet preview only when Fleet page is open — not on Book front
  if ($("#view-fleet")?.classList.contains("active")) updateFleetSeatPreview();
}

async function migrateBusLayouts() {
  const buses = await db.getBuses();
  for (const bus of buses) {
    if (!bus.seatLayout?.seats?.length) {
      const layout = defaultSeatLayout({
        rows: Math.max(4, Math.ceil((bus.totalSeats || 32) / 4)),
        includeRear: false,
      });
      await db.updateBus(bus.id, {
        seatLayout: layout,
        totalSeats: layout.totalSeats,
        displayName: bus.displayName || bus.operator,
        amenities: bus.amenities?.length ? bus.amenities : ["Night", "Music System", "Fan"],
      });
    }
  }
}

setupPinInputs();
setAuthRole("admin");
setAuthMode(hasLocalAdminAccounts() ? "signin" : "signup");

(async () => {
  ensureDefaultFirebaseConfigSaved();
  await initFirebaseFromSavedConfig();
  const googleUser = await completeGoogleRedirectIfAny();
  if (googleUser) {
    await enterAsAdmin(googleUser);
    return;
  }
  if (isUnlocked()) {
    // Old admin PIN sessions without an account profile → force re-login
    if (getCurrentRole() === ROLES.admin && !getSavedAdminUser()) {
      lockSession();
      clearSavedAdminUser();
      showApp(false);
      return;
    }
    const ok = await restoreWorkspaceSession();
    if (!ok) {
      lockSession();
      clearSavedAdminUser();
      showApp(false);
      toast("Please sign in again");
      return;
    }
    showApp(true);
    await bootstrapApp();
  } else {
    showApp(false);
  }
})();

