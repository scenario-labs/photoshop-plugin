"use strict";
// The panel's cards for agent requests (SPEC 6.3, 6.6; wireframes 10, 13):
// spend (an approval card), upload (the first upload from a document,
// chosen file or saved result in a client session) and proposal (applying a
// result while Agents may modify the document is off).
//
// A client session has one card showing at a time: its later requests wait
// behind it, and the card offers Decline all from <client>. A card expires
// 10 minutes after it shows, or when its session ends. Each card carries
// its own outcomes: approve() (Approve, Allow or Apply), decline(why) with
// why "declined", "expired" or "session".
//
// Also the activity log of SPEC 6.6 (Settings > Agents): the last 200 agent
// actions, in memory, with the client's name.

var EXPIRE_MS = 600000;
var LOG_MAX = 200;

// o: { timers {setTimeout, clearTimeout, now}, log }
function createApprovals(o) {
  var timers = o.timers;
  var now = timers.now || function () {
    return Date.now();
  };
  var log = o.log || function () {};
  var cards = [];
  var seq = 0;
  var listeners = [];
  var activity = [];

  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i]();
      } catch (e) {
        log("cards: a listener failed: " + e.message);
      }
    }
  }

  function find(id) {
    for (var i = 0; i < cards.length; i++) if (cards[i].id === id) return cards[i];
    return null;
  }

  // The card showing for a session: the oldest one.
  function head(session) {
    for (var i = 0; i < cards.length; i++) if (cards[i].session === session) return cards[i];
    return null;
  }

  function arm(card) {
    if (card.shown_at) return;
    card.shown_at = now();
    card.expires_at = card.shown_at + EXPIRE_MS;
    card.timer = timers.setTimeout(function () {
      settle(card, "expired");
    }, EXPIRE_MS);
  }

  function armHeads() {
    var seen = {};
    for (var i = 0; i < cards.length; i++) {
      if (seen[cards[i].session]) continue;
      seen[cards[i].session] = true;
      arm(cards[i]);
    }
  }

  function remove(card) {
    var at = cards.indexOf(card);
    if (at < 0) return false;
    cards.splice(at, 1);
    if (card.timer) timers.clearTimeout(card.timer);
    armHeads();
    notify();
    return true;
  }

  // Ends a card without approval: its decline outcome runs once.
  function settle(card, why) {
    if (!remove(card)) return Promise.resolve(null);
    return Promise.resolve()
      .then(function () {
        return card.onDecline ? card.onDecline(why) : null;
      })
      .catch(function (e) {
        log("cards: " + card.kind + " " + why + " failed: " + ((e && e.message) || e));
      });
  }

  // card: { kind, session, client_name, title, lines, price_label,
  //         approve_label, data, onApprove() -> {keep: true, update} | any,
  //         onDecline(why) }
  function add(card) {
    seq++;
    card.id = "card" + seq;
    card.created_at = now();
    card.shown_at = null;
    card.busy = false;
    cards.push(card);
    armHeads();
    notify();
    return card.id;
  }

  // Approve, Allow or Apply. The outcome may ask to keep the card (a price
  // that changed on Approve shows the new one and needs a new click).
  async function approve(id) {
    var card = find(id);
    if (!card || card.busy) return null;
    if (!head(card.session) || head(card.session).id !== id) return null;
    card.busy = true;
    notify();
    var out;
    try {
      out = card.onApprove ? await card.onApprove() : null;
    } catch (e) {
      card.busy = false;
      card.error = (e && e.message) || String(e);
      notify();
      throw e;
    }
    card.busy = false;
    if (out && out.keep) {
      if (out.update) for (var k in out.update) card[k] = out.update[k];
      notify();
      return out;
    }
    remove(card);
    return out;
  }

  function decline(id) {
    var card = find(id);
    if (!card || card.busy) return Promise.resolve(null);
    return settle(card, "declined");
  }

  // Decline all from <client>: every card of that session.
  function declineAll(session) {
    var list = cards.filter(function (c) {
      return c.session === session && !c.busy;
    });
    return Promise.all(
      list.map(function (c) {
        return settle(c, "declined");
      })
    );
  }

  // SPEC 2.6, Client sessions: cards of ended sessions expire.
  function endSessions(ids) {
    var list = cards.filter(function (c) {
      return ids.indexOf(c.session) >= 0;
    });
    return Promise.all(
      list.map(function (c) {
        return settle(c, "session");
      })
    );
  }

  // Withdraws a card with no outcome (the agent withdrew the request, or a
  // proposal's canvas changed and its own handler ran).
  function drop(match) {
    var list = cards.filter(match);
    for (var i = 0; i < list.length; i++) remove(list[i]);
    return list.length;
  }

  function expire(match, why) {
    var list = cards.filter(match);
    return Promise.all(
      list.map(function (c) {
        return settle(c, why || "expired");
      })
    );
  }

  // What the panel shows: the head card of each session, oldest first,
  // with how many wait behind it.
  function showing() {
    var out = [];
    var seen = {};
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (seen[c.session]) {
        seen[c.session].waiting++;
        continue;
      }
      var view = { id: c.id, kind: c.kind, session: c.session, client_name: c.client_name, title: c.title, lines: (c.lines || []).slice(), price_label: c.price_label || null, approve_label: c.approve_label, decline_label: c.decline_label || null, note: c.note || null, error: c.error || null, busy: c.busy, disabled: c.disabled ? c.disabled() : null, expires_at: c.expires_at, waiting: 0, data: c.data || null };
      seen[c.session] = view;
      out.push(view);
    }
    return out;
  }

  function record(entry) {
    entry.at = new Date(now()).toISOString();
    activity.unshift(entry);
    if (activity.length > LOG_MAX) activity.length = LOG_MAX;
    notify();
  }

  return {
    add: add,
    approve: approve,
    decline: decline,
    declineAll: declineAll,
    endSessions: endSessions,
    drop: drop,
    expire: expire,
    showing: showing,
    pending: function (match) {
      return cards.filter(match || function () {
        return true;
      }).length;
    },
    record: record,
    activity: function () {
      return activity.slice();
    },
    onChange: function (fn) {
      listeners.push(fn);
    },
    EXPIRE_MS: EXPIRE_MS
  };
}

module.exports = { createApprovals: createApprovals, EXPIRE_MS: EXPIRE_MS };
