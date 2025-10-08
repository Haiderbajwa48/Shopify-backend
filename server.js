require("dotenv").config();
const express = require("express");
const app = express();
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const axios = require("axios");

app.use(
  cors({
    origin: ["https://luxenordique.com"], // your live domain
    methods: ["GET", "POST"],
    credentials: true,
  })
);

// ✅ Disable caching so Railway doesn’t block fetch
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});



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

  if (event.type === 'checkout.session.completed') {
    const rawSession = event.data.object;

    try {
      const session = await stripe.checkout.sessions.retrieve(rawSession.id, {
        expand: ['line_items.data.price.product', 'shipping_cost.shipping_rate', 'shipping'],
      });

      console.log("✅ Payment successful. Session ID:", session.id);
      await createShopifyOrder(session);
    } catch (err) {
      console.error("❌ Failed to retrieve full session:", err.message);
    }
  }

  res.status(200).send('Webhook received');
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
      name: "Stripe P24 Order",
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
        ? "Zapłacono przez Stripe (Przelewy24)"
        : "Paid via Stripe (Przelewy24)",
      tags: isPolish ? ["Przelewy24"] : ["P24"],
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
  const { items, customer_email, total_amount, language = 'en' } = req.body;
  const isPolish = language.startsWith('pl');

  if (!items || items.length === 0 || !total_amount) {
    return res.status(400).json({ error: isPolish ? "Brakujące przedmioty lub suma." : "Missing items or total amount." });
  }

  const sessionData = {
    payment_method_types: ['p24'],
    mode: 'payment',
    customer_creation: 'always',
    locale: isPolish ? 'pl' : 'en',
    shipping_address_collection: {
      allowed_countries: ['PL', 'GB', 'US'],
    },
    billing_address_collection: 'required',
    phone_number_collection: { enabled: true },
    custom_text: {
      submit: {
        message: isPolish ? 'Zostaniesz przekierowany do Przelewy24' : 'You will be redirected to Przelewy24'
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

    success_url: `https://luxenordique.com/pages/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: 'https://luxenordique.com/cart',
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
    
    res.setHeader("Access-Control-Allow-Origin", "https://luxenordique.com");
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


app.get("/", (req, res) => {
  res.send("✅ Shopify Stripe backend is working!");
});

app.listen(3000, () => {
  console.log("Server is running on port 3000");
});
