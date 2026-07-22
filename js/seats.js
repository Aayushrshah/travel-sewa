/**
 * 2x2 sofa-seater seat charts (BusSewa-style default).
 */

/** Default layout matching common Nepal deluxe 2x2 sofa seater. */
export function defaultSeatLayout({ rows = 8, includeRear = true, layout = "2x2" } = {}) {
  const seats = [];
  const rowCount = Math.max(1, Number(rows) || 8);

  if (layout === "2x2") {
    for (let r = 1; r <= rowCount; r++) {
      const aL = `A${r * 2 - 1}`;
      const aR = `A${r * 2}`;
      const bL = `B${r * 2 - 1}`;
      const bR = `B${r * 2}`;
      seats.push({ id: aL, label: aL, row: r, side: "left", col: 0 });
      seats.push({ id: aR, label: aR, row: r, side: "left", col: 1 });
      seats.push({ id: bL, label: bL, row: r, side: "right", col: 0 });
      seats.push({ id: bR, label: bR, row: r, side: "right", col: 1 });
    }
    if (includeRear) {
      seats.push({ id: "R", label: "R", row: rowCount + 1, side: "rear", col: 0 });
    }
  } else {
    const total = rowCount * 4;
    for (let n = 1; n <= total; n++) {
      seats.push({
        id: String(n).padStart(2, "0"),
        label: String(n).padStart(2, "0"),
        row: Math.ceil(n / 4),
        side: ((n - 1) % 4) < 2 ? "left" : "right",
        col: (n - 1) % 2,
      });
    }
  }

  return {
    type: layout,
    rows: rowCount,
    includeRear: Boolean(includeRear) && layout === "2x2",
    seats,
    totalSeats: seats.length,
  };
}

export function normalizeSeatLayout(layout, fallbackSeats = 32) {
  if (layout?.seats?.length) {
    return {
      type: layout.type || "2x2",
      rows: layout.rows || Math.ceil(layout.seats.length / 4),
      includeRear: Boolean(layout.includeRear),
      seats: layout.seats,
      totalSeats: layout.seats.length,
    };
  }
  const rows = Math.max(4, Math.ceil(Number(fallbackSeats || 32) / 4));
  return defaultSeatLayout({ rows, includeRear: false });
}

export function seatIds(layout) {
  return normalizeSeatLayout(layout).seats.map((s) => s.id);
}

/**
 * Render interactive 2x2 seat chart into a container.
 * @param {object} opts
 * @param {string[]} [opts.taken] booked seats
 * @param {string[]} [opts.selected] seats selected for booking OR assigned to staff (green)
 * @param {boolean} [opts.assignMode] admin assigning seats to staff — no fare, unlimited select
 */
export function renderSeatChart(container, {
  layout,
  taken = [],
  selected = [],
  fare = null,
  onToggle,
  preview = false,
  assignMode = false,
}) {
  const chart = normalizeSeatLayout(layout);
  const takenSet = new Set(taken);
  const selectedSet = new Set(selected);

  const rows = new Map();
  for (const seat of chart.seats) {
    if (!rows.has(seat.row)) rows.set(seat.row, []);
    rows.get(seat.row).push(seat);
  }

  const fareHint = fare != null && !assignMode
    ? `<div class="seat-fare-hint">From Rs. ${Number(fare).toLocaleString()}</div>`
    : "";
  const selectedLabel = assignMode ? "Assigned (selected)" : "Selected";

  container.innerHTML = `
    <div class="seat-deck ${preview ? "preview" : ""} ${assignMode ? "assign-mode" : ""}">
      <div class="seat-deck-legend">
        <span><i class="chair available"></i> Available</span>
        <span><i class="chair booked"></i> Booked</span>
        <span><i class="chair selected"></i> ${selectedLabel}</span>
      </div>
      <div class="seat-deck-stage">
        <div class="driver-row">
          <span class="deck-label">Front</span>
          <span class="driver-wheel" title="Driver">◉</span>
        </div>
        <div class="seat-rows"></div>
      </div>
      ${fareHint}
    </div>
  `;

  const rowsEl = container.querySelector(".seat-rows");
  const sortedRows = [...rows.keys()].sort((a, b) => a - b);

  for (const rowNum of sortedRows) {
    const seats = rows.get(rowNum);
    const rear = seats.some((s) => s.side === "rear");
    const rowEl = document.createElement("div");
    rowEl.className = `seat-row ${rear ? "rear-row" : ""}`;

    if (rear) {
      rowEl.appendChild(makeSeatButton(seats[0], takenSet, selectedSet, preview, onToggle, fare, assignMode));
    } else {
      const left = seats.filter((s) => s.side === "left").sort((a, b) => a.col - b.col);
      const right = seats.filter((s) => s.side === "right").sort((a, b) => a.col - b.col);
      const leftWrap = document.createElement("div");
      leftWrap.className = "seat-pair";
      left.forEach((s) => leftWrap.appendChild(makeSeatButton(s, takenSet, selectedSet, preview, onToggle, fare, assignMode)));
      const aisle = document.createElement("div");
      aisle.className = "seat-aisle";
      aisle.setAttribute("aria-hidden", "true");
      const rightWrap = document.createElement("div");
      rightWrap.className = "seat-pair";
      right.forEach((s) => rightWrap.appendChild(makeSeatButton(s, takenSet, selectedSet, preview, onToggle, fare, assignMode)));
      rowEl.append(leftWrap, aisle, rightWrap);
    }
    rowsEl.appendChild(rowEl);
  }
}

function makeSeatButton(seat, takenSet, selectedSet, preview, onToggle, fare, assignMode) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "seat-chair";
  btn.dataset.seat = seat.id;

  let state = "available";
  if (takenSet.has(seat.id)) state = "booked";
  else if (selectedSet.has(seat.id)) state = "selected";
  btn.classList.add(state);
  btn.disabled = preview || state === "booked";
  btn.setAttribute("aria-label", `Seat ${seat.label} ${state}`);

  btn.innerHTML = `
    <span class="chair-icon">${state === "selected" ? "✓" : ""}</span>
    <span class="chair-label">${seat.label}</span>
    ${fare != null && state === "available" && !assignMode ? `<span class="chair-price">${Number(fare).toLocaleString()}</span>` : ""}
  `;

  if (!preview && state !== "booked" && typeof onToggle === "function") {
    btn.addEventListener("click", () => onToggle(seat.id));
  }
  return btn;
}
