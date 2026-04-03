const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type", "Accept"] }));
app.use(express.json());

const STRIPE_KEY = process.env.STRIPE_KEY;
const SQUARE_TOKEN = process.env.SQUARE_TOKEN;
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;

const fmtDate = d => `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}`;

const getDeliverySunday = (created) => {
  const d = new Date(created * 1000);
  const day = d.getDay();
  let daysToSun;
  if (day === 5) daysToSun = 9;
  else if (day === 6) daysToSun = 8;
  else if (day === 0) daysToSun = 7;
  else if (day === 1) daysToSun = 6;
  else if (day === 2) daysToSun = 5;
  else if (day === 3) daysToSun = 4;
  else daysToSun = 3;
  const sun = new Date(d);
  sun.setDate(d.getDate() + daysToSun);
  return fmtDate(sun);
};

app.get("/", (req, res) => res.json({ status: "MF Meals Proxy running" }));

// Stripe — daily net totals (after fees)
app.get("/stripe/daily", async (req, res) => {
  try {
    const since = req.query.since ? parseInt(req.query.since) : null;
    let all = [], hasMore = true, startingAfter = null;
    while (hasMore) {
      let url = "https://api.stripe.com/v1/balance_transactions?limit=100&type=charge";
      if (since) url += `&created[gte]=${since}`;
      if (startingAfter) url += `&starting_after=${startingAfter}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${STRIPE_KEY}` } });
      const data = await r.json();
      if (data.error) return res.status(400).json(data);
      all = [...all, ...data.data];
      hasMore = data.has_more;
      if (data.data.length > 0) startingAfter = data.data[data.data.length - 1].id;
    }
    const byDay = {};
    all.forEach(txn => {
      const d = new Date(txn.created * 1000);
      const dateStr = fmtDate(d);
      const deliverySunday = getDeliverySunday(txn.created);
      if (!byDay[dateStr]) byDay[dateStr] = { date: dateStr, total: 0, created: txn.created, deliverySunday };
      byDay[dateStr].total += txn.net / 100;
    });
    let refundAll = [], refundHasMore = true, refundStartingAfter = null;
    while (refundHasMore) {
      let url = "https://api.stripe.com/v1/balance_transactions?limit=100&type=refund";
      if (since) url += `&created[gte]=${since}`;
      if (refundStartingAfter) url += `&starting_after=${refundStartingAfter}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${STRIPE_KEY}` } });
      const data = await r.json();
      if (data.error) break;
      refundAll = [...refundAll, ...data.data];
      refundHasMore = data.has_more;
      if (data.data.length > 0) refundStartingAfter = data.data[data.data.length - 1].id;
    }
    refundAll.forEach(txn => {
      const d = new Date(txn.created * 1000);
      const dateStr = fmtDate(d);
      const deliverySunday = getDeliverySunday(txn.created);
      if (!byDay[dateStr]) byDay[dateStr] = { date: dateStr, total: 0, created: txn.created, deliverySunday };
      byDay[dateStr].total += txn.net / 100;
    });
    const daily = Object.values(byDay)
      .filter(d => d.total > 0)
      .sort((a, b) => a.created - b.created);
    res.json({ daily, totalDays: daily.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Square — daily totals (gross for now)
app.get("/square/daily", async (req, res) => {
  try {
    let all = [], cursor = null;
    while (true) {
      let url = "https://connect.squareup.com/v2/payments?limit=100&sort_order=ASC";
      if (cursor) url += `&cursor=${cursor}`;
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${SQUARE_TOKEN}`, "Square-Version": "2024-01-18" }
      });
      const data = await r.json();
      if (data.errors) return res.status(400).json(data);
      all = [...all, ...(data.payments || [])];
      if (!data.cursor) break;
      cursor = data.cursor;
    }
    const paid = all.filter(p => p.status === "COMPLETED" && p.amount_money?.amount > 0);
    const byDay = {};
    paid.forEach(p => {
      const d = new Date(p.created_at);
      const dateStr = fmtDate(d);
      if (!byDay[dateStr]) byDay[dateStr] = { date: dateStr, total: 0 };
      byDay[dateStr].total += p.amount_money.amount / 100;
    });
    const daily = Object.values(byDay).sort((a, b) => new Date(a.date) - new Date(b.date));
    res.json({ daily });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Shopify — auto-refreshing token, daily totals
app.get("/shopify/daily", async (req, res) => {
  try {
    // Step 1: Get fresh access token
    const tokenRes = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=client_credentials&client_id=${SHOPIFY_API_KEY}&client_secret=${SHOPIFY_API_SECRET}`
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.status(401).json({ error: "Could not get Shopify token", detail: tokenData });
    const token = tokenData.access_token;

    // Step 2: Fetch orders using fresh token
    let all = [], page_info = null;
    while (true) {
      let url = `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?financial_status=paid&limit=250`;
      if (page_info) url += `&page_info=${page_info}`;
      const r = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
      const data = await r.json();
      if (data.errors) return res.status(400).json({ errors: data.errors });
      all = [...all, ...(data.orders || [])];
      const link = r.headers.get("link");
      if (link && link.includes('rel="next"')) {
        page_info = link.match(/page_info=([^&>]+).*rel="next"/)?.[1];
        if (!page_info) break;
      } else break;
    }

    // Step 3: Group by day
    const byDay = {};
    all.forEach(o => {
      const d = new Date(o.created_at);
      const dateStr = fmtDate(d);
      if (!byDay[dateStr]) byDay[dateStr] = { date: dateStr, total: 0 };
      byDay[dateStr].total += parseFloat(o.subtotal_price || 0);
    });
    const daily = Object.values(byDay)
      .filter(d => d.total > 0)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    res.json({ daily });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
