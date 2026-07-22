/**
 * Messaging helpers — WhatsApp + native SMS deep links.
 * Opens the device apps with a prefilled ticket message (no SMS gateway required).
 */

/** Strip to digits; keep leading + for international. */
export function normalizePhone(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  return hasPlus ? `+${digits}` : digits;
}

/** WhatsApp expects country code without +. Nepal default 977 if local mobile. */
export function whatsAppNumber(raw) {
  let digits = normalizePhone(raw).replace(/^\+/, "");
  if (!digits) return "";
  // Local Nepali mobiles often start with 98/97 and are 10 digits
  if (digits.length === 10 && /^(98|97)\d{8}$/.test(digits)) {
    digits = `977${digits}`;
  } else if (digits.length === 9) {
    digits = `977${digits}`;
  }
  return digits;
}

export function buildTicketMessage(ticket) {
  const p = ticket.passenger;
  const t = ticket.trip;
  const L = ticket.luggage || {};
  const cur = ticket.pricing.currency || "NPR";
  const total = Number(ticket.pricing.total || 0);
  const deposit = Number(ticket.pricing.depositAmount ?? (ticket.pricing.paymentStatus === "paid" ? total : 0));
  const due = Number(ticket.pricing.dueAmount ?? Math.max(0, total - deposit));
  const pay = String(ticket.pricing.paymentStatus || "paid").toUpperCase();
  return [
    `Travel Sewa Ticket`,
    `Ref: ${ticket.bookingRef}`,
    `Status: ${ticket.status}`,
    `Payment: ${pay}`,
    ``,
    `Passenger: ${p.fullName}`,
    `Phone: ${p.phone}`,
    p.pickupAddress ? `Pick-up: ${p.pickupAddress}` : null,
    `Route: ${t.from} → ${t.to}`,
    `Date: ${t.travelDate}`,
    `Time: ${t.departureTime} → ${t.arrivalTime}`,
    `Bus: ${t.busNumber} (${t.busType})`,
    `Seats: ${(t.seatNumbers || []).join(", ")}`,
    `Luggage: ${L.pieces || 0} pcs / ${L.weightKg || 0} kg${L.description ? ` (${L.description})` : ""}`,
    `Total: ${cur} ${total.toLocaleString()}`,
    `Deposit: ${cur} ${deposit.toLocaleString()}`,
    `Due: ${cur} ${due.toLocaleString()}`,
    ticket.notes ? `Note: ${ticket.notes}` : null,
    ``,
    `Thank you for travelling with Travel Sewa.`,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function openWhatsApp(ticket) {
  const phone = whatsAppNumber(ticket.passenger.phone);
  if (!phone) throw new Error("Passenger phone is missing");
  const text = encodeURIComponent(buildTicketMessage(ticket));
  const url = `https://wa.me/${phone}?text=${text}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

export function openSms(ticket) {
  const phone = normalizePhone(ticket.passenger.phone);
  if (!phone) throw new Error("Passenger phone is missing");
  const body = encodeURIComponent(buildTicketMessage(ticket));
  // iOS uses &body=, Android often ?body= — dual form works on most devices
  const url = `sms:${phone}?&body=${body}`;
  window.location.href = url;
}
