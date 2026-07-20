const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  canonicalRuntimeManifest,
  normalizeSupportedGameHashes
} = require("../native-signature");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function required(name) {
  const value = argument(name);
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return path.resolve(value);
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function ensurePrivateKey(privateKeyPath) {
  if (fs.existsSync(privateKeyPath)) {
    return fs.readFileSync(privateKeyPath, "utf8");
  }
  if (!process.argv.includes("--generate-key")) {
    throw new Error(`Signing key not found: ${privateKeyPath}`);
  }
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  fs.mkdirSync(path.dirname(privateKeyPath), { recursive: true });
  fs.writeFileSync(privateKeyPath, pem, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return pem;
}

const manifestPath = required("--manifest");
const payloadPath = required("--payload");
const privateKeyPath = required("--private-key");
const keyId = argument("--key-id") || "excelsiorone-native-2026-01";
const requestedHashes = [];
for (let i = 0; i < process.argv.length; ++i) {
  if (process.argv[i] === "--game-hash" && process.argv[i + 1]) {
    requestedHashes.push(process.argv[i + 1]);
  }
}

const privateKeyPem = ensurePrivateKey(privateKeyPath);
const privateKey = crypto.createPrivateKey(privateKeyPem);
const publicKeyPem = crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" });
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
manifest.payloadSha256 = sha256(payloadPath);
manifest.supportedGameSha256 = normalizeSupportedGameHashes(
  requestedHashes.length ? requestedHashes : manifest.supportedGameSha256
);
if (!manifest.supportedGameSha256.length) {
  throw new Error("At least one --game-hash is required for a new signed manifest");
}
manifest.signature = {
  algorithm: "ed25519",
  keyId,
  value: crypto.sign(null, canonicalRuntimeManifest(manifest), privateKey).toString("base64")
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`Signed ${manifestPath}`);
console.log(`Payload SHA-256: ${manifest.payloadSha256}`);
console.log(`Key ID: ${keyId}`);
console.log(publicKeyPem.trim());
