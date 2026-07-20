const fs = require("fs/promises");
const path = require("path");

const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const IMAGE_FILE_DLL = 0x2000;
const PE32_PLUS_MAGIC = 0x20b;
const MAX_NATIVE_DLLS = 64;
const MAX_NATIVE_DLL_BYTES = 256 * 1024 * 1024;
const MAX_SCAN_DEPTH = 4;
const ENTRY_EXPORTS = new Set(["bellwrightmodentry", "bellwrightnativemodinit"]);

function readCString(buffer, offset, maximum = 512) {
  if (!Number.isInteger(offset) || offset < 0 || offset >= buffer.length) {
    return "";
  }
  const endLimit = Math.min(buffer.length, offset + maximum);
  let end = offset;
  while (end < endLimit && buffer[end] !== 0) {
    end += 1;
  }
  return buffer.toString("ascii", offset, end);
}

function parsePortableExecutable(buffer) {
  const invalid = { valid: false, isX64Dll: false, imports: [], exports: [] };
  if (!Buffer.isBuffer(buffer) || buffer.length < 0x100 || buffer.readUInt16LE(0) !== 0x5a4d) {
    return invalid;
  }

  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset < 0x40 || peOffset + 24 > buffer.length || buffer.readUInt32LE(peOffset) !== 0x00004550) {
    return invalid;
  }

  const coffOffset = peOffset + 4;
  const machine = buffer.readUInt16LE(coffOffset);
  const sectionCount = buffer.readUInt16LE(coffOffset + 2);
  const optionalSize = buffer.readUInt16LE(coffOffset + 16);
  const characteristics = buffer.readUInt16LE(coffOffset + 18);
  const optionalOffset = coffOffset + 20;
  if (!sectionCount || sectionCount > 96 || optionalOffset + optionalSize > buffer.length || optionalSize < 128) {
    return invalid;
  }

  const optionalMagic = buffer.readUInt16LE(optionalOffset);
  const sectionOffset = optionalOffset + optionalSize;
  if (sectionOffset + sectionCount * 40 > buffer.length) {
    return invalid;
  }

  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionOffset + index * 40;
    sections.push({
      virtualSize: buffer.readUInt32LE(offset + 8),
      virtualAddress: buffer.readUInt32LE(offset + 12),
      rawSize: buffer.readUInt32LE(offset + 16),
      rawOffset: buffer.readUInt32LE(offset + 20)
    });
  }

  const rvaToOffset = (rva) => {
    for (const section of sections) {
      const size = Math.max(section.virtualSize, section.rawSize);
      if (rva >= section.virtualAddress && rva < section.virtualAddress + size) {
        const offset = section.rawOffset + (rva - section.virtualAddress);
        return offset >= 0 && offset < buffer.length ? offset : null;
      }
    }
    return rva < buffer.length ? rva : null;
  };

  const readDirectory = (index) => {
    const directoryOffset = optionalOffset + 112 + index * 8;
    if (optionalMagic !== PE32_PLUS_MAGIC || directoryOffset + 8 > optionalOffset + optionalSize) {
      return { rva: 0, size: 0 };
    }
    return {
      rva: buffer.readUInt32LE(directoryOffset),
      size: buffer.readUInt32LE(directoryOffset + 4)
    };
  };

  const imports = new Set();
  const importDirectory = readDirectory(1);
  const importOffset = importDirectory.rva ? rvaToOffset(importDirectory.rva) : null;
  if (importOffset !== null) {
    for (let index = 0; index < 4096; index += 1) {
      const descriptor = importOffset + index * 20;
      if (descriptor + 20 > buffer.length) {
        break;
      }
      const originalFirstThunk = buffer.readUInt32LE(descriptor);
      const timeDateStamp = buffer.readUInt32LE(descriptor + 4);
      const forwarderChain = buffer.readUInt32LE(descriptor + 8);
      const nameRva = buffer.readUInt32LE(descriptor + 12);
      const firstThunk = buffer.readUInt32LE(descriptor + 16);
      if (!(originalFirstThunk || timeDateStamp || forwarderChain || nameRva || firstThunk)) {
        break;
      }
      const nameOffset = rvaToOffset(nameRva);
      const name = nameOffset === null ? "" : readCString(buffer, nameOffset);
      if (name) {
        imports.add(path.basename(name).toLowerCase());
      }
    }
  }

  const exports = new Set();
  const exportDirectory = readDirectory(0);
  const exportOffset = exportDirectory.rva ? rvaToOffset(exportDirectory.rva) : null;
  if (exportOffset !== null && exportOffset + 40 <= buffer.length) {
    const nameCount = Math.min(buffer.readUInt32LE(exportOffset + 24), 65536);
    const namesRva = buffer.readUInt32LE(exportOffset + 32);
    const namesOffset = rvaToOffset(namesRva);
    if (namesOffset !== null) {
      for (let index = 0; index < nameCount; index += 1) {
        const entryOffset = namesOffset + index * 4;
        if (entryOffset + 4 > buffer.length) {
          break;
        }
        const nameOffset = rvaToOffset(buffer.readUInt32LE(entryOffset));
        const name = nameOffset === null ? "" : readCString(buffer, nameOffset);
        if (name) {
          exports.add(name.toLowerCase());
        }
      }
    }
  }

  const isX64Dll = machine === IMAGE_FILE_MACHINE_AMD64 &&
    optionalMagic === PE32_PLUS_MAGIC &&
    Boolean(characteristics & IMAGE_FILE_DLL);
  return {
    valid: true,
    machine,
    optionalMagic,
    isDll: Boolean(characteristics & IMAGE_FILE_DLL),
    isX64Dll,
    imports: [...imports],
    exports: [...exports]
  };
}

