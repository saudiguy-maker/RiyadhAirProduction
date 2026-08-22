/**
 * OPERATORS — one object per carrier. Everything carrier-specific lives here
 * so the rest of the system stays operator-agnostic, exactly as
 * MANUFACTURERS does for builders.
 *
 * This is a DELIVERY tracker, not a fleet tracker. Every count below is
 * outstanding backlog — aircraft still to be handed over. Already-flying
 * aircraft are deliberately absent; an A320 delivered in 2014 has no
 * meaningful position on a production lifecycle rail.
 *
 * Sources current to 2026-08-13. Backlogs move; treat this file as data to
 * be reconciled, not as settled fact.
 */

export const OPERATORS = {
  RXI: {
    id: "RXI", iata: "RX", name: "Riyadh Air", short: "Riyadh Air",
    callsign: /^RXI\d{1,4}$/,
    regSeries: /^HZ-RX[A-Z]{2}$/,
    bases: ["OERK"],
    accent: "#6C3FD1",
    orders: [
      { manufacturer: "BOEING", type_code: "787-9",     icao_type: "B789", qty_firm: 47, qty_options: 5,
        announced_on: "2023-03-14", note: "39 firm 2023 plus options firmed at Farnborough 2026" },
      { manufacturer: "BOEING", type_code: "787-10",    icao_type: "B78X", qty_firm: 20, qty_options: 0,
        announced_on: "2026-07-20", converted_from: "787-9",
        note: "20 options converted up to the -10; Boeing lists 17 of the 28 as still to be finalised" },
      { manufacturer: "AIRBUS", type_code: "A350-1000", icao_type: "A35K", qty_firm: 31, qty_options: 19,
        announced_on: "2025-06-17", note: "25 firm Paris 2025, 6 more Farnborough 2026, from up to 50" },
      { manufacturer: "AIRBUS", type_code: "A321neo",   icao_type: "A21N", qty_firm: 60, qty_options: 0,
        announced_on: "2024-05-01", note: "includes A321XLR" },
    ],
  },

  SVA: {
    id: "SVA", iata: "SV", name: "Saudia", short: "Saudia",
    callsign: /^SVA\d{1,4}$/,
    regSeries: /^HZ-A[A-Z0-9]{1,3}$/,
    bases: ["OEJN", "OERK", "OEDF"],
    accent: "#3E9E7A",
    orders: [
      { manufacturer: "AIRBUS", type_code: "A320neo family", icao_type: "A21N", qty_firm: 54, qty_options: 0,
        announced_on: "2024-05-22",
        note: "Saudia's share of the Saudia Group 105-aircraft Airbus order; the other 51 went to flyadeal. A320neo/A321neo split not published." },
      { manufacturer: "BOEING", type_code: "787-9/-10",    icao_type: "B789", qty_firm: 0, qty_options: 0,
        announced_on: null,
        note: "Outstanding 787-9 and 787-10 deliveries run 2026–2029, but no public per-variant backlog figure exists. Left at zero rather than guessed — see README." },
    ],
  },

  NAS: {
    id: "NAS", iata: "XY", name: "flynas", short: "flynas",
    callsign: /^NAS\d{1,4}$/,
    regSeries: /^HZ-N[A-Z0-9]{1,3}$/,
    bases: ["OERK", "OEJN", "OEDF"],
    accent: "#D4A24C",
    orders: [
      { manufacturer: "AIRBUS", type_code: "A320neo",  icao_type: "A20N", qty_firm: 95, qty_options: 0,
        announced_on: "2024-07-22", note: "balance of the Farnborough 2024 order for 75 A320neo-family plus options" },
      { manufacturer: "AIRBUS", type_code: "A321neo",  icao_type: "A21N", qty_firm: 56, qty_options: 0,
        announced_on: "2026-07-22", note: "raised to 56 by the Farnborough 2026 order for 20 more" },
      { manufacturer: "AIRBUS", type_code: "A330-900", icao_type: "A339", qty_firm: 20, qty_options: 0,
        announced_on: "2026-07-22", note: "raised to 20 by the Farnborough 2026 order for 5 more" },
    ],
  },

  FAD: {
    id: "FAD", iata: "F3", name: "flyadeal", short: "flyadeal",
    callsign: /^FAD\d{1,4}$/,
    regSeries: /^HZ-FA[A-Z]$/,
    bases: ["OEJN", "OERK", "OEDF"],
    accent: "#9B5FC0",
    orders: [
      { manufacturer: "AIRBUS", type_code: "A320neo",  icao_type: "A20N", qty_firm: 12, qty_options: 0,
        announced_on: "2024-05-22", note: "part of the 51-aircraft order; deliveries from 2027" },
      { manufacturer: "AIRBUS", type_code: "A321neo",  icao_type: "A21N", qty_firm: 39, qty_options: 0,
        announced_on: "2024-05-22", note: "part of the 51-aircraft order; 240 seats vs 186 on the A320" },
      { manufacturer: "AIRBUS", type_code: "A330-900", icao_type: "A339", qty_firm: 10, qty_options: 0,
        announced_on: "2025-04-01",
        note: "ordered by Saudia Group for flyadeal; phased induction from 2027, first widebodies for the carrier" },
    ],
  },
};

/** Which operator does this registration belong to? Identity only — says
 *  nothing about whether the aircraft has been delivered. */
export function operatorOfReg(reg) {
  if (!reg) return null;
  for (const op of Object.values(OPERATORS)) {
    if (op.regSeries.test(reg)) return op.id;
  }
  return null;
}

/**
 * Delivery ferries fly under the operator's own ICAO designator with a high
 * block number — Riyadh Air used RXI9901 for both HZ-RXAF on 3 July 2026 and
 * HZ-RXAG on 29 July. That is emphatically not a revenue flight, and reading
 * it as one collapses DELIVERY and SERVICE into a single event: every
 * aircraft would "enter service" on the very flight that delivers it, and the
 * distinction the tracker exists to draw would disappear.
 *
 * The 99xx block is the convention across all four carriers for ferry and
 * positioning work. Treated as delivery, never as service.
 */
export const FERRY_CALLSIGN = /^[A-Z]{3}99\d{2}$/;

export const isFerryCallsign = (cs) =>
  FERRY_CALLSIGN.test((cs ?? "").trim().toUpperCase());

/** Which operator does this callsign belong to? A match means the aircraft
 *  is flying commercially — it has been handed over. */
export function operatorOfCallsign(callsign) {
  const cs = (callsign ?? "").trim().toUpperCase();
  if (!cs) return null;
  for (const op of Object.values(OPERATORS)) {
    if (op.callsign.test(cs)) return op.id;
  }
  return null;
}

/** Every Saudi airport any of these carriers takes delivery into. */
export const DELIVERY_DESTS = [
  ...new Set(Object.values(OPERATORS).flatMap((o) => o.bases)),
];

export const backlogOf = (id) =>
  OPERATORS[id].orders.reduce((n, o) => n + o.qty_firm, 0);

export const TOTAL_BACKLOG = Object.keys(OPERATORS).reduce(
  (n, id) => n + backlogOf(id), 0);
