/**
 * Storage adapter — localStorage + Firestore (cloud when Firebase is ready).
 * Multi-tenant: each admin has an isolated workspace (buses, routes, tickets, users, expenses).
 */

const KEYS = {
  tickets: "trip_tap_tickets",
  buses: "trip_tap_buses",
  routes: "trip_tap_routes",
  staff: "trip_tap_counter_staff",
  expenses: "trip_tap_expenses",
  pin: "trip_tap_pin", // legacy → migrates to adminPin
  adminPin: "trip_tap_admin_pin",
  staffPin: "trip_tap_staff_pin",
  session: "trip_tap_session",
  role: "trip_tap_role",
  staffId: "trip_tap_staff_id",
  workspaceAdminId: "trip_tap_workspace_admin_id",
  firebase: "trip_tap_firebase_config",
  seatLocks: "trip_tap_seat_locks",
};

const DEFAULT_ADMIN_PIN = "1234";
const DEFAULT_STAFF_PIN = "5678";

export const ROLES = {
  admin: "admin",
  staff: "staff",
  guest: "guest",
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function migrateLegacyPin() {
  if (!localStorage.getItem(KEYS.adminPin) && localStorage.getItem(KEYS.pin)) {
    localStorage.setItem(KEYS.adminPin, localStorage.getItem(KEYS.pin));
  }
}

/** Current admin workspace id (admin account id, or staff's ownerAdminId). */
export function getWorkspaceAdminId() {
  return sessionStorage.getItem(KEYS.workspaceAdminId) || null;
}

export function setWorkspaceAdminId(adminId) {
  if (adminId) sessionStorage.setItem(KEYS.workspaceAdminId, String(adminId));
  else sessionStorage.removeItem(KEYS.workspaceAdminId);
}

function ownedByWorkspace(item, adminId = getWorkspaceAdminId()) {
  if (!adminId) return false;
  return item?.ownerAdminId === adminId;
}

function filterOwned(list, adminId = getWorkspaceAdminId()) {
  if (!adminId) return [];
  return (list || []).filter((item) => ownedByWorkspace(item, adminId));
}

function withOwner(record, adminId = getWorkspaceAdminId()) {
  if (!adminId) throw new Error("Sign in as admin or user to save workspace data");
  return { ...record, ownerAdminId: record.ownerAdminId || adminId };
}

/**
 * Assign legacy records (no ownerAdminId) to this admin.
 * Disabled by default — auto-claim was attaching old demo fleet/staff to new logins.
 */
export function claimOrphanWorkspaceData(_adminId) {
  return false;
}

/** Detect auto-generated demo fleet records. */
export function isAutoDemoBus(bus) {
  if (!bus) return false;
  if (bus.isDemo) return true;
  const num = String(bus.busNumber || "").toUpperCase();
  const name = `${bus.displayName || ""} ${bus.operator || ""}`;
  return (
    (num === "TT-101" || num === "TT-202") &&
    /Travel Sewa (Express|Nightliner)/i.test(name)
  );
}

/** Detect auto-generated demo staff records. */
export function isAutoDemoStaff(staff) {
  if (!staff) return false;
  if (staff.isDemo) return true;
  if (String(staff.notes || "").includes("Demo counter staff")) return true;
  const name = String(staff.fullName || "");
  const pin = String(staff.pin || "");
  return (name === "Ram Thapa" && pin === "1111") || (name === "Sita Gurung" && pin === "2222");
}

/** Strip demo fleet/staff from localStorage so they cannot reappear offline. */
export function clearLocalAutoDemoData() {
  const buses = read(KEYS.buses, []);
  const demoBusIds = new Set(buses.filter(isAutoDemoBus).map((b) => b.id));
  write(
    KEYS.buses,
    buses.filter((b) => !demoBusIds.has(b.id))
  );
  write(
    KEYS.routes,
    read(KEYS.routes, []).filter(
      (r) => !demoBusIds.has(r.busId) && !isAutoDemoBus({ busNumber: r.busNumber, displayName: r.displayName, operator: r.operator })
    )
  );
  write(
    KEYS.staff,
    read(KEYS.staff, []).filter((s) => !isAutoDemoStaff(s))
  );
}

function seatLockKey(routeId, travelDate, adminId = getWorkspaceAdminId()) {
  return `${adminId || "_"}|${routeId}|${travelDate}`;
}

const localBackend = {
  mode: "local",

  async getTickets() {
    return filterOwned(read(KEYS.tickets, []));
  },
  async saveTicket(ticket) {
    const list = read(KEYS.tickets, []);
    list.unshift(withOwner(ticket));
    write(KEYS.tickets, list);
    return list[0];
  },
  async updateTicket(id, patch) {
    const list = read(KEYS.tickets, []);
    const i = list.findIndex((t) => t.id === id && ownedByWorkspace(t));
    if (i < 0) throw new Error("Ticket not found");
    list[i] = { ...list[i], ...patch, ownerAdminId: list[i].ownerAdminId, updatedAt: new Date().toISOString() };
    write(KEYS.tickets, list);
    return list[i];
  },
  async clearTickets() {
    const adminId = getWorkspaceAdminId();
    if (!adminId) {
      write(KEYS.tickets, []);
      return;
    }
    write(
      KEYS.tickets,
      read(KEYS.tickets, []).filter((t) => t.ownerAdminId !== adminId)
    );
  },

  async getBuses() {
    return filterOwned(read(KEYS.buses, []));
  },
  async saveBus(bus) {
    const list = read(KEYS.buses, []);
    const owned = withOwner(bus);
    list.push(owned);
    write(KEYS.buses, list);
    return owned;
  },

  async updateBus(id, patch) {
    const list = read(KEYS.buses, []);
    const i = list.findIndex((b) => b.id === id && ownedByWorkspace(b));
    if (i < 0) throw new Error("Bus not found");
    list[i] = { ...list[i], ...patch, ownerAdminId: list[i].ownerAdminId, updatedAt: new Date().toISOString() };
    write(KEYS.buses, list);
    return list[i];
  },

  async deleteBus(id) {
    const adminId = getWorkspaceAdminId();
    write(
      KEYS.buses,
      read(KEYS.buses, []).filter((b) => !(b.id === id && ownedByWorkspace(b, adminId)))
    );
    write(
      KEYS.routes,
      read(KEYS.routes, []).filter((r) => !(r.busId === id && ownedByWorkspace(r, adminId)))
    );
  },

  async getRoutes() {
    return filterOwned(read(KEYS.routes, []));
  },
  async saveRoute(route) {
    const list = read(KEYS.routes, []);
    const owned = withOwner(route);
    list.push(owned);
    write(KEYS.routes, list);
    return owned;
  },

  async deleteRoute(id) {
    const adminId = getWorkspaceAdminId();
    write(
      KEYS.routes,
      read(KEYS.routes, []).filter((r) => !(r.id === id && ownedByWorkspace(r, adminId)))
    );
  },

  async replaceRoutes(list) {
    const adminId = getWorkspaceAdminId();
    if (!adminId) {
      write(KEYS.routes, list);
      return;
    }
    const others = read(KEYS.routes, []).filter((r) => r.ownerAdminId !== adminId);
    const owned = (list || []).map((r) => withOwner(r, adminId));
    write(KEYS.routes, [...others, ...owned]);
  },

  async getStaff() {
    return filterOwned(read(KEYS.staff, []));
  },
  async saveStaff(member) {
    const list = read(KEYS.staff, []);
    const owned = withOwner(member);
    list.unshift(owned);
    write(KEYS.staff, list);
    return owned;
  },
  async updateStaff(id, patch) {
    // Staff login may update own record before workspace is set — allow by id globally for OTP verify
    const list = read(KEYS.staff, []);
    const i = list.findIndex((s) => s.id === id);
    if (i < 0) throw new Error("Staff not found");
    const adminId = getWorkspaceAdminId();
    if (adminId && list[i].ownerAdminId && list[i].ownerAdminId !== adminId) {
      throw new Error("Staff not found");
    }
    list[i] = { ...list[i], ...patch, ownerAdminId: list[i].ownerAdminId, updatedAt: new Date().toISOString() };
    write(KEYS.staff, list);
    return list[i];
  },
  async deleteStaff(id) {
    const adminId = getWorkspaceAdminId();
    write(
      KEYS.staff,
      read(KEYS.staff, []).filter((s) => !(s.id === id && ownedByWorkspace(s, adminId)))
    );
  },

  /** Lookup staff by id across all admins (for PIN login). */
  async getStaffByIdGlobal(id) {
    return read(KEYS.staff, []).find((s) => s.id === id) || null;
  },

  async getExpenses() {
    return filterOwned(read(KEYS.expenses, []));
  },
  async saveExpense(expense) {
    const list = read(KEYS.expenses, []);
    const owned = withOwner(expense);
    list.unshift(owned);
    write(KEYS.expenses, list);
    return owned;
  },
  async updateExpense(id, patch) {
    const list = read(KEYS.expenses, []);
    const i = list.findIndex((e) => e.id === id && ownedByWorkspace(e));
    if (i < 0) throw new Error("Expense not found");
    list[i] = { ...list[i], ...patch, ownerAdminId: list[i].ownerAdminId, updatedAt: new Date().toISOString() };
    write(KEYS.expenses, list);
    return list[i];
  },
  async deleteExpense(id) {
    const adminId = getWorkspaceAdminId();
    write(
      KEYS.expenses,
      read(KEYS.expenses, []).filter((e) => !(e.id === id && ownedByWorkspace(e, adminId)))
    );
  },

  async getTakenSeats(routeId, travelDate) {
    const locks = read(KEYS.seatLocks, {});
    return locks[seatLockKey(routeId, travelDate)] || [];
  },

  async lockSeats(routeId, travelDate, seats) {
    const locks = read(KEYS.seatLocks, {});
    const key = seatLockKey(routeId, travelDate);
    const existing = new Set(locks[key] || []);
    for (const s of seats) {
      if (existing.has(s)) throw new Error(`Seat ${s} is no longer available`);
      existing.add(s);
    }
    locks[key] = [...existing];
    write(KEYS.seatLocks, locks);
  },

  async releaseSeats(routeId, travelDate, seats) {
    const locks = read(KEYS.seatLocks, {});
    const key = seatLockKey(routeId, travelDate);
    const set = new Set(locks[key] || []);
    for (const s of seats) set.delete(s);
    locks[key] = [...set];
    write(KEYS.seatLocks, locks);
  },
};

/**
 * Strip undefined (Firestore rejects undefined field values).
 */
function sanitizeForFirestore(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeForFirestore(v)).filter((v) => v !== undefined);
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    const next = sanitizeForFirestore(v);
    if (next !== undefined) out[k] = next;
  }
  return out;
}