async function collectDllPaths(root, current = root, depth = 0, output = []) {
  if (depth > MAX_SCAN_DEPTH || output.length >= MAX_NATIVE_DLLS) {
    return output;
  }
  const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (output.length >= MAX_NATIVE_DLLS) {
      break;
    }
    if (entry.isSymbolicLink()) {
      continue;
    }
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await collectDllPaths(root, entryPath, depth + 1, output);
    } else if (entry.isFile() && /\.dll$/i.test(entry.name)) {
      output.push(entryPath);
    }
  }
  return output;
}

function normalizeHint(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function scoreCandidate(candidate, hints) {
  const stem = normalizeHint(path.basename(candidate.relativePath, path.extname(candidate.relativePath)));
  let score = 0;
  for (const hint of hints.map(normalizeHint).filter(Boolean)) {
    if (stem === hint) {
      score = Math.max(score, 100);
    } else if (stem.includes(hint) || hint.includes(stem)) {
      score = Math.max(score, 40);
    }
  }
  if (["payload", "mod", "nativemod", "bellwrightmod"].includes(stem)) {
    score = Math.max(score, 20);
  }
  return score;
}

function selectNativeEntrypoint(candidates, hints = []) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return { selected: null, candidates: [], reason: "none" };
  }
  if (candidates.length === 1) {
    return { selected: candidates[0], candidates, reason: "single" };
  }

  const localNames = new Map(candidates.map((candidate) => [path.basename(candidate.relativePath).toLowerCase(), candidate]));
  const importedLocalNames = new Set();
  for (const candidate of candidates) {
    for (const importedName of candidate.imports) {
      if (localNames.has(importedName)) {
        importedLocalNames.add(importedName);
      }
    }
  }
  const roots = candidates.filter((candidate) => !importedLocalNames.has(path.basename(candidate.relativePath).toLowerCase()));
  const marked = roots.filter((candidate) => candidate.exports.some((name) => ENTRY_EXPORTS.has(name)));
  if (marked.length === 1) {
    return { selected: marked[0], candidates: roots, reason: "entry-export" };
  }
  if (roots.length === 1) {
    return { selected: roots[0], candidates: roots, reason: "dependency-root" };
  }

  const pool = roots.length ? roots : candidates;
  const scored = pool.map((candidate) => ({ candidate, score: scoreCandidate(candidate, hints) }));
  const bestScore = Math.max(...scored.map((item) => item.score));
  const best = scored.filter((item) => item.score === bestScore && item.score > 0);
  if (best.length === 1) {
    return { selected: best[0].candidate, candidates: pool, reason: "name-match" };
  }
  return { selected: null, candidates: pool, reason: "ambiguous" };
}

async function discoverNativePayload(modFolder, hints = [], selectedRelativePath = "") {
  const nativeRoot = path.join(modFolder, "native");
  const nativeStat = await fs.stat(nativeRoot).catch(() => null);
  const scanRoot = nativeStat?.isDirectory() ? nativeRoot : modFolder;
  const dllPaths = await collectDllPaths(scanRoot);
  const candidates = [];
  for (const dllPath of dllPaths) {
    const stat = await fs.stat(dllPath).catch(() => null);
    if (!stat?.isFile() || stat.size <= 0 || stat.size > MAX_NATIVE_DLL_BYTES) {
      continue;
    }
    const pe = parsePortableExecutable(await fs.readFile(dllPath));
    if (!pe.isX64Dll) {
      continue;
    }
    candidates.push({
      path: dllPath,
      relativePath: path.relative(modFolder, dllPath).replace(/\\/g, "/"),
      imports: pe.imports,
      exports: pe.exports,
      size: stat.size
    });
  }

  const selected = candidates.find((candidate) => candidate.relativePath.toLowerCase() === String(selectedRelativePath).toLowerCase());
  if (selected) {
    return { selected, candidates, reason: "saved-selection" };
  }
  return selectNativeEntrypoint(candidates, hints);
}

module.exports = {
  discoverNativePayload,
  parsePortableExecutable,
  selectNativeEntrypoint
};
