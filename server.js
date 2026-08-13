require("dotenv").config();
const express = require("express");
const app = express();
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const axios = require("axios");
const tracking = require("./tracking"); // ✅ NEW


const allowedOrigins = [
  "https://luxenordique.com",
  "https://www.luxenordique.com",
  "https://gerlak.pl",
  "https://www.gerlak.pl"
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});


// ✅ Disable caching so Railway doesn’t block fetch
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});


// ✅ NEW — trust Railway's proxy so req.ip / x-forwarded-for give the real customer IP
app.set("trust proxy", true);


// ✅ NEW — in-memory guard so the same Stripe session can never create two Shopify orders.
// Covers Stripe retries and the completed / async_payment_succeeded overlap.
const processedSessions = new Set();
function claimSession(sessionId) {
  if (processedSessions.has(sessionId)) return false;
  processedSessions.add(sessionId);
  if (processedSessions.size > 5000) {
    processedSessions.delete(processedSessions.values().next().value);
  }
  return true;
}


// ✅ NEW — turn the browser's attribution payload into Stripe session metadata.
// Stripe then carries it all the way to the webhook, so tracking no longer
// depends on the customer's browser coming back from the BLIK app.
function buildAttributionMetadata(attr, req) {
  const a = attr || {};
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = forwarded || req.ip || "";

  const raw = {
    gclid: a.gclid,
    gbraid: a.gbraid,
    wbraid: a.wbraid,
    fbp: a.fbp,
    fbc: a.fbc,
    ga_client_id: a.ga_client_id,
    ga_session_id: a.ga_session_id,
    utm_source: a.utm_source,
    utm_medium: a.utm_medium,
    utm_campaign: a.utm_campaign,
    utm_content: a.utm_content,
    client_ip: ip,
    client_ua: req.headers["user-agent"] || ""
  };

  const out = {};
  Object.keys(raw).forEach((k) => {
    const v = raw[k];
    if (v !== undefined && v !== null && String(v).length > 0) {
      out[k] = String(v).slice(0, 480); // Stripe metadata limit is 500 chars
    }
  });
  return out;
}



app.get("/status", async (req, res) => {
  const status = {
    server: "UP",
    stripe: "UNKNOWN",
  };

  // 1) Check Stripe availability
  try {
    await stripe.balance.retrieve();
    status.stripe = "UP";
  } catch (err) {
    console.error("Stripe status error:", err.message);
    status.stripe = "DOWN";
  }
  res.json(status);
});



// Handle webhook before express.json()
app.post("/webhook", express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("❌ Webhook Error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ✅ CHANGED — acknowledge Stripe immediately.
  // A slow Shopify API call used to keep this request open; if it passed
  // Stripe's timeout, Stripe retried and a second order could be created.
  res.status(200).send('Webhook received');

  if (
    event.type !== 'checkout.session.completed' &&
    event.type !== 'checkout.session.async_payment_succeeded' // ✅ NEW — late-settling BLIK
  ) {
    return;
  }

  const rawSession = event.data.object;

  // ✅ NEW — never create an order for a session that isn't actually paid.
  if (rawSession.payment_status !== 'paid' && rawSession.payment_status !== 'no_payment_required') {
    console.warn("⏳ SESSION NOT PAID — no order created:", rawSession.id, "status:", rawSession.payment_status);
    return;
  }

  // ✅ NEW — duplicate guard
  if (!claimSession(rawSession.id)) {
    console.log("↩️ Duplicate webhook ignored:", rawSession.id);
    return;
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(rawSession.id, {
      expand: ['line_items.data.price.product', 'shipping_cost.shipping_rate', 'shipping'],
    });

    console.log("✅ Payment successful. Session ID:", session.id);

    // ✅ NEW — fire server-side conversions. Deliberately not awaited and
    // fully self-contained: tracking can never delay or break the order.
    Promise.allSettled([
      tracking.sendMetaCAPI(session),
      tracking.sendGA4Purchase(session)
    ]).catch(() => {});

    await createShopifyOrder(session);
  } catch (err) {
    console.error("❌ Failed to retrieve full session:", err.message);
  }
});


// After webhook, now apply json parser
app.use(express.json());