function lockDocId(routeId, travelDate, adminId = getWorkspaceAdminId()) {
  return `${adminId || "_"}__${routeId}__${travelDate}`.replace(/[\/\\]/g, "_");
}

const firebaseBackend = {
  mode: "firebase",
  _ready: false,
  _fs: null,
  _api: null,

  async init() {
    const { initFirebaseFromSavedConfig, getFirestoreDb, isFirebaseReady } = await import("./firebase.config.js");
    const started = await initFirebaseFromSavedConfig();
    if (!started || !isFirebaseReady()) {
      this._ready = false;
      throw new Error("Firestore not ready");
    }
    this._fs = getFirestoreDb();
    this._api = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");
    this._ready = true;
    return true;
  },

  col(name) {
    return this._api.collection(this._fs, name);
  },

  doc(name, id) {
    return this._api.doc(this._fs, name, id);
  },

  async queryByOwner(collectionName, adminId = getWorkspaceAdminId()) {
    if (!adminId) return [];
    const q = this._api.query(this.col(collectionName), this._api.where("ownerAdminId", "==", adminId));
    const snap = await this._api.getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },

  async setDocById(collectionName, record) {
    const owned = withOwner(record);
    const id = owned.id;
    if (!id) throw new Error("Missing document id");
    await this._api.setDoc(this.doc(collectionName, id), sanitizeForFirestore(owned), { merge: true });
    return owned;
  },

  async updateOwned(collectionName, id, patch) {
    const ref = this.doc(collectionName, id);
    const snap = await this._api.getDoc(ref);
    if (!snap.exists()) throw new Error("Not found");
    const current = { id: snap.id, ...snap.data() };
    if (!ownedByWorkspace(current)) throw new Error("Not found");
    const next = {
      ...current,
      ...patch,
      ownerAdminId: current.ownerAdminId,
      updatedAt: new Date().toISOString(),
    };
    await this._api.setDoc(ref, sanitizeForFirestore(next), { merge: true });
    return next;
  },

  async deleteOwned(collectionName, id) {
    const ref = this.doc(collectionName, id);
    const snap = await this._api.getDoc(ref);
    if (!snap.exists()) return;
    const current = { id: snap.id, ...snap.data() };
    if (!ownedByWorkspace(current)) return;
    await this._api.deleteDoc(ref);
  },

  async getTickets() {
    const list = await this.queryByOwner("tickets");
    return list.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  },
  async saveTicket(ticket) {
    return this.setDocById("tickets", ticket);
  },
  async updateTicket(id, patch) {
    return this.updateOwned("tickets", id, patch);
  },
  async clearTickets() {
    const list = await this.queryByOwner("tickets");
    const batchSize = 400;
    for (let i = 0; i < list.length; i += batchSize) {
      const batch = this._api.writeBatch(this._fs);
      for (const t of list.slice(i, i + batchSize)) {
        batch.delete(this.doc("tickets", t.id));
      }
      await batch.commit();
    }
  },

  async getBuses() {
    return this.queryByOwner("buses");
  },
  async saveBus(bus) {
    return this.setDocById("buses", bus);
  },
  async updateBus(id, patch) {
    return this.updateOwned("buses", id, patch);
  },
  async deleteBus(id) {
    await this.deleteOwned("buses", id);
    const routes = await this.queryByOwner("routes");
    const doomed = routes.filter((r) => r.busId === id);
    const batchSize = 400;
    for (let i = 0; i < doomed.length; i += batchSize) {
      const batch = this._api.writeBatch(this._fs);
      for (const r of doomed.slice(i, i + batchSize)) {
        batch.delete(this.doc("routes", r.id));
      }
      await batch.commit();
    }
  },

  async getRoutes() {
    return this.queryByOwner("routes");
  },
  async saveRoute(route) {
    return this.setDocById("routes", route);
  },
  async deleteRoute(id) {
    await this.deleteOwned("routes", id);
  },
  async replaceRoutes(list) {
    const adminId = getWorkspaceAdminId();
    if (!adminId) throw new Error("Sign in as admin or user to save workspace data");
    const existing = await this.queryByOwner("routes", adminId);
    const batchSize = 400;
    for (let i = 0; i < existing.length; i += batchSize) {
      const batch = this._api.writeBatch(this._fs);
      for (const r of existing.slice(i, i + batchSize)) {
        batch.delete(this.doc("routes", r.id));
      }
      await batch.commit();
    }
    const owned = (list || []).map((r) => withOwner(r, adminId));
    for (let i = 0; i < owned.length; i += batchSize) {
      const batch = this._api.writeBatch(this._fs);
      for (const r of owned.slice(i, i + batchSize)) {
        batch.set(this.doc("routes", r.id), sanitizeForFirestore(r), { merge: true });
      }
      await batch.commit();
    }
  },

  async getStaff() {
    const list = await this.queryByOwner("staff");
    return list.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  },
  async saveStaff(member) {
    return this.setDocById("staff", member);
  },
  async updateStaff(id, patch) {
    const ref = this.doc("staff", id);
    const snap = await this._api.getDoc(ref);
    if (!snap.exists()) throw new Error("Staff not found");
    const current = { id: snap.id, ...snap.data() };
    const adminId = getWorkspaceAdminId();
    if (adminId && current.ownerAdminId && current.ownerAdminId !== adminId) {
      throw new Error("Staff not found");
    }
    const next = {
      ...current,
      ...patch,
      ownerAdminId: current.ownerAdminId,
      updatedAt: new Date().toISOString(),
    };
    await this._api.setDoc(ref, sanitizeForFirestore(next), { merge: true });
    return next;
  },
  async deleteStaff(id) {
    await this.deleteOwned("staff", id);
  },
  async getStaffByIdGlobal(id) {
    const snap = await this._api.getDoc(this.doc("staff", id));
    if (!snap.exists()) return null;
    return { id: snap.id, ...snap.data() };
  },
  async findStaffByPin(pin, { activeOnly = true } = {}) {
    const q = this._api.query(this.col("staff"), this._api.where("pin", "==", String(pin)));
    const snap = await this._api.getDocs(q);
    const members = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!activeOnly) return members[0] || null;
    return members.find((s) => s.status === "active") || null;
  },

  async getExpenses() {
    const list = await this.queryByOwner("expenses");
    return list.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  },
  async saveExpense(expense) {
    return this.setDocById("expenses", expense);
  },
  async updateExpense(id, patch) {
    return this.updateOwned("expenses", id, patch);
  },
  async deleteExpense(id) {
    await this.deleteOwned("expenses", id);
  },

  async getTakenSeats(routeId, travelDate) {
    const id = lockDocId(routeId, travelDate);
    const snap = await this._api.getDoc(this.doc("seatLocks", id));
    if (!snap.exists()) return [];
    return snap.data().seats || [];
  },

  async lockSeats(routeId, travelDate, seats) {
    const adminId = getWorkspaceAdminId();
    if (!adminId) throw new Error("Sign in as admin or user to save workspace data");
    const id = lockDocId(routeId, travelDate, adminId);
    const ref = this.doc("seatLocks", id);
    const snap = await this._api.getDoc(ref);
    const existing = new Set(snap.exists() ? snap.data().seats || [] : []);
    for (const s of seats) {
      if (existing.has(s)) throw new Error(`Seat ${s} is no longer available`);
      existing.add(s);
    }
    await this._api.setDoc(
      ref,
      sanitizeForFirestore({
        id,
        ownerAdminId: adminId,
        routeId,
        travelDate,
        seats: [...existing],
        updatedAt: new Date().toISOString(),
      }),
      { merge: true }
    );
  },

  async releaseSeats(routeId, travelDate, seats) {
    const adminId = getWorkspaceAdminId();
    const id = lockDocId(routeId, travelDate, adminId);
    const ref = this.doc("seatLocks", id);
    const snap = await this._api.getDoc(ref);
    if (!snap.exists()) return;
    const set = new Set(snap.data().seats || []);
    for (const s of seats) set.delete(s);
    await this._api.setDoc(
      ref,
      sanitizeForFirestore({
        ...snap.data(),
        id,
        seats: [...set],
        updatedAt: new Date().toISOString(),
      }),
      { merge: true }
    );
  },

  /** Upload localStorage workspace data into Firestore (merge by id). */
  async migrateLocalData() {
    const collections = [
      [KEYS.tickets, "tickets"],
      [KEYS.buses, "buses"],
      [KEYS.routes, "routes"],
      [KEYS.staff, "staff"],
      [KEYS.expenses, "expenses"],
    ];
    for (const [localKey, remote] of collections) {
      const list = read(localKey, []);
      for (let i = 0; i < list.length; i += 400) {
        const chunk = list.slice(i, i + 400);
        const batch = this._api.writeBatch(this._fs);
        for (const item of chunk) {
          if (!item?.id) continue;
          batch.set(this.doc(remote, item.id), sanitizeForFirestore(item), { merge: true });
        }
        await batch.commit();
      }
    }
    const locks = read(KEYS.seatLocks, {});
    const entries = Object.entries(locks);
    for (let i = 0; i < entries.length; i += 400) {
      const chunk = entries.slice(i, i + 400);
      const batch = this._api.writeBatch(this._fs);
      for (const [key, seats] of chunk) {
        const [adminId, routeId, travelDate] = String(key).split("|");
        if (!routeId || !travelDate) continue;
        const id = lockDocId(routeId, travelDate, adminId);
        batch.set(
          this.doc("seatLocks", id),
          sanitizeForFirestore({
            id,
            ownerAdminId: adminId === "_" ? null : adminId,
            routeId,
            travelDate,
            seats: seats || [],
            updatedAt: new Date().toISOString(),
          }),
          { merge: true }
        );
      }
      await batch.commit();
    }
  },
};

