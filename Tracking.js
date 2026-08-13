// tracking.js
// Server-side conversion tracking for Gerlak BLIK checkout.
// IMPORTANT: every function here swallows its own errors and returns.
// Nothing in this file can ever throw into the Shopify order-creation path.

const crypto = require("crypto");
const axios = require("axios");

const META_API_VERSION = process.env.META_API_VERSION || "v21.0";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function sha256(value) {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim().toLowerCase();
  if (!s) return undefined;
  return crypto.createHash("sha256").update(s).digest("hex");
}

// Meta wants E.164 digits only, no plus sign. Polish mobiles are 9 digits.
function normalizePhone(phone) {
  if (!phone) return undefined;
  let d = String(phone).replace(/\D/g, "");
  if (!d) return undefined;
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 9) d = "48" + d;
  return d;
}

function splitName(fullName) {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || "", last: parts.slice(1).join(" ") || "" };
}

function lineItemsOf(session) {
  try {
    const data = session && session.line_items && session.line_items.data;
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

function itemIdOf(item, index) {
  try {
    const meta =
      (item.price && item.price.product && item.price.product.metadata) ||
      (item.price && item.price.metadata) ||
      {};
    return String(meta.variant_id || item.description || "item-" + index);
  } catch (e) {
    return "item-" + index;
  }
}

/* ------------------------------------------------------------------ */
/* Meta Conversions API                                                */
/* ------------------------------------------------------------------ */

async function sendMetaCAPI(session) {
  try {
    const token = process.env.META_ACCESS_TOKEN;
    const pixelId = process.env.META_PIXEL_ID;
    if (!token || !pixelId) return;

    const m = session.metadata || {};
    const cd = session.customer_details || {};
    const shipping = session.shipping || {};
    const addr = shipping.address || cd.address || {};
    const name = splitName(shipping.name || cd.name);

    const userData = {
      em: sha256(cd.email),
      ph: sha256(normalizePhone(cd.phone)),
      fn: sha256(name.first),
      ln: sha256(name.last),
      ct: sha256(addr.city),
      st: sha256(addr.state),
      zp: sha256(addr.postal_code),
      country: sha256(addr.country),
    };
    if (m.fbp) userData.fbp = m.fbp;
    if (m.fbc) userData.fbc = m.fbc;
    if (m.client_ip) userData.client_ip_address = m.client_ip;
    if (m.client_ua) userData.client_user_agent = m.client_ua;
    Object.keys(userData).forEach(function (k) {
      if (userData[k] === undefined) delete userData[k];
    });

    const items = lineItemsOf(session);
    const contents = items.map(function (it, i) {
      return {
        id: itemIdOf(it, i),
        quantity: it.quantity || 1,
        item_price: (it.amount_total || 0) / 100 / (it.quantity || 1),
      };
    });

    const customData = {
      currency: String(session.currency || "pln").toUpperCase(),
      value: (session.amount_total || 0) / 100,
    };
    if (contents.length) {
      customData.contents = contents;
      customData.content_type = "product";
      customData.num_items = contents.reduce(function (t, c) {
        return t + (c.quantity || 1);
      }, 0);
    }

    const payload = {
      data: [
        {
          event_name: "Purchase",
          event_time: Math.floor(Date.now() / 1000),
          // Must match the browser pixel's eventID so Meta deduplicates.
          event_id: session.id,
          event_source_url: "https://gerlak.pl/pages/success",
          action_source: "website",
          user_data: userData,
          custom_data: customData,
        },
      ],
    };
    if (process.env.META_TEST_EVENT_CODE) {
      payload.test_event_code = process.env.META_TEST_EVENT_CODE;
    }

    const url =
      "https://graph.facebook.com/" +
      META_API_VERSION +
      "/" +
      pixelId +
      "/events?access_token=" +
      encodeURIComponent(token);

    const res = await axios.post(url, payload, { timeout: 8000 });
    console.log(
      "📤 Meta CAPI ok:",
      session.id,
      "received=" + (res.data && res.data.events_received)
    );
  } catch (err) {
    console.error(
      "⚠️ Meta CAPI failed (order unaffected):",
      (err.response && JSON.stringify(err.response.data)) || err.message
    );
  }
}

/* ------------------------------------------------------------------ */
/* GA4 Measurement Protocol                                            */
/* ------------------------------------------------------------------ */

async function sendGA4Purchase(session) {
  try {
    if (process.env.ENABLE_GA4_MP !== "true") return;
    const measurementId = process.env.GA4_MEASUREMENT_ID;
    const apiSecret = process.env.GA4_API_SECRET;
    if (!measurementId || !apiSecret) return;

    const m = session.metadata || {};
    const clientId = m.ga_client_id;
    // No client_id means GA4 would invent a brand-new user with no source.
    // That pollutes reporting more than a missing row does. Skip.
    if (!clientId) {
      console.log("↩️ GA4 MP skipped, no ga_client_id:", session.id);
      return;
    }

    const items = lineItemsOf(session).map(function (it, i) {
      return {
        item_id: itemIdOf(it, i),
        item_name: it.description || "Produkt " + (i + 1),
        quantity: it.quantity || 1,
        price: (it.amount_total || 0) / 100 / (it.quantity || 1),
      };
    });

    const params = {
      transaction_id: session.id,
      value: (session.amount_total || 0) / 100,
      currency: String(session.currency || "pln").toUpperCase(),
      engagement_time_msec: 100,
    };
    if (m.ga_session_id) params.session_id = m.ga_session_id;
    if (items.length) params.items = items;

    const url =
      "https://www.google-analytics.com/mp/collect?measurement_id=" +
      encodeURIComponent(measurementId) +
      "&api_secret=" +
      encodeURIComponent(apiSecret);

    await axios.post(
      url,
      { client_id: clientId, events: [{ name: "purchase", params: params }] },
      { timeout: 8000 }
    );
    console.log("📤 GA4 MP ok:", session.id);
  } catch (err) {
    console.error(
      "⚠️ GA4 MP failed (order unaffected):",
      (err.response && JSON.stringify(err.response.data)) || err.message
    );
  }
}

/* ------------------------------------------------------------------ */
/* Google Ads CSV row formatting                                       */
/* ------------------------------------------------------------------ */

// UTC with an explicit offset. Never affected by Poland's DST switch.
function googleAdsTime(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  const p = function (n) {
    return String(n).padStart(2, "0");
  };
  return (
    d.getUTCFullYear() +
    "-" +
    p(d.getUTCMonth() + 1) +
    "-" +
    p(d.getUTCDate()) +
    " " +
    p(d.getUTCHours()) +
    ":" +
    p(d.getUTCMinutes()) +
    ":" +
    p(d.getUTCSeconds()) +
    "+00:00"
  );
}

function csvEscape(value) {
  const s = String(value === undefined || value === null ? "" : value);
  return '"' + s.replace(/"/g, '""') + '"';
}

module.exports = {
  sendMetaCAPI: sendMetaCAPI,
  sendGA4Purchase: sendGA4Purchase,
  googleAdsTime: googleAdsTime,
  csvEscape: csvEscape,
  sha256: sha256,
  normalizePhone: normalizePhone,
};
