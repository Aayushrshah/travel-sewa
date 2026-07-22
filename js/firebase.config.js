/**
 * Firebase web SDK bootstrap (Auth + Firestore).
 * Uses Travel Sewa project defaults; Settings can override.
 */

import { getFirebaseConfig, saveFirebaseConfig } from "./storage.js";

const FIREBASE_APP = "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
const FIREBASE_AUTH = "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
const FIREBASE_FIRESTORE = "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/** Built-in Travel Sewa Firebase web app config */
export const DEFAULT_FIREBASE_CONFIG = {
  apiKey: "AIzaSyDqTXBNRQhd_Oo1TPohbHcWfQighCIKSAQ",
  authDomain: "travel-sewa.firebaseapp.com",
  projectId: "travel-sewa",
  storageBucket: "travel-sewa.firebasestorage.app",
  messagingSenderId: "676570706478",
  appId: "1:676570706478:web:5640cd17429897d55525bf",
  measurementId: "G-9RD7HMK9QM",
};

export const firebaseConfigPlaceholder = { ...DEFAULT_FIREBASE_CONFIG };

let app = null;
let auth = null;
let db = null;
let ready = false;

export function isFirebaseReady() {
  return ready && !!auth && !!db;
}

export function getFirebaseAuth() {
  return auth;
}

export function getFirebaseApp() {
  return app;
}

export function getFirestoreDb() {
  return db;
}

/** Saved Settings config, or Travel Sewa defaults */
export function resolveFirebaseConfig() {
  const saved = getFirebaseConfig();
  if (saved?.apiKey && saved?.projectId && saved?.appId) {
    return {
      ...DEFAULT_FIREBASE_CONFIG,
      ...saved,
    };
  }
  return { ...DEFAULT_FIREBASE_CONFIG };
}

/** Persist defaults once so Settings shows the live project */
export function ensureDefaultFirebaseConfigSaved() {
  const saved = getFirebaseConfig();
  if (saved?.apiKey && saved?.projectId && saved?.appId) return saved;
  saveFirebaseConfig(DEFAULT_FIREBASE_CONFIG);
  return DEFAULT_FIREBASE_CONFIG;
}

export async function initFirebaseFromSavedConfig() {
  ensureDefaultFirebaseConfigSaved();
  const cfg = resolveFirebaseConfig();
  if (!cfg?.apiKey || !cfg?.projectId || !cfg?.appId) {
    ready = false;
    auth = null;
    db = null;
    app = null;
    return null;
  }
  return initFirebase(cfg);
}

export async function initFirebase(config) {
  if (!config?.apiKey || !config?.projectId) return null;
  try {
    const { initializeApp, getApps } = await import(FIREBASE_APP);
    const { getAuth } = await import(FIREBASE_AUTH);
    const { getFirestore } = await import(FIREBASE_FIRESTORE);
    const existing = getApps();
    app = existing.length ? existing[0] : initializeApp(config);
    auth = getAuth(app);
    db = getFirestore(app);
    ready = true;
    return { app, auth, db };
  } catch (err) {
    console.warn("Firebase init failed", err);
    ready = false;
    auth = null;
    db = null;
    app = null;
    return null;
  }
}