let backend = localBackend;

export function getStorageMode() {
  return backend.mode;
}

export function getFirebaseConfig() {
  return read(KEYS.firebase, null);
}

export function saveFirebaseConfig(config) {
  write(KEYS.firebase, {
    apiKey: config.apiKey?.trim() || "",
    authDomain: config.authDomain?.trim() || "",
    projectId: config.projectId?.trim() || "",
    storageBucket: config.storageBucket?.trim() || "",
    appId: config.appId?.trim() || "",
  });
}

export async function tryEnableFirebase() {
  const cfg = getFirebaseConfig();
  if (!cfg?.apiKey || !cfg?.projectId) return false;
  try {
    await firebaseBackend.init();
    backend = firebaseBackend;
    // Do not auto-upload localStorage (old demo data was reappearing via this path).
    console.info("[Travel Sewa] Firestore storage enabled");
    return true;
  } catch (err) {
    console.warn("[Travel Sewa] Firestore unavailable — using local storage", err);
    backend = localBackend;
    return false;
  }
}

export const db = {
  getTickets: (...a) => backend.getTickets(...a),
  saveTicket: (...a) => backend.saveTicket(...a),
  updateTicket: (...a) => backend.updateTicket(...a),
  clearTickets: (...a) => backend.clearTickets(...a),
  getBuses: (...a) => backend.getBuses(...a),
  saveBus: (...a) => backend.saveBus(...a),
  updateBus: (...a) => backend.updateBus(...a),
  deleteBus: (...a) => backend.deleteBus(...a),
  getRoutes: (...a) => backend.getRoutes(...a),
  saveRoute: (...a) => backend.saveRoute(...a),
  deleteRoute: (...a) => backend.deleteRoute(...a),
  replaceRoutes: (...a) => backend.replaceRoutes(...a),
  getStaff: (...a) => backend.getStaff(...a),
  saveStaff: (...a) => backend.saveStaff(...a),
  updateStaff: (...a) => backend.updateStaff(...a),
  deleteStaff: (...a) => backend.deleteStaff(...a),
  getStaffByIdGlobal: (...a) => backend.getStaffByIdGlobal(...a),
  getExpenses: (...a) => backend.getExpenses(...a),
  saveExpense: (...a) => backend.saveExpense(...a),
  updateExpense: (...a) => backend.updateExpense(...a),
  deleteExpense: (...a) => backend.deleteExpense(...a),
  getTakenSeats: (...a) => backend.getTakenSeats(...a),
  lockSeats: (...a) => backend.lockSeats(...a),
  releaseSeats: (...a) => backend.releaseSeats(...a),
};

