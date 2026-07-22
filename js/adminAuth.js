/**
 * Admin authentication — email/username + password, Google, forgot password.
 * Uses Firebase Auth when configured; otherwise localStorage accounts.
 */

import {
  isFirebaseReady,
  getFirebaseAuth,
  initFirebaseFromSavedConfig,
  resolveFirebaseConfig,
  ensureDefaultFirebaseConfigSaved,
} from "./firebase.config.js";

const ACCOUNTS_KEY = "trip_tap_admin_accounts";
const SESSION_ADMIN_KEY = "trip_tap_admin_user";

function readAccounts() {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeAccounts(list) {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list));
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, salt) {
  return sha256(`${salt}:${password}`);
}

function normalizeUsername(u) {
  return String(u || "")
    .trim()
    .toLowerCase();
}

function normalizeEmail(e) {
  return String(e || "")
    .trim()
    .toLowerCase();
}

function validateSignup({ username, email, password, confirm }) {
  const u = String(username || "").trim();
  const em = normalizeEmail(email);
  const pw = String(password || "");
  const conf = String(confirm || "");
  if (!u) throw new Error("Username is required");
  if (u.length < 3) throw new Error("Username must be at least 3 characters");
  if (!/^[a-zA-Z0-9._-]+$/.test(u)) throw new Error("Username: letters, numbers, . _ - only");
  if (!em) throw new Error("Email is required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) throw new Error("Enter a valid email");
  if (!pw) throw new Error("Password is required");
  if (pw.length < 6) throw new Error("Password must be at least 6 characters");
  if (pw !== conf) throw new Error("Passwords do not match");
  return { username: u, email: em, password: pw };
}

export function getSavedAdminUser() {
  try {
    const raw = sessionStorage.getItem(SESSION_ADMIN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setSavedAdminUser(user) {
  if (user) sessionStorage.setItem(SESSION_ADMIN_KEY, JSON.stringify(user));
  else sessionStorage.removeItem(SESSION_ADMIN_KEY);
}

export function clearSavedAdminUser() {
  sessionStorage.removeItem(SESSION_ADMIN_KEY);
}

export function hasLocalAdminAccounts() {
  return readAccounts().length > 0;
}

export function isFirebaseAuthConfigured() {
  ensureDefaultFirebaseConfigSaved();
  const cfg = resolveFirebaseConfig();
  return !!(cfg?.apiKey && cfg?.authDomain && cfg?.projectId && cfg?.appId);
}

async function ensureFirebaseAuth() {
  if (!isFirebaseAuthConfigured()) return null;
  await initFirebaseFromSavedConfig();
  if (!isFirebaseReady()) return null;
  return getFirebaseAuth();
}

function toSessionUser(account, provider = "password") {
  return {
    id: account.id || account.uid || account.email,
    username: account.username || account.displayName || account.email?.split("@")[0] || "Admin",
    email: account.email || "",
    provider,
  };
}

/** Local signup */
export async function signupLocal({ username, email, password, confirm }) {
  const data = validateSignup({ username, email, password, confirm });
  const accounts = readAccounts();
  if (accounts.some((a) => normalizeUsername(a.username) === normalizeUsername(data.username))) {
    throw new Error("Username already taken");
  }
  if (accounts.some((a) => normalizeEmail(a.email) === data.email)) {
    throw new Error("Email already registered");
  }
  const salt = crypto.randomUUID();
  const passwordHash = await hashPassword(data.password, salt);
  const account = {
    id: `adm_${Date.now().toString(36)}`,
    username: data.username,
    email: data.email,
    salt,
    passwordHash,
    createdAt: new Date().toISOString(),
  };
  accounts.push(account);
  writeAccounts(accounts);
  const user = toSessionUser(account, "local");
  setSavedAdminUser(user);
  return user;
}

/** Local sign-in with username or email */
export async function signinLocal({ identifier, password }) {
  const id = String(identifier || "").trim();
  const pw = String(password || "");
  if (!id) throw new Error("Username or email is required");
  if (!pw) throw new Error("Password is required");
  const accounts = readAccounts();
  const key = id.includes("@") ? normalizeEmail(id) : normalizeUsername(id);
  const account = accounts.find(
    (a) =>
      normalizeUsername(a.username) === key || normalizeEmail(a.email) === normalizeEmail(id)
  );
  if (!account) throw new Error("Account not found");
  const hash = await hashPassword(pw, account.salt);
  if (hash !== account.passwordHash) throw new Error("Incorrect password");
  const user = toSessionUser(account, "local");
  setSavedAdminUser(user);
  return user;
}

/** Local password reset when email matches (offline mode) */
export async function resetPasswordLocal({ email, password, confirm }) {
  const em = normalizeEmail(email);
  const pw = String(password || "");
  const conf = String(confirm || "");
  if (!em) throw new Error("Email is required");
  if (!pw) throw new Error("New password is required");
  if (pw.length < 6) throw new Error("Password must be at least 6 characters");
  if (pw !== conf) throw new Error("Passwords do not match");
  const accounts = readAccounts();
  const idx = accounts.findIndex((a) => normalizeEmail(a.email) === em);
  if (idx < 0) throw new Error("No account with that email");
  const salt = crypto.randomUUID();
  accounts[idx] = {
    ...accounts[idx],
    salt,
    passwordHash: await hashPassword(pw, salt),
    updatedAt: new Date().toISOString(),
  };
  writeAccounts(accounts);
  return true;
}

export async function changePasswordLocal({ current, next, confirm }) {
  const user = getSavedAdminUser();
  if (!user?.email && !user?.username) throw new Error("Not signed in");
  if (!current) throw new Error("Current password is required");
  if (!next || next.length < 6) throw new Error("New password must be at least 6 characters");
  if (next !== confirm) throw new Error("Passwords do not match");
  const accounts = readAccounts();
  const idx = accounts.findIndex(
    (a) =>
      normalizeEmail(a.email) === normalizeEmail(user.email) ||
      normalizeUsername(a.username) === normalizeUsername(user.username)
  );
  if (idx < 0) throw new Error("Account not found");
  const hash = await hashPassword(current, accounts[idx].salt);
  if (hash !== accounts[idx].passwordHash) throw new Error("Current password is wrong");
  const salt = crypto.randomUUID();
  accounts[idx] = {
    ...accounts[idx],
    salt,
    passwordHash: await hashPassword(next, salt),
    updatedAt: new Date().toISOString(),
  };
  writeAccounts(accounts);
  return true;
}

/** Firebase email/password signup */
export async function signupFirebase({ username, email, password, confirm }) {
  const data = validateSignup({ username, email, password, confirm });
  const auth = await ensureFirebaseAuth();
  if (!auth) throw new Error("Save Firebase config in Settings first (API key, Auth domain, Project ID, App ID)");
  try {
    const { createUserWithEmailAndPassword, updateProfile } = await import(
      "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js"
    );
    const cred = await createUserWithEmailAndPassword(auth, data.email, data.password);
    await updateProfile(cred.user, { displayName: data.username });
    try {
      await signupLocal({ ...data, confirm: data.password });
    } catch {
      /* local mirror optional */
    }
    const user = toSessionUser(
      { id: cred.user.uid, username: data.username, email: data.email },
      "firebase"
    );
    setSavedAdminUser(user);
    return user;
  } catch (err) {
    throw mapFirebaseError(err);
  }
}

export async function signinFirebase({ identifier, password }) {
  const id = String(identifier || "").trim();
  const pw = String(password || "");
  if (!id) throw new Error("Username or email is required");
  if (!pw) throw new Error("Password is required");
  const auth = await ensureFirebaseAuth();
  if (!auth) throw new Error("Save Firebase config in Settings first");
  let email = id;
  if (!id.includes("@")) {
    const accounts = readAccounts();
    const match = accounts.find((a) => normalizeUsername(a.username) === normalizeUsername(id));
    if (!match) throw new Error("Username not found — use email or sign up first");
    email = match.email;
  }
  try {
    const { signInWithEmailAndPassword } = await import(
      "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js"
    );
    const cred = await signInWithEmailAndPassword(auth, email, pw);
    const user = toSessionUser(
      {
        id: cred.user.uid,
        username: cred.user.displayName || email.split("@")[0],
        email: cred.user.email,
      },
      "firebase"
    );
    setSavedAdminUser(user);
    return user;
  } catch (err) {
    throw mapFirebaseError(err);
  }
}

export async function forgotPasswordFirebase(email) {
  const em = normalizeEmail(email);
  if (!em) throw new Error("Email is required");
  const auth = await ensureFirebaseAuth();
  if (!auth) throw new Error("Firebase is required for reset email. Use local reset below, or save Firebase config.");
  try {
    const { sendPasswordResetEmail } = await import(
      "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js"
    );
    await sendPasswordResetEmail(auth, em);
    return true;
  } catch (err) {
    throw mapFirebaseError(err);
  }
}

export async function signInWithGoogle() {
  const auth = await ensureFirebaseAuth();
  if (!auth) {
    throw new Error(
      "Google sign-in needs Firebase. Open Settings → Firebase, or wait for Travel Sewa config to load."
    );
  }
  try {
    const { GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult } = await import(
      "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js"
    );

    // Finish redirect flow if returning from Google
    const redirected = await getRedirectResult(auth);
    if (redirected?.user) {
      const user = toSessionUser(
        {
          id: redirected.user.uid,
          username: redirected.user.displayName || redirected.user.email?.split("@")[0] || "Admin",
          email: redirected.user.email,
        },
        "google"
      );
      setSavedAdminUser(user);
      return user;
    }

    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    provider.addScope("email");
    provider.addScope("profile");

    let cred;
    try {
      cred = await signInWithPopup(auth, provider);
    } catch (popupErr) {
      const code = popupErr?.code || "";
      // Popup blocked / unsupported → redirect
      if (
        code === "auth/popup-blocked" ||
        code === "auth/popup-closed-by-user" ||
        code === "auth/cancelled-popup-request"
      ) {
        if (code === "auth/popup-closed-by-user") throw mapFirebaseError(popupErr);
        await signInWithRedirect(auth, provider);
        return null; // page will navigate away
      }
      throw popupErr;
    }

    const user = toSessionUser(
      {
        id: cred.user.uid,
        username: cred.user.displayName || cred.user.email?.split("@")[0] || "Admin",
        email: cred.user.email,
      },
      "google"
    );
    setSavedAdminUser(user);
    return user;
  } catch (err) {
    throw mapFirebaseError(err);
  }
}

/** Call on boot to complete Google redirect sign-in */
export async function completeGoogleRedirectIfAny() {
  if (!isFirebaseAuthConfigured()) return null;
  const auth = await ensureFirebaseAuth();
  if (!auth) return null;
  try {
    const { getRedirectResult } = await import(
      "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js"
    );
    const redirected = await getRedirectResult(auth);
    if (!redirected?.user) return null;
    const user = toSessionUser(
      {
        id: redirected.user.uid,
        username: redirected.user.displayName || redirected.user.email?.split("@")[0] || "Admin",
        email: redirected.user.email,
      },
      "google"
    );
    setSavedAdminUser(user);
    return user;
  } catch (err) {
    console.warn("Google redirect result", err);
    return null;
  }
}

/** Prefer Firebase when configured; otherwise local */
export async function adminSignup(payload) {
  if (isFirebaseAuthConfigured()) {
    try {
      return await signupFirebase(payload);
    } catch (err) {
      // Fall back to local if Firebase not reachable / Auth not enabled
      if (/Firebase|network|auth\/|configuration/i.test(String(err.message || err))) {
        return signupLocal(payload);
      }
      throw err;
    }
  }
  return signupLocal(payload);
}

export async function adminSignin(payload) {
  if (isFirebaseAuthConfigured()) {
    try {
      return await signinFirebase(payload);
    } catch (err) {
      // Try local account as fallback
      try {
        return await signinLocal(payload);
      } catch {
        throw err.code ? mapFirebaseError(err) : err;
      }
    }
  }
  return signinLocal(payload);
}

export async function adminForgotPassword({ email, password, confirm, mode }) {
  // mode: "email" = send Firebase reset; "local" = set new password locally
  if (mode === "email" || (isFirebaseAuthConfigured() && !password)) {
    await forgotPasswordFirebase(email);
    return { method: "email" };
  }
  await resetPasswordLocal({ email, password, confirm });
  return { method: "local" };
}

function mapFirebaseError(err) {
  const code = err.code || "";
  const raw = String(err.message || "");
  const map = {
    "auth/email-already-in-use": "Email already registered",
    "auth/invalid-email": "Invalid email",
    "auth/weak-password": "Password is too weak (min 6 characters)",
    "auth/user-not-found": "Account not found",
    "auth/wrong-password": "Incorrect password",
    "auth/invalid-credential": "Incorrect email or password",
    "auth/popup-closed-by-user": "Google sign-in was cancelled",
    "auth/unauthorized-domain": "Add this domain in Firebase Auth → Settings → Authorized domains",
    "auth/operation-not-allowed":
      "Google sign-in is not enabled yet. In Firebase Console → Authentication → Sign-in method, enable Google.",
    "auth/configuration-not-found":
      "Firebase Authentication is not set up. Open Firebase Console → Authentication → Get started, then enable Google.",
  };
  if (/CONFIGURATION_NOT_FOUND/i.test(raw)) {
    return new Error(map["auth/configuration-not-found"]);
  }
  return new Error(map[code] || err.message || "Authentication failed");
}
