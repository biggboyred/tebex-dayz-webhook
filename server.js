import express from "express";
import crypto from "crypto";
import ftp from "basic-ftp";
import fs from "fs/promises";
import os from "os";
import path from "path";

const app = express();

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

const PORT = process.env.PORT || 3000;
const TEBEX_SECRET = process.env.TEBEX_SECRET;

const COIN_PACKAGES = {
  "2500 Coins": 2500,
  "2,500 Coins": 2500,
  "5000 Coins": 5000,
  "5,000 Coins": 5000,
  "10000 Coins": 10000,
  "10,000 Coins": 10000,
  "25000 Coins": 25000,
  "25,000 Coins": 25000
};

app.get("/", (req, res) => {
  res.json({ ok: true, service: "Ashfall DayZ Tebex webhook" });
});

function verifyTebexSignature(req) {
  const signature = req.headers["x-signature"] || req.headers["x-tebex-signature"];
  if (!signature || !TEBEX_SECRET) return false;

  const bodyHash = crypto.createHash("sha256").update(req.rawBody).digest("hex");
  const expected = crypto.createHmac("sha256", TEBEX_SECRET).update(bodyHash).digest("hex");

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function findSteamId(obj) {
  const text = JSON.stringify(obj);
  const match = text.match(/7656119\d{10}/);
  return match ? match[0] : null;
}

function getCoinsFromPayment(body) {
  const text = JSON.stringify(body);
  let total = 0;

  for (const [name, amount] of Object.entries(COIN_PACKAGES)) {
    if (text.includes(name)) {
      total += amount;
    }
  }

  return total;
}

async function addCoinsToBank(steamId, coins) {
  const client = new ftp.Client();
  client.ftp.verbose = true;

  const remoteFile = `${process.env.BANK_DIR}/${steamId}.json`;
  const tempFile = path.join(os.tmpdir(), `${steamId}.json`);

  await client.access({
    host: process.env.ZAP_HOST,
    port: Number(process.env.ZAP_PORT || 21),
    user: process.env.ZAP_USER,
    password: process.env.ZAP_PASS,
    secure: false
  });

  try {
    await client.downloadTo(tempFile, remoteFile);
  } catch {
    await fs.writeFile(tempFile, JSON.stringify({ [process.env.BANK_KEY || "bank"]: 0 }, null, 2));
  }

  const raw = await fs.readFile(tempFile, "utf8");
  const data = JSON.parse(raw || "{}");

  const bankKey = process.env.BANK_KEY || "bank";
  const current = Number(data[bankKey] || 0);
  data[bankKey] = current + coins;

  await fs.writeFile(tempFile, JSON.stringify(data, null, 2));
  await client.uploadFrom(tempFile, remoteFile);

  client.close();

  console.log(`✅ Added ${coins} coins to ${steamId}. New balance: ${data[bankKey]}`);
}

app.post("/tebex", async (req, res) => {
  const body = req.body;

  if (body.type === "validation.webhook") {
    return res.json({ id: body.id });
  }

  if (!verifyTebexSignature(req)) {
    console.log("❌ Invalid Tebex signature");
    return res.status(403).send("Invalid signature");
  }

  if (body.type === "payment.completed") {
    console.log("💰 Payment received");

    const steamId = findSteamId(body);
    const coins = getCoinsFromPayment(body);

    console.log("SteamID:", steamId);
    console.log("Coins:", coins);

    if (!steamId) {
      console.log("❌ No SteamID found in Tebex payment.");
      return res.status(400).send("No SteamID found");
    }

    if (!coins) {
      console.log("❌ No matching coin package found.");
      return res.status(400).send("No coin package matched");
    }

    try {
      await addCoinsToBank(steamId, coins);
    } catch (err) {
      console.error("❌ Failed to add coins:", err);
      return res.status(500).send("Failed to add coins");
    }
  }

  return res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
