"use strict";
// Charges (SPEC 2.5): the one definition every view and total uses. Amounts
// are kept as integer thousandths of a CU and stored as exact decimal
// strings ("2", "2.5").
//
// - cu_record: billing.cuCost plus the sum of billing.cuCostDetails, read
//   once Scenario gives a final status. Nothing is subtracted for a discount
//   until Scenario says whether cuCost is gross (SPEC 2.5, Discount).
// - cu_discount: billing.cuDiscount. no_refund: billing.disableRefund.
// - cu_charged: null before a final status (shown as the quote only); on
//   success, cu_record; on failed, blocked or canceled, 0 and refunded,
//   unless no_refund, then cu_record; on not_sent, 0 and not refunded.

var price = require("../forms/price.js");

function t(v) {
  return typeof v === "number" && isFinite(v) && v >= 0 ? price.toThousandths(v) : null;
}

function str(thousandths) {
  return thousandths === null || thousandths === undefined ? null : price.exactString(thousandths);
}

function parse(s) {
  if (typeof s !== "string" || !/^\d+(\.\d{1,3})?$/.test(s)) return null;
  var parts = s.split(".");
  var frac = (parts[1] || "") + "000";
  return Number(parts[0]) * 1000 + Number(frac.slice(0, 3));
}

// read: a job read (scenario/jobs-api.js readJob). state: the plugin status.
// Returns the charge fields to merge into the ledger record. no_refund
// copies the job's billing.disableRefund; the model's own flag only shows
// before the spend.
function settle(state, read) {
  var base = read ? t(read.cu_cost) : null;
  var record = base === null ? null : base + (t(read.cu_cost_details) || 0);
  var noRefund = !!(read && read.disable_refund);
  var out = {
    cu_record: str(record),
    cu_discount: read ? str(t(read.cu_discount)) : null,
    no_refund: noRefund,
    cu_charged: null,
    refunded: false
  };
  if (state === "succeeded" || state === "downloading" || state === "ready" || state === "applying" || state === "applied" || state === "apply_failed" || state === "download_failed") {
    out.cu_charged = str(record);
  } else if (state === "failed" || state === "blocked" || state === "canceled") {
    if (noRefund) out.cu_charged = str(record);
    else {
      out.cu_charged = "0";
      out.refunded = true;
    }
  }
  return out;
}

function notSent() {
  return { cu_charged: "0", refunded: false };
}

// The words Jobs shows for a record's price (SPEC 2.5).
function words(rec) {
  var quoted = rec.cu_quoted ? (rec.price_kind === "range" && rec.cu_quoted_max ? rec.cu_quoted + " to " + rec.cu_quoted_max : rec.price_kind === "from" ? "from " + rec.cu_quoted : rec.cu_quoted) : null;
  if (rec.state === "not_sent") return "Nothing charged";
  if (rec.cu_charged === null || rec.cu_charged === undefined) return quoted ? "quoted " + quoted + " CU" : "";
  if (rec.refunded) return "Refunded by Scenario";
  if ((rec.state === "failed" || rec.state === "blocked" || rec.state === "canceled") && rec.no_refund) return "Charged " + rec.cu_charged + " CU, no refund on failure";
  return quoted ? "quoted " + quoted + ", charged " + rec.cu_charged + " CU" : "charged " + rec.cu_charged + " CU";
}

// True when the charge is above its quote (M for a range), in thousandths.
function aboveQuote(rec) {
  var charged = parse(rec.cu_charged);
  var quoted = parse(rec.price_kind === "range" && rec.cu_quoted_max ? rec.cu_quoted_max : rec.cu_quoted);
  return charged !== null && quoted !== null && charged > quoted;
}

// The sum of cu_charged over records, as an exact string.
function total(records) {
  var sum = 0;
  for (var i = 0; i < records.length; i++) {
    var v = parse(records[i].cu_charged);
    if (v !== null) sum += v;
  }
  return price.exactString(sum);
}

module.exports = { settle: settle, notSent: notSent, words: words, aboveQuote: aboveQuote, total: total, parse: parse };