async function createShopifyOrder(session) {
  console.log("Creating LIVE Shopify order for session:", session.id);
  const isPolish = session.locale === 'pl';

  async function ensureFullSession(retries = 2, delayMs = 500) {
    let s = session;
    for (let attempt = 0; attempt <= retries; attempt++) {
      // If shipping address exists, break early
      if (s.shipping?.address) break;

      if (attempt > 0) {
        console.warn(`Retrying session fetch for shipping address (attempt ${attempt})`);
        await new Promise(r => setTimeout(r, delayMs));
      }

      try {
        s = await stripe.checkout.sessions.retrieve(session.id, {
          expand: ['line_items.data.price.product', 'shipping_cost.shipping_rate', 'shipping', 'customer_details'],
        });
      } catch (e) {
        console.warn("Failed to re-fetch Stripe session:", e.message);
      }
    }
    return s;
  }

  // ensure we have the latest session with shipping populated
  session = await ensureFullSession();

  const shipping = session.shipping || {};
  const customerDetails = session.customer_details || {};
  const shippingAddress = shipping.address || customerDetails.address || {};

  if (!shipping.address) {
    console.warn("⚠️ Missing shipping.address in Stripe session. Falling back to customerDetails.address if available.", {
      sessionId: session.id,
      shipping,
      customerDetails
    });
  }


  const fullName = shipping.name || customerDetails.name || "";
  const [firstName = "", ...rest] = fullName.split(" ");
  const lastName = rest.join(" ") || "";



  // ✅ Retrieve line items from Stripe session
  let lineItems = [];

  try {
    const sessionWithItems = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ['line_items.data.price.product']
    });

    lineItems = sessionWithItems.line_items.data.map(item => {
      const metadata = item?.price?.product?.metadata || item?.price?.metadata || {};
      const variantId = metadata.variant_id || null;


      return {
        name: item.description || "Item",
        quantity: item.quantity || 1,
        price: item.amount_total / item.quantity / 100 || 0,
        size: metadata.size || 'N/A',
        color: metadata.color || 'N/A',
        variant_id: variantId,
      };
    });

  } catch (err) {
    console.warn("⚠️ Failed to expand line_items:", err.message);
    lineItems = [{
      name: "Stripe BLIK Order",
      quantity: 1,
      price: session.amount_total / 100,
      properties: {
        Size: "N/A",
        Color: "N/A",
      },
    }];
  }

  // ✅ Format Shopify order
  const orderData = {

    order: {
      email: customerDetails.email,
      financial_status: "paid",
      send_receipt: true,
      send_fulfillment_receipt: false,
      line_items: lineItems.map(item => {
        const lineItem = {
          quantity: item.quantity,
          price: item.price,
        };

        if (item.variant_id) {
          lineItem.variant_id = item.variant_id;
        } else {
          lineItem.title = item.name;
          lineItem.properties = {
            Size: item.size,
            Color: item.color,
          };
        }

        return lineItem;
      }),

      shipping_address: {
        first_name: firstName,
        last_name: lastName,
        address1: shippingAddress.line1 || '',
        address2: shippingAddress.line2 || '',
        city: shippingAddress.city || '',
        province: shippingAddress.state || '',
        zip: shippingAddress.postal_code || '',
        country: shippingAddress.country || '',
        phone: customerDetails.phone || '',
      },
      billing_address: {
        first_name: firstName,
        last_name: lastName,
        address1: shippingAddress.line1 || '',
        address2: shippingAddress.line2 || '',
        city: shippingAddress.city || '',
        province: shippingAddress.state || '',
        zip: shippingAddress.postal_code || '',
        country: shippingAddress.country || '',
        phone: customerDetails.phone || '',
      },
      note: isPolish
        ? "Zapłacono przez Stripe (BLIK)"
        : "Paid via Stripe (BLIK)",
      // ✅ NEW — stamps the Stripe session and campaign source onto the order
      // so you can reconcile Shopify against Stripe and Google Ads by hand.
      note_attributes: [
        { name: "stripe_session_id", value: String(session.id) },
        { name: "utm_source", value: String(session.metadata?.utm_source || "") },
        { name: "utm_campaign", value: String(session.metadata?.utm_campaign || "") },
        { name: "gclid", value: String(session.metadata?.gclid || "") }
      ],
      tags: ["BLIK"],
      shipping_lines: [
        {
          title: session.shipping_cost?.shipping_rate?.display_name || (
            isPolish
              ? "DPD – Dostawa standardowa (3–8 dni roboczych)"
              : "DPD – Standard Shipping (3–8 business days)"
          ),
          price: session.shipping_cost?.shipping_rate?.fixed_amount?.amount / 100 || 0,
          code: "standard_shipping"
        }
      ],
    },
  };

  try {
    const response = await axios.post(
      `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2023-01/orders.json`,
      orderData,
      {
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log("✅ Live Shopify order created:", response.data.order.id);
  } catch (error) {
    console.error("❌ Shopify Order Creation Error:", error.response?.data || error.message);
    throw new Error("Failed to create Shopify order");
  }
}



app.post("/create-checkout-session", async (req, res) => {
  // ✅ CHANGED — accept the optional attribution object from the cart drawer
  const { items, customer_email, total_amount, language = 'en', attribution = {} } = req.body;
  const isPolish = language.startsWith('pl');

  if (!items || items.length === 0 || !total_amount) {
    return res.status(400).json({ error: isPolish ? "Brakujące przedmioty lub suma." : "Missing items or total amount." });
  }

  const sessionData = {
    payment_method_types: ['blik'],
    mode: 'payment',
    customer_creation: 'always',
    locale: isPolish ? 'pl' : 'en',

    // ✅ NEW — attribution rides along with the payment
    metadata: buildAttributionMetadata(attribution, req),

    shipping_address_collection: {
      allowed_countries: ['PL', 'GB', 'US'],
    },
    billing_address_collection: 'required',
    phone_number_collection: { enabled: true },
    custom_text: {
      submit: {
        message: isPolish ? 'Zapłać kodem BLIK' : 'Pay with your BLIK code'
      },
      shipping_address: {
        message: isPolish ? 'Dostawa dostępna tylko w Polsce' : 'Shipping available only to Poland'
      }
    },

    // ✅ SHIPPING OPTIONS (corrected logic)
    shipping_options: (() => {
      const options = [];

      const standardShipping = {
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: {
            amount: total_amount >= 17000 ? 0 : 1800,
            currency: 'pln'
          },
          display_name: isPolish
            ? 'DPD – Dostawa standardowa (3–8 dni roboczych)'
            : 'DPD – Standard Shipping (3–8 business days)',
          delivery_estimate: {
            minimum: { unit: 'business_day', value: 3 },
            maximum: { unit: 'business_day', value: 8 }
          }
        }
      };

      const expressShipping = {
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: { amount: 3500, currency: 'pln' },
          display_name: isPolish
            ? 'DPD – Dostawa ekspresowa (2–5 dni roboczych)'
            : 'DPD – Express Shipping (2–5 business days)',
          delivery_estimate: {
            minimum: { unit: 'business_day', value: 2 },
            maximum: { unit: 'business_day', value: 5 }
          }
        }
      };

      options.push(standardShipping, expressShipping);
      return options;
    })(),

    // ✅ Product metadata correctly passed
    line_items: items.map(item => ({
      price_data: {
        currency: 'pln',
        unit_amount: item.unit_amount,
        product_data: {
          name: item.name,
          metadata: {
            size: item.size || 'N/A',
            color: item.color || 'N/A',
            variant_id: item.variant_id || '',
          }
        }
      },
      quantity: item.quantity,
    })),

    success_url: `https://gerlak.pl/pages/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: 'https://gerlak.pl/cart',
  };

  if (customer_email && customer_email.includes('@')) {
    sessionData.customer_email = customer_email;
  }

  try {
    const session = await stripe.checkout.sessions.create(sessionData);
    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe Checkout Error:", err);
    res.status(500).json({
      error: isPolish ? "Błąd podczas tworzenia płatności" : "Error creating payment"
    });
  }
});




app.get("/order-details", async (req, res) => {
  const sessionId = req.query.session_id;

  if (!sessionId) {
    return res.status(400).json({ error: "Missing session_id" });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items', 'shipping_cost.shipping_rate', 'shipping'],
    });

    const isPolish = session.locale === 'pl';
    const shippingRate = session.shipping_cost?.shipping_rate;
    const shippingAmount = shippingRate?.fixed_amount?.amount || 0;

    const shippingMethodName = (() => {
      if (!shippingRate) return isPolish ? 'Nie wybrano' : 'Not selected';

      const name = shippingRate.display_name?.toLowerCase() || "";

      if (name.includes('standardowa') || name.includes('standard')) {
        return isPolish
          ? 'DPD – Dostawa standardowa (3–8 dni roboczych)'
          : 'DPD – Standard Shipping (3–8 business days)';
      }

      if (name.includes('ekspresowa') || name.includes('express')) {
        return isPolish
          ? 'DPD – Dostawa ekspresowa (2–5 dni roboczych)'
          : 'DPD – Express Shipping (2–5 business days)';
      }

      return shippingRate.display_name || (isPolish ? 'Nieznana opcja' : 'Unknown option');
    })();
    res.json({
      customer_email: session.customer_details?.email || 'Not provided',
      amount_total: session.amount_total,
      shipping_option: shippingMethodName,
      shipping_cost: shippingAmount === 0
        ? (isPolish ? 'DARMOWA' : 'FREE')
        : `zł ${(shippingAmount / 100).toFixed(2).replace('.', ',')}`,
      shipping_address: session.shipping?.address || 'Not provided',
      payment_status: session.payment_status,
      items: session.line_items?.data.map(item => ({
        description: item.description,
        quantity: item.quantity
      })) || [],
    });
  } catch (err) {
    console.error("Order fetch error:", err);
    res.status(500).json({ error: "Failed to retrieve order details" });
  }
});


/* ================================================================== */
/* ✅ NEW — Google Ads offline conversion CSV                          */
/* Google Ads fetches this URL on a schedule. Stripe is the database:  */
/* every paid session already stores its gclid in metadata.            */
/* ================================================================== */

app.get("/google-conversions.csv", async (req, res) => {
  if (!process.env.CSV_SECRET || req.query.key !== process.env.CSV_SECRET) {
    return res.status(403).send("Forbidden");
  }

  const hours = Math.min(parseInt(req.query.hours, 10) || 30, 720);
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const conversionName = process.env.GOOGLE_CONVERSION_NAME || "BLIK Purchase Server";

  const rows = [
    "Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency"
  ];

  try {
    for await (const s of stripe.checkout.sessions.list({
      created: { gte: since },
      limit: 100
    })) {
      if (s.payment_status !== "paid") continue;
      const gclid = (s.metadata && s.metadata.gclid) || "";
      if (!gclid) continue;

      rows.push([
        tracking.csvEscape(gclid),
        tracking.csvEscape(conversionName),
        tracking.csvEscape(tracking.googleAdsTime(s.created)),
        tracking.csvEscape(((s.amount_total || 0) / 100).toFixed(2)),
        tracking.csvEscape(String(s.currency || "pln").toUpperCase())
      ].join(","));
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.status(200).send(rows.join("\n") + "\n");
  } catch (err) {
    console.error("❌ CSV build error:", err.message);
    res.status(500).send("Error building CSV");
  }
});


/* ✅ NEW — diagnostic. Tells you what share of paid orders carry attribution. */
app.get("/attribution-health", async (req, res) => {
  if (!process.env.CSV_SECRET || req.query.key !== process.env.CSV_SECRET) {
    return res.status(403).send("Forbidden");
  }

  const days = Math.min(parseInt(req.query.days, 10) || 7, 30);
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  const stats = {
    days,
    paid_sessions: 0,
    with_gclid: 0,
    with_gbraid_or_wbraid: 0,
    with_meta_cookies: 0,
    with_ga_client_id: 0,
    with_no_attribution: 0
  };

  try {
    for await (const s of stripe.checkout.sessions.list({
      created: { gte: since },
      limit: 100
    })) {
      if (s.payment_status !== "paid") continue;
      const m = s.metadata || {};
      stats.paid_sessions++;
      if (m.gclid) stats.with_gclid++;
      if (m.gbraid || m.wbraid) stats.with_gbraid_or_wbraid++;
      if (m.fbp || m.fbc) stats.with_meta_cookies++;
      if (m.ga_client_id) stats.with_ga_client_id++;
      if (!m.gclid && !m.gbraid && !m.wbraid && !m.fbp && !m.fbc) stats.with_no_attribution++;
    }
    res.json(stats);
  } catch (err) {
    console.error("❌ Attribution health error:", err.message);
    res.status(500).json({ error: "Failed" });
  }
});


app.get("/", (req, res) => {
  res.send("✅ Shopify Stripe backend is working!");
});

// ✅ Health check endpoint (add this before app.listen)
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    message: "Server is healthy and ready",
    time: new Date().toISOString(),
  });
});

// Keep the backend awake so the first BLIK tap is instant (never sleeps)
setInterval(() => {
  axios
    .get("https://shopify-backend-production-fdfe.up.railway.app/health")
    .catch(() => {});
}, 240000); // pings itself every 4 minutes

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server is running on port ${process.env.PORT || 3000}`);
});
