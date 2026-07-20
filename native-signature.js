const crypto = require("node:crypto");

function normalizeHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

function normalizeSupportedGameHashes(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map(normalizeHash).filter(Boolean))].sort();
}

function normalizeRuntimeSignature(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const keyId = typeof value.keyId === "string" ? value.keyId.trim() : "";
  const signature = typeof value.value === "string" ? value.value.trim() : "";
  if (value.algorithm !== "ed25519" || !keyId || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) {
    return null;
  }
  return { algorithm: "ed25519", keyId, value: signature };
}

function canonicalRuntimeManifest(manifest) {
  return Buffer.from(JSON.stringify({
    schemaVersion: Number(manifest.schemaVersion),
    id: typeof manifest.id === "string" ? manifest.id.trim() : "",
    displayName: typeof manifest.displayName === "string" ? manifest.displayName.trim() : "",
    publisher: typeof manifest.publisher === "string" ? manifest.publisher.trim() : "",
    version: typeof manifest.version === "string" ? manifest.version.trim() : "",
    payload: typeof manifest.payload === "string" ? manifest.payload.trim() : "",
    payloadSha256: normalizeHash(manifest.payloadSha256),
    config: typeof manifest.config === "string" ? manifest.config.trim() : "",
    loadStage: manifest.loadStage === "main-menu" ? "main-menu" : "",
    healthLog: typeof manifest.healthLog === "string" ? manifest.healthLog.trim() : "",
    supportedGameSha256: normalizeSupportedGameHashes(manifest.supportedGameSha256)
  }), "utf8");
}

function verifyRuntimeManifestSignature(manifest, publicKeys) {
  const signature = normalizeRuntimeSignature(manifest.signature);
  if (!signature || !(publicKeys instanceof Map)) {
    return false;
  }
  const publicKey = publicKeys.get(signature.keyId);
  if (!publicKey) {
    return false;
  }
  try {
    return crypto.verify(
      null,
      canonicalRuntimeManifest(manifest),
      publicKey,
      Buffer.from(signature.value, "base64")
    );
  } catch {
    return false;
  }
}

module.exports = {
  canonicalRuntimeManifest,
  normalizeHash,
  normalizeRuntimeSignature,
  normalizeSupportedGameHashes,
  verifyRuntimeManifestSignature
};