migrateLegacyPin();

export function getAdminPin() {
  migrateLegacyPin();
  return localStorage.getItem(KEYS.adminPin) || DEFAULT_ADMIN_PIN;
}

export function getStaffPin() {
  return localStorage.getItem(KEYS.staffPin) || DEFAULT_STAFF_PIN;
}

/** @deprecated use getAdminPin */
export function getPin() {
  return getAdminPin();
}

export function setAdminPin(pin) {
  if (!/^\d{4}$/.test(pin)) throw new Error("PIN must be 4 digits");
  if (pin === getStaffPin()) throw new Error("Admin PIN cannot match staff PIN");
  localStorage.setItem(KEYS.adminPin, pin);
  localStorage.setItem(KEYS.pin, pin);
}

export function setStaffPin(pin) {
  if (!/^\d{4}$/.test(pin)) throw new Error("PIN must be 4 digits");
  if (pin === getAdminPin()) throw new Error("Staff PIN cannot match admin PIN");
  localStorage.setItem(KEYS.staffPin, pin);
}

/** @deprecated use setAdminPin */
export function setPin(pin) {
  setAdminPin(pin);
}

/**
 * Resolve staff login from PIN (admin uses username/password — not PIN).
 * Searches all workspaces so each user PIN logs into their admin's data.
 * @returns {Promise<{ role: "admin"|"staff", staffId: string|null, staff: object|null }|null>}
 */
