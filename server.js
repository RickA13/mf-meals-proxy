const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type", "Accept"] }));
app.use(express.json());

const STRIPE_KEY = process.env.STRIPE_KEY;
const SQUARE_TOKEN = process.env.SQUARE_TOKEN;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;

// Format date as M/D/YYYY
const fmtDate = d => `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}`;

// Get delivery Sunday for a Stripe charge using Fri-Thu window
// Fri-Thu before delivery Sunday = that week's Stripe window
// Fri = 9 days before Sunday, Thu = 3 days before Sunday
const getDeliverySunday = (created) => {
  const d = new Date(created * 1000);
  const day = d.getDay(); // 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat
  let daysToSun;
  if (day === 5) daysToSun = 9;      // Friday
  else if (day === 6) daysToSun = 8; // Saturday
  else if (day === 0) daysToSun = 7; // Sunday
  else if (day === 1) daysToSun = 6; // Monday
  else if (day === 2) daysToSun = 5; // Tuesday
  else if (day === 3) daysToSun = 4; // Wednesday
  else daysToSun = 3;                // Thursday
  const sun = new Date(d);
  sun.setDate(d.getDate() + daysToSun);
  return fmtDate(sun);
};

app.get("/", (req, res) => res.json({ status: "MF Meals Proxy running" }));

// Stripe — daily totals with correct delivery Sunday
app.get("/stripe/daily", async (req, res) => {
  try {
    const since = req.query.since ? parseInt(req.query.since) : null;
    let all = [], hasMore = true, startingAfter = null;
    while (hasMore) {
      let url = "https://api.stripe.com/v1/charges?limit=100";
      if (since) url += `&created[gte]=${since}`;
      if (startingAfter) url += `&starting_after=${startingAfter}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${STRIPE_KEY}` } });
      const data = await r.json();
      if (data.error) return res.status(400).json(data);
      all = [...all, ...data.data];
      hasMore = data.has_more;
      if (data.data.length > 0) startingAfter = data.data[data.data.length - 1].id;
    }
    const paid = all.filter(c => c.status === "succeeded" && c.amount > 0);
    const byDay = {};
    paid.forEach(c => {
      const d = new Date(c.created * 1000);
      const dateStr = fmtDate(d);
      const deliverySunday = getDeliverySunday(c.created);
      if (!byDay[dateStr]) byDay[dateStr] = { date: dateStr, total: 0, created: c.created, deliverySunday };
      byDay[dateStr].total += c.amount / 100;
    });
    const daily = Object.values(byDay).sort((a, b) => a.created - b.created);
    res.json({ daily });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Square — daily totals
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

// Shopify — daily totals
app.get("/shopify/daily", async (req, res) => {
  try {
    let all = [], page_info = null;
    while (true) {
      let url = `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?status=paid&limit=250&financial_status=paid`;
      if (page_info) url += `&page_info=${page_info}`;
      const r = await fetch(url, { headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN } });
      const data = await r.json();
      if (data.errors) return res.status(400).json(data);
      all = [...all, ...(data.orders || [])];
      const link = r.headers.get("link");
      if (link && link.includes('rel="next"')) {
        page_info = link.match(/page_info=([^&>]+).*rel="next"/)?.[1];
        if (!page_info) break;
      } else break;
    }
    const byDay = {};
    all.forEach(o => {
      const d = new Date(o.created_at);
      const dateStr = fmtDate(d);
      if (!byDay[dateStr]) byDay[dateStr] = { date: dateStr, total: 0 };
      byDay[dateStr].total += parseFloat(o.total_price || 0);
    });
    const daily = Object.values(byDay).sort((a, b) => new Date(a.date) - new Date(b.date));
    res.json({ daily });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
