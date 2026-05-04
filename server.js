const express = require("express");
const ftp = require("basic-ftp");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 8080;

// Tebex signature needs the RAW body.
app.use(express.raw({ type: "*/*", limit: "2mb" }));

const COIN_PACKAGES = [
  { match: /25\s*,?\s*000\s+coins/i, coins: 25000 },
  { match: /10\s*,?\s*000\s+coins/i, coins: 10000 },
  { match: /5\s*,?\s*000\s+coins/i, coins: 5000 },
  { match: /2\s*,?\s*500\s+coins/i, coins: 2500 },
];

function jsonResponse(res, code, obj) {
  res.status(code).type("application/json").send(JSON.stringify(obj));
}

function parseBody(req) {
  const raw = req.body instanceof Buffer ? req.body : Buffer.from(req.body || "");
  const text = raw.toString("utf8");
  return { raw, text, json: JSON.parse(text || "{}") };
}

function verifyTebexSignature(req, raw) {
  const secret = process.env.TEBEX_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET;
  if (!secret) return true; // allow testing if no secret set

  const sig = req.get("X-Signature") || req.get("X-Tebex-Signature");
  if (!sig) return false;

  // Tebex current webhook docs: sha256(body), then HMAC-SHA256(bodyHash, secret)
  const bodyHash = crypto.createHash("sha256").update(raw).digest("hex");
  const expectedCurrent = crypto.createHmac("sha256", secret).update(bodyHash).digest("hex");

  // Older/affiliate style: HMAC-SHA256(rawBody, secret)
  const expectedLegacy = crypto.createHmac("sha256", secret).update(raw).digest("hex");

  return timingSafeEqual(sig, expectedCurrent) || timingSafeEqual(sig, expectedLegacy);
}

function timingSafeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function findSteamId(obj) {
  const matches = [];
  function walk(v) {
    if (v == null) return;
    if (typeof v === "string" || typeof v === "number") {
      const text = String(v);
      const found = text.match(/\b7656\d{13}\b/g);
      if (found) matches.push(...found);
      return;
    }
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === "object") Object.values(v).forEach(walk);
  }
  walk(obj);

  // prefer actual Steam64-looking IDs
  return matches[0] || null;
}

function collectPackages(obj) {
  const packages = [];
  function walk(v) {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(walk);

    const maybeName = v.name || v.package_name || v.packageName || v.product_name || v.productName;
    if (maybeName && typeof maybeName === "string") {
      packages.push({
        name: maybeName,
        quantity: Number(v.quantity || v.qty || 1) || 1,
      });
    }
    Object.values(v).forEach(walk);
  }
  walk(obj);
  return packages;
}

function coinsFromPayload(payload, rawText) {
  let total = 0;
  const packages = collectPackages(payload);

  for (const p of packages) {
    for (const def of COIN_PACKAGES) {
      if (def.match.test(p.name)) total += def.coins * p.quantity;
    }
  }

  // fallback: if package objects were not found, detect names once in the raw body
  if (total === 0) {
    for (const def of COIN_PACKAGES) {
      if (def.match.test(rawText)) total += def.coins;
    }
  }

  return total;
}

function ftpConfig() {
  return {
    host: required("ZAP_HOST"),
    port: Number(process.env.ZAP_PORT || 21),
    user: required("ZAP_USER"),
    password: required("ZAP_PASS"),
    secure: String(process.env.ZAP_SECURE || "false").toLowerCase() === "true",
  };
}

function required(name) {
  if (!process.env[name]) throw new Error(`Missing environment variable: ${name}`);
  return process.env[name];
}

async function addCoins(steamId, coins) {
  const client = new ftp.Client(20000);
  client.ftp.verbose = false;

  const bankDir = required("BANK_DIR").replace(/\/+$/, "");
  const bankKey = process.env.BANK_KEY || "bank";
  const remoteFile = `${bankDir}/${steamId}.json`;
  const tempFile = path.join(os.tmpdir(), `${steamId}-${Date.now()}.json`);

  try {
    await client.access(ftpConfig());

    let data = {};
    try {
      await client.downloadTo(tempFile, remoteFile);
      data = JSON.parse(await fs.readFile(tempFile, "utf8"));
    } catch (err) {
      // If the player file doesn't exist yet, create it.
      data = { [bankKey]: 0 };
    }

    const oldBalance = Number(data[bankKey] || 0);
    const newBalance = oldBalance + coins;
    data[bankKey] = newBalance;

    await fs.writeFile(tempFile, JSON.stringify(data, null, 4));
    await client.uploadFrom(tempFile, remoteFile);

    return { oldBalance, newBalance, remoteFile };
  } finally {
    client.close();
    try { await fs.unlink(tempFile); } catch {}
  }
}

app.get("/", (req, res) => {
  jsonResponse(res, 200, { ok: true, service: "Ashfall DayZ Tebex webhook" });
});

app.post("/tebex", async (req, res) => {
  try {
    const { raw, text, json } = parseBody(req);

    if (!verifyTebexSignature(req, raw)) {
      return jsonResponse(res, 401, { error: "Invalid Tebex signature" });
    }

    // Tebex endpoint validation: reply with the same id.
    if (json.type === "validation.webhook") {
      return jsonResponse(res, 200, { id: json.id });
    }

    const coins = coinsFromPayload(json, text);
    const steamId = findSteamId(json);

    if (!steamId) {
      console.log("No SteamID found in payload:", text);
      return jsonResponse(res, 400, { error: "No SteamID64 found in Tebex payload" });
    }

    if (!coins) {
      console.log("No coin package found in payload:", text);
      return jsonResponse(res, 200, { ok: true, ignored: "No coin package found" });
    }

    const result = await addCoins(steamId, coins);
    console.log(`Added ${coins} coins to ${steamId}: ${result.oldBalance} -> ${result.newBalance}`);

    return jsonResponse(res, 200, {
      ok: true,
      steamId,
      coinsAdded: coins,
      oldBalance: result.oldBalance,
      newBalance: result.newBalance,
    });
  } catch (err) {
    console.error(err);
    return jsonResponse(res, 500, { error: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Tebex DayZ webhook listening on port ${PORT}`);
});
