import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ✅ FIXED: using correct env variable
const SECRET = process.env.TEBEX_SECRET;

// Root check
app.get("/", (req, res) => {
  res.json({ ok: true, service: "Ashfall DayZ Tebex webhook" });
});

// Tebex webhook
app.post("/tebex", (req, res) => {
  const body = req.body;

  // ✅ VALIDATION HANDSHAKE (VERY IMPORTANT)
  if (body.type === "validation.webhook") {
    return res.json({ id: body.id });
  }

  // ✅ FIXED signature check
  if (req.headers["x-tebex-signature"] !== SECRET) {
    console.log("❌ Invalid signature");
    return res.status(403).send("Invalid signature");
  }

  // ✅ Payment completed
  if (body.type === "payment.completed") {
    console.log("💰 Payment received:", body);

    // TODO: coin logic goes here later
  }

  return res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
