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
    if (text.includes(name)) total += amount;
  }

  return total;
}

function getPaymentId(body) {
  return (
    body?.subject?.transaction_id ||
    body?.subject?.id ||
    body?.id ||
    crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex")
  );
}

async function connectFtp() {
  const client = new ftp.Client();
  client.ftp.verbose = true;

  await client.access({
    host: process.env.ZAP_HOST,
    port: Number(process.env.ZAP_PORT || 21),
    user: process.env.ZAP_USER,
    password: process.env.ZAP_PASS,
    secure: false
  });

  return client;
}

async function downloadJsonOrDefault(client, remoteFile, defaultData) {
  const tempFile = path.join(os.tmpdir(), path.basename(remoteFile));

  try {
    await client.downloadTo(tempFile, remoteFile);
    const raw = await fs.readFile(tempFile, "utf8");
    return { data: JSON.parse(raw || "{}"), tempFile };
  } catch {
    await fs.writeFile(tempFile, JSON.stringify(defaultData, null, 2));
    return { data: defaultData, tempFile };
  }
}

async function addCoinsToBank(steamId, coins, paymentId) {
  const client = await connectFtp();

  try {
    const bankDir = process.env.BANK_DIR;
    const bankKey = process.env.BANK_KEY || "bank";

    const processedFile = `${bankDir}/ProcessedPayments.json`;
    const bankFile = `${bankDir}/${steamId}.json`;

    const processedResult = await downloadJsonOrDefault(client, processedFile, { processed: [] });
    const processed = processedResult.data.processed || [];

    if (processed.includes(paymentId)) {
      console.log(`⚠️ Duplicate payment blocked: ${paymentId}`);
      return { duplicate: true };
    }

    const bankResult = await downloadJsonOrDefault(client, bankFile, { [bankKey]: 0 });
    const bankData = bankResult.data;

    const current = Number(bankData[bankKey] || 0);
    bankData[bankKey] = current + coins;

    processed.push(paymentId);
    processedResult.data.processed = processed;

    await fs.writeFile(bankResult.tempFile, JSON.stringify(bankData, null, 2));
    await fs.writeFile(processedResult.tempFile, JSON.stringify(processedResult.data, null, 2));

    await client.uploadFrom(bankResult.tempFile, bankFile);
    await client.uploadFrom(processedResult.tempFile, processedFile);

    console.log(`✅ Added ${coins} coins to ${steamId}. New balance: ${bankData[bankKey]}`);
    console.log(`🔒 Saved processed payment: ${paymentId}`);

    return { duplicate: false };
  } finally {
    client.close();
  }
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
    const paymentId = getPaymentId(body);

    console.log("SteamID:", steamId);
    console.log("Coins:", coins);
    console.log("Payment ID:", paymentId);

    if (!steamId) return res.status(400).send("No SteamID found");
    if (!coins) return res.status(400).send("No coin package matched");

    try {
      await addCoinsToBank(steamId, coins, paymentId);
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
