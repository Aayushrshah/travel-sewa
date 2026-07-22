/**
 * Professional Travel Sewa PDFs — ticket + bus manifest.
 * Zero-dependency (standard Helvetica).
 */

function money(n, currency = "NPR") {
  const prefix = currency === "NPR" || currency === "Rs" ? "Rs" : currency;
  return `${prefix} ${Number(n || 0).toLocaleString("en-US")}`;
}

function ascii(value) {
  return String(value ?? "")
    .replaceAll("→", "->")
    .replaceAll("←", "<-")
    .replaceAll("·", "-")
    .replaceAll("—", "-")
    .replaceAll("–", "-")
    .replaceAll("…", "...")
    .replaceAll("’", "'")
    .replaceAll("‘", "'")
    .replaceAll("“", '"')
    .replaceAll("”", '"')
    .replace(/[^\x20-\x7E]/g, "?");
}

function pdfEscape(text) {
  return ascii(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function rgb(r, g, b) {
  return `${(r / 255).toFixed(3)} ${(g / 255).toFixed(3)} ${(b / 255).toFixed(3)}`;
}

/** EasyCollect-inspired statement palette */
const C = {
  navy: [15, 23, 42],
  ink: [30, 41, 59],
  soft: [100, 116, 139],
  line: [226, 232, 240],
  lineSoft: [241, 245, 249],
  teal: [13, 148, 136],
  tealDeep: [15, 118, 110],
  tealSoft: [204, 251, 241],
  tealMuted: [240, 253, 250],
  green: [22, 163, 74],
  greenDeep: [21, 128, 61],
  blueDeep: [8, 61, 119],
  red: [220, 38, 38],
  orange: [234, 88, 12],
  sky: [126, 184, 218],
  white: [255, 255, 255],
  paper: [255, 255, 255],
  card: [255, 255, 255],
  cream: [255, 251, 235],
  headerGray: [248, 250, 252],
};

/** Approximate circle with Bezier curves */
function circlePath(cx, cy, r) {
  const k = 0.5522847498 * r;
  return [
    `${cx - r} ${cy} m`,
    `${cx - r} ${cy + k} ${cx - k} ${cy + r} ${cx} ${cy + r} c`,
    `${cx + k} ${cy + r} ${cx + r} ${cy + k} ${cx + r} ${cy} c`,
    `${cx + r} ${cy - k} ${cx + k} ${cy - r} ${cx} ${cy - r} c`,
    `${cx - k} ${cy - r} ${cx - r} ${cy - k} ${cx - r} ${cy} c`,
  ].join("\n");
}

/** Build PDF from pages of draw commands. */
function buildPdf(pages) {
  const encoder = new TextEncoder();
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };

  const font1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const font2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const pageIds = [];

  for (const cmds of pages) {
    const ops = [];
    for (const cmd of cmds) {
      if (cmd.type === "rect") {
        const [r, g, b] = cmd.fill || C.navy;
        ops.push(`${rgb(r, g, b)} rg`);
        ops.push(`${cmd.x} ${cmd.y} ${cmd.w} ${cmd.h} re f`);
      } else if (cmd.type === "strokeRect") {
        const [r, g, b] = cmd.stroke || C.line;
        ops.push(`${rgb(r, g, b)} RG`);
        ops.push(`${cmd.width || 1} w`);
        ops.push(`${cmd.x} ${cmd.y} ${cmd.w} ${cmd.h} re S`);
      } else if (cmd.type === "line") {
        const [r, g, b] = cmd.stroke || C.line;
        ops.push(`${rgb(r, g, b)} RG`);
        ops.push(`${cmd.width || 0.8} w`);
        ops.push(`${cmd.x1} ${cmd.y1} m ${cmd.x2} ${cmd.y2} l S`);
      } else if (cmd.type === "circle") {
        const [r, g, b] = cmd.fill || C.navy;
        ops.push(`${rgb(r, g, b)} rg`);
        ops.push(circlePath(cmd.cx, cmd.cy, cmd.r));
        ops.push("f");
      } else if (cmd.type === "ring") {
        const [r, g, b] = cmd.stroke || C.orange;
        ops.push(`${rgb(r, g, b)} RG`);
        ops.push(`${cmd.width || 2} w`);
        ops.push(circlePath(cmd.cx, cmd.cy, cmd.r));
        ops.push("S");
      } else if (cmd.type === "text") {
        const [r, g, b] = cmd.color || C.ink;
        const size = cmd.size || 11;
        const font = cmd.bold ? "F2" : "F1";
        ops.push(`${rgb(r, g, b)} rg`);
        ops.push("BT");
        ops.push(`/${font} ${size} Tf`);
        ops.push(`${cmd.x} ${cmd.y} Td`);
        ops.push(`(${pdfEscape(cmd.text)}) Tj`);
        ops.push("ET");
      }
    }

    const stream = ops.join("\n");
    const streamLen = encoder.encode(stream).length;
    const contents = add(`<< /Length ${streamLen} >>\nstream\n${stream}\nendstream`);
    const page = add(
      `<< /Type /Page /Parent 0 0 R /MediaBox [0 0 595 842] /Contents ${contents} 0 R /Resources << /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >> >> >>`
    );
    pageIds.push(page);
  }

  const kids = pageIds.map((id) => `${id} 0 R`).join(" ");
  const pagesObj = add(`<< /Type /Pages /Kids [${kids}] /Count ${pageIds.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  for (const id of pageIds) {
    objects[id - 1] = objects[id - 1].replace("/Parent 0 0 R", `/Parent ${pagesObj} 0 R`);
  }

  const chunks = [encoder.encode("%PDF-1.4\n")];
  const offsets = [0];
  let offset = chunks[0].length;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(offset);
    const chunk = encoder.encode(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`);
    chunks.push(chunk);
    offset += chunk.length;
  }

  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\n`;
  xref += `startxref\n${xrefStart}\n%%EOF`;
  chunks.push(encoder.encode(xref));

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

/**
 * Draw Travel Sewa logo (bus + tap) at bottom-left of square, plus brand name.
 * @param {object[]} cmds
 * @param {{x:number,y:number,size?:number,subtitle?:string,rightTop?:string,rightBottom?:string,rightBottomColor?:number[]}} opts
 * Logo sits with bottom-left at (x,y); size is logo square side in points.
 */
function drawBrandHeader(cmds, opts) {
  const {
    x = 28,
    y = 788,
    size = 40,
    subtitle = "Electronic Bus Ticket",
    rightTop = "",
    rightBottom = "",
    rightBottomColor = C.green,
  } = opts;

  // Header bar
  cmds.push({ type: "rect", x: 0, y: 780, w: 595, h: 62, fill: C.navy });
  cmds.push({ type: "rect", x: 0, y: 780, w: 6, h: 62, fill: C.green });

  // Logo mark (scaled from 96x96 SVG to `size`)
  const s = size / 96;
  const lx = x;
  const ly = y;

  // Rounded-ish square background (green + blue blocks for gradient feel)
  cmds.push({ type: "rect", x: lx, y: ly, w: size, h: size, fill: C.greenDeep });
  cmds.push({ type: "rect", x: lx + size * 0.45, y: ly, w: size * 0.55, h: size, fill: C.blueDeep });

  // Bus body
  cmds.push({
    type: "rect",
    x: lx + 18 * s,
    y: ly + (96 - 28 - 36) * s,
    w: 60 * s,
    h: 36 * s,
    fill: C.cream,
  });
  // Windows
  cmds.push({
    type: "rect",
    x: lx + 24 * s,
    y: ly + (96 - 34 - 14) * s,
    w: 18 * s,
    h: 14 * s,
    fill: C.sky,
  });
  cmds.push({
    type: "rect",
    x: lx + 46 * s,
    y: ly + (96 - 34 - 14) * s,
    w: 18 * s,
    h: 14 * s,
    fill: C.sky,
  });
  // Door accent
  cmds.push({
    type: "rect",
    x: lx + 68 * s,
    y: ly + (96 - 34 - 14) * s,
    w: 6 * s,
    h: 14 * s,
    fill: C.orange,
  });
  // Tap ripple
  cmds.push({
    type: "ring",
    cx: lx + 72 * s,
    cy: ly + (96 - 22) * s,
    r: 10 * s,
    stroke: C.orange,
    width: Math.max(1.2, 2.5 * s),
  });
  cmds.push({
    type: "circle",
    cx: lx + 72 * s,
    cy: ly + (96 - 22) * s,
    r: 4 * s,
    fill: C.orange,
  });
  // Wheels
  cmds.push({
    type: "circle",
    cx: lx + 32 * s,
    cy: ly + (96 - 66) * s,
    r: 7 * s,
    fill: C.navy,
  });
  cmds.push({
    type: "circle",
    cx: lx + 64 * s,
    cy: ly + (96 - 66) * s,
    r: 7 * s,
    fill: C.navy,
  });
  cmds.push({
    type: "circle",
    cx: lx + 32 * s,
    cy: ly + (96 - 66) * s,
    r: 3 * s,
    fill: C.cream,
  });
  cmds.push({
    type: "circle",
    cx: lx + 64 * s,
    cy: ly + (96 - 66) * s,
    r: 3 * s,
    fill: C.cream,
  });

  // Brand name next to logo
  const tx = lx + size + 12;
  cmds.push({ type: "text", text: "Travel Sewa", x: tx, y: ly + size * 0.58, size: 20, bold: true, color: C.white });
  cmds.push({ type: "text", text: subtitle, x: tx, y: ly + size * 0.22, size: 9, color: [170, 180, 195] });

  if (rightTop) {
    cmds.push({ type: "text", text: ascii(rightTop), x: 400, y: 812, size: 11, bold: true, color: C.white });
  }
  if (rightBottom) {
    cmds.push({
      type: "text",
      text: ascii(rightBottom),
      x: 400,
      y: 792,
      size: 9,
      bold: true,
      color: rightBottomColor,
    });
  }
}

function downloadBytes(filename, bytes) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function luggageLabel(ticket) {
  const L = ticket.luggage || { pieces: 0, weightKg: 0, description: "" };
  const parts = [`${L.pieces || 0} pcs`, `${L.weightKg || 0} kg`];
  if (L.description) parts.push(ascii(L.description));
  return parts.join(" / ");
}

function truncate(str, n) {
  const s = ascii(str);
  return s.length > n ? `${s.slice(0, n - 1)}.` : s;
}

function field(cmds, label, value, x, y, labelW = 72) {
  cmds.push({ type: "text", text: label.toUpperCase(), x, y: y + 12, size: 7, bold: true, color: C.soft });
  cmds.push({ type: "text", text: ascii(value || "-"), x, y, size: 11, bold: true, color: C.ink });
}

function statusColor(status) {
  const s = String(status || "").toLowerCase();
  if (s === "paid" || s === "confirmed") return C.green;
  if (s === "partial") return C.orange;
  if (s === "due" || s === "pending" || s === "unpaid") return C.red;
  return C.soft;
}

function statusLabel(status) {
  const s = String(status || "paid").toLowerCase();
  if (s === "paid") return "Paid";
  if (s === "partial") return "Partial";
  if (s === "due" || s === "pending") return "Unpaid";
  return String(status || "-");
}

function drawKpiBox(cmds, x, y, w, h, label, value, valueColor = C.ink) {
  cmds.push({ type: "rect", x, y, w, h, fill: C.white });
  cmds.push({ type: "strokeRect", x, y, w, h, stroke: C.line, width: 1 });
  cmds.push({ type: "text", text: label.toUpperCase(), x: x + 10, y: y + h - 14, size: 7, bold: true, color: C.soft });
  cmds.push({
    type: "text",
    text: truncate(value, 16),
    x: x + 10,
    y: y + 12,
    size: 12,
    bold: true,
    color: valueColor,
  });
}

function drawStatementHeader(cmds, { title, badgeLabel, badgeValue }) {
  cmds.push({ type: "rect", x: 0, y: 0, w: 595, h: 842, fill: C.paper });

  // Logo mark
  cmds.push({ type: "rect", x: 36, y: 792, w: 22, h: 22, fill: C.teal });
  cmds.push({ type: "text", text: "T", x: 42, y: 798, size: 14, bold: true, color: C.white });
  cmds.push({ type: "text", text: "Travel Sewa", x: 66, y: 808, size: 16, bold: true, color: C.ink });
  cmds.push({ type: "text", text: title, x: 66, y: 792, size: 9, color: C.soft });

  // Period / ref badge (light teal)
  const badgeW = 168;
  const badgeX = 595 - 36 - badgeW;
  cmds.push({ type: "rect", x: badgeX, y: 788, w: badgeW, h: 32, fill: C.tealSoft });
  cmds.push({ type: "text", text: badgeLabel.toUpperCase(), x: badgeX + 12, y: 808, size: 6, bold: true, color: C.tealDeep });
  cmds.push({ type: "text", text: truncate(badgeValue, 22), x: badgeX + 12, y: 794, size: 10, bold: true, color: C.ink });

  // Teal divider
  cmds.push({ type: "line", x1: 36, y1: 776, x2: 559, y2: 776, stroke: C.teal, width: 1.5 });
}

function drawFooter(cmds, when = new Date()) {
  cmds.push({ type: "line", x1: 36, y1: 48, x2: 559, y2: 48, stroke: C.line, width: 1 });
  cmds.push({ type: "text", text: "Generated by Travel Sewa", x: 36, y: 32, size: 8, color: C.soft });
  cmds.push({
    type: "text",
    text: ascii(
      when.toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      })
    ),
    x: 400,
    y: 32,
    size: 8,
    color: C.soft,
  });
}

/** Statement-style e-ticket (EasyCollect model) */
export function downloadTicketPdf(ticket) {
  const p = ticket.passenger;
  const t = ticket.trip;
  const cur = ticket.pricing.currency || "NPR";
  const payRaw = ticket.pricing.paymentStatus || "paid";
  const pay = statusLabel(payRaw);
  const payColor = statusColor(payRaw);
  const totalAmt = Number(ticket.pricing.total || 0);
  const depositAmt = Number(
    ticket.pricing.depositAmount ?? (String(payRaw).toLowerCase() === "paid" ? totalAmt : 0)
  );
  const dueAmt = Number(ticket.pricing.dueAmount ?? Math.max(0, totalAmt - depositAmt));
  const seats = (t.seatNumbers || []).join(", ") || "-";
  const pickup = p.pickupAddress || "-";
  const cmds = [];

  drawStatementHeader(cmds, {
    title: "Bus Ticket Statement",
    badgeLabel: "Travel date",
    badgeValue: t.travelDate || "-",
  });

  // Route line under divider
  cmds.push({
    type: "text",
    text: `${truncate(t.from, 20)}  ->  ${truncate(t.to, 20)}`,
    x: 36,
    y: 756,
    size: 13,
    bold: true,
    color: C.ink,
  });
  cmds.push({
    type: "text",
    text: `${ascii(t.departureTime)}-${ascii(t.arrivalTime)}   ·   Bus ${ascii(t.busNumber)}   ·   ${ascii(ticket.bookingRef)}`,
    x: 36,
    y: 740,
    size: 8,
    color: C.soft,
  });

  // KPI summary boxes
  const boxY = 668;
  const boxH = 48;
  const gap = 10;
  const boxW = (523 - gap * 3) / 4;
  drawKpiBox(cmds, 36, boxY, boxW, boxH, "Seat no", seats, C.ink);
  drawKpiBox(cmds, 36 + boxW + gap, boxY, boxW, boxH, "Payment", pay, payColor);
  drawKpiBox(cmds, 36 + (boxW + gap) * 2, boxY, boxW, boxH, "Total amount", money(totalAmt, cur), C.tealDeep);
  drawKpiBox(
    cmds,
    36 + (boxW + gap) * 3,
    boxY,
    boxW,
    boxH,
    "Dues amount",
    money(dueAmt, cur),
    dueAmt > 0 ? C.red : C.green
  );

  // Details — clear rows (seat on its own line)
  let y = 640;
  cmds.push({ type: "rect", x: 36, y: y - 6, w: 523, h: 22, fill: C.headerGray });
  cmds.push({ type: "text", text: "PASSENGER DETAILS", x: 44, y, size: 7, bold: true, color: C.soft });
  cmds.push({ type: "text", text: "CONTACT", x: 280, y, size: 7, bold: true, color: C.soft });
  cmds.push({ type: "text", text: "STATUS", x: 460, y, size: 7, bold: true, color: C.soft });
  y -= 8;
  cmds.push({ type: "line", x1: 36, y1: y, x2: 559, y2: y, stroke: C.line, width: 1 });

  y -= 22;
  cmds.push({ type: "text", text: truncate(p.fullName, 28), x: 44, y, size: 11, bold: true, color: C.ink });
  cmds.push({ type: "text", text: ascii(p.phone || "-"), x: 280, y, size: 10, bold: true, color: C.ink });
  cmds.push({ type: "text", text: pay, x: 460, y, size: 10, bold: true, color: payColor });
  y -= 16;
  cmds.push({ type: "line", x1: 36, y1: y, x2: 559, y2: y, stroke: C.lineSoft, width: 1 });

  // Seat number — separate line
  y -= 20;
  cmds.push({ type: "text", text: "SEAT NO", x: 44, y, size: 7, bold: true, color: C.soft });
  y -= 14;
  cmds.push({ type: "text", text: ascii(seats), x: 44, y, size: 12, bold: true, color: C.ink });
  y -= 14;
  cmds.push({ type: "line", x1: 36, y1: y, x2: 559, y2: y, stroke: C.line, width: 1 });

  // Pick-up — separate line
  y -= 20;
  cmds.push({ type: "text", text: "PICK-UP ADDRESS", x: 44, y, size: 7, bold: true, color: C.soft });
  y -= 14;
  cmds.push({ type: "text", text: truncate(pickup, 78), x: 44, y, size: 10, bold: true, color: C.ink });
  y -= 16;
  cmds.push({ type: "line", x1: 36, y1: y, x2: 559, y2: y, stroke: C.line, width: 1 });

  // Left: payment meta
  y -= 28;
  cmds.push({ type: "text", text: "PAYMENT STATUS", x: 44, y, size: 7, bold: true, color: C.soft });
  y -= 16;
  cmds.push({ type: "text", text: pay, x: 44, y, size: 14, bold: true, color: payColor });
  y -= 16;
  cmds.push({
    type: "text",
    text: `Method: ${ascii(String(ticket.pricing.paymentMethod || "counter").toUpperCase())}`,
    x: 44,
    y,
    size: 8,
    color: C.soft,
  });
  y -= 12;
  cmds.push({
    type: "text",
    text: `Ref: ${ascii(ticket.bookingRef)}`,
    x: 44,
    y,
    size: 8,
    color: C.soft,
  });

  // Right: totals — grand total stacked below dues (no overlap)
  const sumX = 340;
  let sy = 500;
  const amountRows = [
    { label: "Total amount", value: money(totalAmt, cur), color: C.ink, bold: false },
    { label: "Deposit / advance", value: money(depositAmt, cur), color: C.ink, bold: false },
    { label: "Dues amount", value: money(dueAmt, cur), color: dueAmt > 0 ? C.red : C.green, bold: true },
  ];
  for (const row of amountRows) {
    cmds.push({ type: "text", text: row.label, x: sumX, y: sy, size: 9, color: C.soft });
    cmds.push({
      type: "text",
      text: row.value,
      x: sumX + 118,
      y: sy,
      size: 9,
      bold: row.bold,
      color: row.color,
    });
    sy -= 18;
  }

  sy -= 14;
  const boxBottom = sy - 28;
  cmds.push({ type: "rect", x: sumX - 8, y: boxBottom, w: 220, h: 40, fill: C.cream });
  cmds.push({ type: "strokeRect", x: sumX - 8, y: boxBottom, w: 220, h: 40, stroke: C.line, width: 1 });
  cmds.push({
    type: "text",
    text: "Grand total",
    x: sumX,
    y: boxBottom + 24,
    size: 8,
    bold: true,
    color: C.soft,
  });
  cmds.push({
    type: "text",
    text: money(totalAmt, cur),
    x: sumX,
    y: boxBottom + 8,
    size: 13,
    bold: true,
    color: C.tealDeep,
  });

  drawFooter(cmds, new Date(ticket.createdAt || Date.now()));
  downloadBytes(`TravelSewa-Ticket-${ascii(ticket.bookingRef)}.pdf`, buildPdf([cmds]));
}

/** Bus-day statement PDF (EasyCollect table model) */
export function downloadBusManifestPdf(summary) {
  const bus = summary.bus;
  const pages = [];
  const sorted = [...summary.tickets].sort((a, b) => {
    const sa = (a.trip.seatNumbers || [])[0] || "";
    const sb = (b.trip.seatNumbers || [])[0] || "";
    return sa.localeCompare(sb);
  });
  const paidCount = sorted.filter((t) => String(t.pricing.paymentStatus || "").toLowerCase() === "paid").length;

  const makePage = (continued = false) => {
    const cmds = [];
    drawStatementHeader(cmds, {
      title: continued ? "Bus Manifest (continued)" : "Bus Day Statement",
      badgeLabel: "Travel date",
      badgeValue: summary.travelDate || "-",
    });
    return cmds;
  };

  const tableHeads = [
    [44, "SEAT"],
    [90, "PASSENGER"],
    [230, "PICK-UP"],
    [350, "TOTAL"],
    [420, "DUE"],
    [490, "STATUS"],
  ];

  const drawTableHead = (cmds, y) => {
    cmds.push({ type: "rect", x: 36, y: y - 6, w: 523, h: 22, fill: C.headerGray });
    for (const [x, lab] of tableHeads) {
      cmds.push({ type: "text", text: lab, x, y, size: 7, bold: true, color: C.soft });
    }
    cmds.push({ type: "line", x1: 36, y1: y - 10, x2: 559, y2: y - 10, stroke: C.line, width: 1 });
    return y - 36;
  };

  let cmds = makePage(false);
  cmds.push({
    type: "text",
    text: ascii(`${bus.busNumber}  ·  ${bus.displayName || bus.operator || ""}`),
    x: 36,
    y: 756,
    size: 13,
    bold: true,
    color: C.ink,
  });
  cmds.push({
    type: "text",
    text: ascii(`${bus.busType || ""} · ${bus.operator || ""}`),
    x: 36,
    y: 740,
    size: 8,
    color: C.soft,
  });

  const boxY = 668;
  const boxH = 48;
  const gap = 10;
  const boxW = (523 - gap * 3) / 4;
  drawKpiBox(cmds, 36, boxY, boxW, boxH, "Passengers", String(summary.passengerCount));
  drawKpiBox(cmds, 36 + boxW + gap, boxY, boxW, boxH, "Paid", `${paidCount} / ${summary.passengerCount}`, C.green);
  drawKpiBox(cmds, 36 + (boxW + gap) * 2, boxY, boxW, boxH, "Collected", money(summary.paidTotal), C.tealDeep);
  drawKpiBox(
    cmds,
    36 + (boxW + gap) * 3,
    boxY,
    boxW,
    boxH,
    "Total dues",
    money(summary.dueTotal),
    summary.dueTotal > 0 ? C.red : C.green
  );

  let y = drawTableHead(cmds, 640);

  if (!sorted.length) {
    cmds.push({ type: "text", text: "No active bookings for this bus on this date.", x: 44, y, size: 10, color: C.soft });
    const expenses = Array.isArray(summary.expenses) ? summary.expenses : [];
    if (expenses.length) {
      const expenseTotal = expenses.reduce((n, e) => n + Number(e.amount || 0), 0);
      let ey = 560;
      const sumX = 340;
      cmds.push({ type: "text", text: "EXPENSES", x: sumX, y: ey, size: 8, bold: true, color: C.red });
      ey -= 14;
      for (const exp of expenses) {
        cmds.push({
          type: "text",
          text: truncate(`${exp.category || "Other"} · ${exp.title || ""}`, 22),
          x: sumX,
          y: ey,
          size: 8,
          color: C.soft,
        });
        cmds.push({ type: "text", text: money(exp.amount), x: sumX + 110, y: ey, size: 8, color: C.ink });
        ey -= 14;
      }
      cmds.push({ type: "text", text: "Total expenses", x: sumX, y: ey, size: 9, bold: true, color: C.ink });
      cmds.push({
        type: "text",
        text: money(expenseTotal),
        x: sumX + 110,
        y: ey,
        size: 9,
        bold: true,
        color: C.red,
      });
    }
    drawFooter(cmds);
    pages.push(cmds);
  } else {
    for (const t of sorted) {
      if (y < 90) {
        drawFooter(cmds);
        pages.push(cmds);
        cmds = makePage(true);
        cmds.push({
          type: "text",
          text: ascii(`${bus.busNumber}  ·  ${summary.travelDate}`),
          x: 36,
          y: 756,
          size: 11,
          bold: true,
          color: C.ink,
        });
        y = drawTableHead(cmds, 730);
      }

      const seats = (t.trip.seatNumbers || []).join(", ") || "-";
      const payRaw = t.pricing.paymentStatus || "paid";
      const pay = statusLabel(payRaw);
      const due = Number(
        t.pricing.dueAmount ??
          Math.max(
            0,
            Number(t.pricing.total || 0) -
              Number(t.pricing.depositAmount ?? (String(payRaw).toLowerCase() === "paid" ? t.pricing.total : 0))
          )
      );

      cmds.push({ type: "text", text: truncate(seats, 8), x: 44, y, size: 9, bold: true, color: C.ink });
      cmds.push({ type: "text", text: truncate(t.passenger.fullName, 18), x: 90, y, size: 9, bold: true, color: C.ink });
      cmds.push({
        type: "text",
        text: ascii(t.passenger.phone || "-"),
        x: 90,
        y: y - 11,
        size: 7,
        color: C.soft,
      });
      cmds.push({
        type: "text",
        text: truncate(t.passenger.pickupAddress || "-", 16),
        x: 230,
        y: y - 4,
        size: 8,
        color: C.ink,
      });
      cmds.push({
        type: "text",
        text: truncate(money(t.pricing.total, t.pricing.currency), 11),
        x: 350,
        y: y - 4,
        size: 9,
        bold: true,
        color: C.tealDeep,
      });
      cmds.push({
        type: "text",
        text: truncate(money(due, t.pricing.currency), 11),
        x: 420,
        y: y - 4,
        size: 9,
        bold: true,
        color: due > 0 ? C.red : C.green,
      });
      cmds.push({ type: "text", text: pay, x: 490, y: y - 4, size: 9, bold: true, color: statusColor(payRaw) });

      y -= 24;
      cmds.push({ type: "line", x1: 36, y1: y, x2: 559, y2: y, stroke: C.lineSoft, width: 1 });
      y -= 14;
    }

    // Bottom totals (EasyCollect-style; expenses/deductions only if present)
    y -= 8;
    const sumX = 340;
    const expenses = Array.isArray(summary.expenses) ? summary.expenses : [];
    const expenseTotal = expenses.reduce((n, e) => n + Number(e.amount || 0), 0);
    const netTotal = Math.max(0, Number(summary.paidTotal || 0) - expenseTotal);

    if (y < 120 + (expenses.length ? expenses.length * 14 + 40 : 0)) {
      drawFooter(cmds);
      pages.push(cmds);
      cmds = makePage(true);
      cmds.push({
        type: "text",
        text: ascii(`${bus.busNumber}  ·  ${summary.travelDate}`),
        x: 36,
        y: 756,
        size: 11,
        bold: true,
        color: C.ink,
      });
      y = 720;
    }

    cmds.push({ type: "text", text: "Total collected", x: sumX, y, size: 9, color: C.soft });
    cmds.push({
      type: "text",
      text: money(summary.paidTotal),
      x: sumX + 110,
      y,
      size: 9,
      bold: true,
      color: C.red,
    });
    y -= 16;
    cmds.push({ type: "text", text: "Total dues", x: sumX, y, size: 9, color: C.soft });
    cmds.push({
      type: "text",
      text: money(summary.dueTotal),
      x: sumX + 110,
      y,
      size: 9,
      bold: true,
      color: summary.dueTotal > 0 ? C.red : C.green,
    });

    if (expenses.length) {
      y -= 20;
      cmds.push({ type: "text", text: "EXPENSES", x: sumX, y, size: 8, bold: true, color: C.red });
      y -= 14;
      for (const exp of expenses) {
        const label = truncate(`${exp.category || "Other"} · ${exp.title || ""}`, 22);
        cmds.push({ type: "text", text: label, x: sumX, y, size: 8, color: C.soft });
        cmds.push({
          type: "text",
          text: money(exp.amount),
          x: sumX + 118,
          y,
          size: 8,
          color: C.ink,
        });
        y -= 14;
      }
      cmds.push({ type: "text", text: "Total expenses", x: sumX, y, size: 9, bold: true, color: C.ink });
      cmds.push({
        type: "text",
        text: money(expenseTotal),
        x: sumX + 118,
        y,
        size: 9,
        bold: true,
        color: C.red,
      });
      y -= 22;
      const boxBottom = y - 28;
      cmds.push({ type: "rect", x: sumX - 8, y: boxBottom, w: 220, h: 40, fill: C.cream });
      cmds.push({ type: "strokeRect", x: sumX - 8, y: boxBottom, w: 220, h: 40, stroke: C.line, width: 1 });
      cmds.push({
        type: "text",
        text: "Net after expenses",
        x: sumX,
        y: boxBottom + 24,
        size: 8,
        bold: true,
        color: C.soft,
      });
      cmds.push({
        type: "text",
        text: money(netTotal),
        x: sumX,
        y: boxBottom + 8,
        size: 12,
        bold: true,
        color: C.tealDeep,
      });
    } else {
      y -= 22;
      const boxBottom = y - 28;
      cmds.push({ type: "rect", x: sumX - 8, y: boxBottom, w: 220, h: 40, fill: C.cream });
      cmds.push({ type: "strokeRect", x: sumX - 8, y: boxBottom, w: 220, h: 40, stroke: C.line, width: 1 });
      cmds.push({
        type: "text",
        text: "Grand total",
        x: sumX,
        y: boxBottom + 24,
        size: 8,
        bold: true,
        color: C.soft,
      });
      cmds.push({
        type: "text",
        text: money(summary.revenue),
        x: sumX,
        y: boxBottom + 8,
        size: 12,
        bold: true,
        color: C.tealDeep,
      });
    }

    drawFooter(cmds);
    pages.push(cmds);
  }

  const file = `TravelSewa-Manifest-${ascii(bus.busNumber)}-${ascii(summary.travelDate)}.pdf`;
  downloadBytes(file, buildPdf(pages));
}