export async function resolveLoginFromPin(pin) {
  if (backend.findStaffByPin) {
    try {
      const member = await backend.findStaffByPin(pin);
      if (member) {
        return { role: ROLES.staff, staffId: member.id, staff: member };
      }
    } catch (err) {
      console.warn("[Travel Sewa] Staff PIN lookup failed", err);
    }
  } else {
    const staffList = read(KEYS.staff, []);
    const member = staffList.find((s) => s.status === "active" && s.pin === pin);
    if (member) {
      return { role: ROLES.staff, staffId: member.id, staff: member };
    }
  }

  // Legacy shared staff PIN (no counter profile) — no workspace isolation
  if (pin === getStaffPin()) {
    return { role: ROLES.staff, staffId: null, staff: null };
  }
  return null;
}

/** @deprecated prefer resolveLoginFromPin */
export async function resolveRoleFromPin(pin) {
  return (await resolveLoginFromPin(pin))?.role ?? null;
}

export async function verifyPin(pin) {
  return (await resolveLoginFromPin(pin)) !== null;
}

export function isUnlocked() {
  return sessionStorage.getItem(KEYS.session) === "1" && !!getCurrentRole();
}

export function getCurrentRole() {
  return sessionStorage.getItem(KEYS.role);
}

export function getCurrentStaffId() {
  return sessionStorage.getItem(KEYS.staffId) || null;
}

