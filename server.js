import express from "express";
import fs from "fs";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SECRET = process.env.WEBHOOK_SECRET;

// Root check
app.get("/", (req, res) => {
  res.json({ ok: true, service: "Ashfall DayZ Tebex webhook" });
});

// Tebex webhook
app.post("/tebex", (req, res) => {
  const body = req.body;

  // ✅ VALIDATION HANDSHAKE (THIS FIXES YOUR ERROR)
  if (body.type === "validation.webhook") {
    return res.json({ id: body.id });
  }

  // Security check
  if (req.headers["x-tebex-signature"] !== SECRET) {
    return res.status(403).send("Invalid signature");
  }

  // Payment completed
  if (body.type === "payment.completed") {
    console.log("Payment received:", body);

    // TODO: your coin logic here later
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
