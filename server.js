const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json());

const STRIPE_KEY = process.env.STRIPE_KEY;
const SQUARE_TOKEN = process.env.SQUARE_TOKEN;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;

// Health check
app.get("/", (req, res) => res.json({ status: "MF Meals Proxy running" }));

// Stripe — fetch all charges
app.get("/stripe/charges", async (req, res) => {
  try {
    let allCharges = [], hasMore = true, startingAfter = null;
    while (hasMore) {
      let url = "https://api.stripe.com/v1/charges?limit=100&expand[]=data.customer";
      if (startingAfter) url += `&starting_after=${startingAfter}`;
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${STRIPE_KEY}` }
      });
      const data = await r.json();
      if (data.error) return res.status(400).json(data);
      allCharges = [...allCharges, ...data.data];
      hasMore = data.has_more;
      if (data.data.length > 0) startingAfter = data.data[data.data.length - 1].id;
    }
    res.json({ charges: allCharges });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Square — fetch all payments
app.get("/square/payments", async (req, res) => {
  try {
    let allPayments = [], cursor = null;
    while (true) {
      let url = "https://connect.squareup.com/v2/payments?limit=100&sort_order=DESC";
      if (cursor) url += `&cursor=${cursor}`;
      const r = await fetch(url, {
        headers: {
          Authorization: `Bearer ${SQUARE_TOKEN}`,
          "Square-Version": "2024-01-18"
        }
      });
      const data = await r.json();
      if (data.errors) return res.status(400).json(data);
      allPayments = [...allPayments, ...(data.payments || [])];
      if (!data.cursor) break;
      cursor = data.cursor;
    }
    res.json({ payments: allPayments });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Shopify — fetch all orders
app.get("/shopify/orders", async (req, res) => {
  try {
    let allOrders = [], page_info = null;
    while (true) {
      let url = `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?status=paid&limit=250`;
      if (page_info) url += `&page_info=${page_info}`;
      const r = await fetch(url, {
        headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN }
      });
      const data = await r.json();
      if (data.errors) return res.status(400).json(data);
      allOrders = [...allOrders, ...(data.orders || [])];
      const link = r.headers.get("link");
      if (link && link.includes('rel="next"')) {
        page_info = link.match(/page_info=([^&>]+).*rel="next"/)?.[1];
        if (!page_info) break;
      } else break;
    }
    res.json({ orders: allOrders });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
