/** Advanced domain models for Travel Sewa */

export function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function bookingRef() {
  const n = Math.floor(100000 + Math.random() * 900000);
  return `TS-${n}`;
}

/**
 * Full ticket / booking document (advanced model).
 */
export function createTicket({ passenger, trip, pricing, luggage, notes = "" }) {
  const now = new Date().toISOString();
  return {
    id: uid("ticket"),
    bookingRef: bookingRef(),
    status: "confirmed",
    passenger: {
      fullName: passenger.fullName.trim(),
      phone: passenger.phone.trim(),
      email: (passenger.email || "").trim(),
      age: Number(passenger.age),
      gender: passenger.gender,
      idType: passenger.idType,
      idNumber: passenger.idNumber.trim(),
      pickupAddress: (passenger.pickupAddress || "").trim(),
    },
    trip: {
      routeId: trip.routeId,
      busId: trip.busId,
      busNumber: trip.busNumber,
      operator: trip.operator,
      busType: trip.busType,
      from: trip.from,
      to: trip.to,
      travelDate: trip.travelDate,
      departureTime: trip.departureTime,
      arrivalTime: trip.arrivalTime,
      seatNumbers: [...trip.seatNumbers],
    },
    luggage: {
      pieces: Number(luggage?.pieces ?? 0),
      weightKg: Number(luggage?.weightKg ?? 0),
      description: (luggage?.description || "").trim(),
    },
    pricing: {
      baseFare: Number(pricing.baseFare),
      seatCount: Number(pricing.seatCount),
      subtotal: Number(pricing.subtotal),
      tax: Number(pricing.tax),
      discount: Number(pricing.discount || 0),
      total: Number(pricing.total),
      currency: pricing.currency || "NPR",
      depositAmount: Number(pricing.depositAmount || 0),
      dueAmount: Number(pricing.dueAmount || 0),
      paymentStatus: pricing.paymentStatus || "due",
      paymentMethod: pricing.paymentMethod || "counter",
    },
    notes: (notes || "").trim(),
    createdAt: now,
    updatedAt: now,
    schemaVersion: 2,
  };
}

export function createBus({
  busNumber,
  operator,
  busType,
  totalSeats,
  seatLayout,
  amenities,
  displayName,
}) {
  const now = new Date().toISOString();
  const layout =
    seatLayout ||
    defaultSeatLayoutInline({
      rows: Math.max(4, Math.ceil(Number(totalSeats || 32) / 4)),
      includeRear: Number(totalSeats) % 4 === 1,
    });
  return {
    id: uid("bus"),
    busNumber: busNumber.trim().toUpperCase(),
    displayName: (displayName || operator || busNumber).trim(),
    operator: operator.trim(),
    busType,
    totalSeats: layout.totalSeats,
    seatLayout: layout,
    amenities: amenities?.length ? amenities : ["Night", "Music System", "Fan", "Comfortable Seats"],
    active: true,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 2,
  };
}

function defaultSeatLayoutInline({ rows = 8, includeRear = true } = {}) {
  const seats = [];
  for (let r = 1; r <= rows; r++) {
    const ids = [`A${r * 2 - 1}`, `A${r * 2}`, `B${r * 2 - 1}`, `B${r * 2}`];
    seats.push(
      { id: ids[0], label: ids[0], row: r, side: "left", col: 0 },
      { id: ids[1], label: ids[1], row: r, side: "left", col: 1 },
      { id: ids[2], label: ids[2], row: r, side: "right", col: 0 },
      { id: ids[3], label: ids[3], row: r, side: "right", col: 1 }
    );
  }
  if (includeRear) seats.push({ id: "R", label: "R", row: rows + 1, side: "rear", col: 0 });
  return { type: "2x2", rows, includeRear: Boolean(includeRear), seats, totalSeats: seats.length };
}

export function createRoute({
  busId,
  busNumber,
  operator,
  busType,
  from,
  to,
  departureTime,
  arrivalTime,
  baseFare,
  totalSeats,
  seatLayout,
  amenities,
  displayName,
  boardingPoints,
  droppingPoints,
}) {
  const now = new Date().toISOString();
  return {
    id: uid("route"),
    busId,
    busNumber,
    displayName: displayName || operator,
    operator,
    busType,
    from: from.trim(),
    to: to.trim(),
    departureTime,
    arrivalTime,
    baseFare: Number(baseFare),
    totalSeats: Number(totalSeats),
    seatLayout: seatLayout || null,
    amenities: amenities || [],
    boardingPoints: boardingPoints || [`${from.trim()} (${departureTime})`],
    droppingPoints: droppingPoints || [to.trim()],
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    active: true,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 2,
  };
}

