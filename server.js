import express from "express";
import crypto from "crypto";

const app = express();

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

const PORT = process.env.PORT || 3000;
const TEBEX_SECRET = process.env.TEBEX_SECRET;

app.get("/", (req, res) => {
  res.json({ ok: true, service: "Ashfall DayZ Tebex webhook" });
});

function verifyTebexSignature(req) {
  const signature = req.headers["x-signature"] || req.headers["x-tebex-signature"];

  if (!signature || !TEBEX_SECRET) return false;

  const bodyHash = crypto
    .createHash("sha256")
    .update(req.rawBody)
    .digest("hex");

  const expectedSignature = crypto
    .createHmac("sha256", TEBEX_SECRET)
    .update(bodyHash)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

app.post("/tebex", (req, res) => {
  const body = req.body;

  if (body.type === "validation.webhook") {
    return res.json({ id: body.id });
  }

  if (!verifyTebexSignature(req)) {
    console.log("❌ Invalid Tebex signature");
    return res.status(403).send("Invalid signature");
  }

  if (body.type === "payment.completed") {
    console.log("💰 Payment received:", JSON.stringify(body, null, 2));
  }

  return res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