export function isAdmin() {
  return getCurrentRole() === ROLES.admin;
}

export function isGuest() {
  return getCurrentRole() === ROLES.guest;
}

/** Admin or staff (can confirm bookings and use workspace tools). */
export function isSignedIn() {
  const role = getCurrentRole();
  return role === ROLES.admin || role === ROLES.staff;
}

export function unlockSession(role, staffId = null, workspaceAdminId = null) {
  sessionStorage.setItem(KEYS.session, "1");
  sessionStorage.setItem(KEYS.role, role);
  if (staffId) sessionStorage.setItem(KEYS.staffId, staffId);
  else sessionStorage.removeItem(KEYS.staffId);
  if (workspaceAdminId) setWorkspaceAdminId(workspaceAdminId);
  else if (role === ROLES.guest) setWorkspaceAdminId(null);
}

export function lockSession() {
  sessionStorage.removeItem(KEYS.session);
  sessionStorage.removeItem(KEYS.role);
  sessionStorage.removeItem(KEYS.staffId);
  sessionStorage.removeItem(KEYS.workspaceAdminId);
  sessionStorage.removeItem("trip_tap_admin_user");
}

/** Ensure PIN is unique across all users (so PIN login is unambiguous). */
export async function assertUniqueStaffPin(pin, excludeId = null) {
  if (!/^\d{4}$/.test(pin)) throw new Error("PIN must be 4 digits");
  if (pin === getAdminPin()) throw new Error("PIN is reserved for admin");
  if (pin === getStaffPin()) throw new Error("PIN matches legacy shared staff PIN — choose another");
  if (backend.findStaffByPin) {
    const member = await backend.findStaffByPin(pin, { activeOnly: false });
    if (member && member.id !== excludeId) {
      throw new Error("This PIN is already assigned to another user");
    }
    return;
  }
  const taken = read(KEYS.staff, []).some((s) => s.pin === pin && s.id !== excludeId);
  if (taken) throw new Error("This PIN is already assigned to another user");
}

export { DEFAULT_ADMIN_PIN, DEFAULT_STAFF_PIN, DEFAULT_ADMIN_PIN as DEFAULT_PIN, KEYS };