export function computePricing(
  baseFare,
  seatCount,
  {
    taxRate = 0,
    discount = 0,
    depositAmount = 0,
    paymentMethod = "counter",
  } = {}
) {
  const subtotal = baseFare * seatCount;
  const tax = Math.round(subtotal * (Number(taxRate) || 0));
  const total = Math.max(0, subtotal + tax - discount);
  const deposit = Math.max(0, Math.min(Number(depositAmount) || 0, total));
  const dueAmount = Math.max(0, total - deposit);
  let paymentStatus = "due";
  if (dueAmount <= 0) paymentStatus = "paid";
  else if (deposit > 0) paymentStatus = "partial";
  return {
    baseFare,
    seatCount,
    subtotal,
    tax,
    discount,
    total,
    currency: "NPR",
    depositAmount: deposit,
    dueAmount,
    paymentStatus,
    paymentMethod,
  };
}

export function createExpense({
  title,
  category,
  amount,
  expenseDate,
  notes = "",
  busId = "",
  busNumber = "",
  createdBy,
}) {
  const now = new Date().toISOString();
  return {
    id: uid("exp"),
    title: title.trim(),
    category,
    amount: Number(amount),
    expenseDate: expenseDate || now.slice(0, 10),
    notes: (notes || "").trim(),
    busId: busId || null,
    busNumber: (busNumber || "").trim(),
    createdBy: createdBy || { role: "staff", name: "Staff" },
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  };
}

/** Aggregate tickets for a bus on a date (active bookings only). */
export function summarizeBusDay(bus, tickets, travelDate) {
  const list = tickets.filter(
    (t) =>
      t.status !== "cancelled" &&
      t.trip.busId === bus.id &&
      t.trip.travelDate === travelDate
  );
  const seatsBooked = list.reduce((n, t) => n + (t.trip.seatNumbers?.length || 0), 0);
  const luggagePieces = list.reduce((n, t) => n + Number(t.luggage?.pieces || 0), 0);
  const luggageKg = list.reduce((n, t) => n + Number(t.luggage?.weightKg || 0), 0);
  const paid = list.reduce((n, t) => n + Number(t.pricing.depositAmount ?? (t.pricing.paymentStatus === "paid" ? t.pricing.total : 0)), 0);
  const due = list.reduce((n, t) => {
    if (t.pricing.dueAmount != null) return n + Number(t.pricing.dueAmount);
    return n + (t.pricing.paymentStatus === "due" || t.pricing.paymentStatus === "partial" ? Number(t.pricing.total || 0) : 0);
  }, 0);
  return {
    bus,
    travelDate,
    tickets: list,
    passengerCount: list.length,
    seatsBooked,
    seatsTotal: bus.totalSeats,
    luggagePieces,
    luggageKg,
    paidTotal: paid,
    dueTotal: due,
    revenue: paid + due,
  };
}

export function createCounterStaff({
  fullName,
  phone,
  email = "",
  counterCode,
  counterLocation,
  city = "",
  shift = "Morning",
  pin,
  notes = "",
  assignedBusId = null,
  assignedSeats = [],
}) {
  const now = new Date().toISOString();
  return {
    id: uid("staff"),
    fullName: fullName.trim(),
    phone: phone.trim(),
    email: (email || "").trim(),
    counterCode: counterCode.trim().toUpperCase(),
    counterLocation: counterLocation.trim(),
    city: (city || "").trim(),
    shift,
    pin: String(pin).trim(),
    notes: (notes || "").trim(),
    assignedBusId: assignedBusId || null,
    assignedSeats: [...(assignedSeats || [])],
    role: "staff",
    status: "active",
    phoneVerified: false,
    phoneVerifiedAt: null,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 3,
  };
}

export const DEFAULT_CITIES = [
  "Kathmandu",
  "Pokhara",
  "Chitwan",
  "Biratnagar",
  "Butwal",
  "Nepalgunj",
  "Dharan",
  "Hetauda",
];
