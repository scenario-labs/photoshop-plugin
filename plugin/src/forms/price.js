"use strict";
// Prices (SPEC 3.7 and 6.1 item 6). CU amounts are held as integer
// thousandths, so sums and comparisons are exact. The exact string an agent
// must repeat in approved_cost has no trailing zeros ("2", "2.5", "0.125").
// The panel shows up to three decimals; from 10,000 it shows K and M with
// three significant digits.

function toThousandths(cu) {
  if (typeof cu !== "number" || !isFinite(cu) || cu < 0) throw new RangeError("not a CU amount");
  return Math.round(cu * 1000);
}

function exactString(t) {
  var whole = Math.floor(t / 1000);
  var frac = t % 1000;
  if (!frac) return String(whole);
  var f = String(frac);
  while (f.length < 3) f = "0" + f;
  return whole + "." + f.replace(/0+$/, "");
}

function stripZeros(s) {
  return s.indexOf(".") >= 0 ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

function display(t) {
  var cu = t / 1000;
  if (cu < 10000) return exactString(t);
  var k = Number((cu / 1000).toPrecision(3));
  if (k < 1000) return stripZeros((cu / 1000).toPrecision(3)) + "K";
  return stripZeros((cu / 1000000).toPrecision(3)) + "M";
}

// kind: exact | range | from. max: thousandths, for a range. An exact
// price of nothing reads "Free".
function label(kind, t, max) {
  if (kind === "range") return display(t) + " to " + display(max) + " CU";
  if (kind === "from") return "from " + display(t) + " CU";
  if (t === 0) return "Free";
  return display(t) + " CU";
}

module.exports = { toThousandths: toThousandths, exactString: exactString, display: display, label: label };
