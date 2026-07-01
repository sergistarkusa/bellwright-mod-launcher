const statusElement = document.querySelector("#status");
const titleElement = document.querySelector("#title");
const descriptionElement = document.querySelector("#description");
const sourceElement = document.querySelector("#source");
const folderElement = document.querySelector("#folder");
const authorElement = document.querySelector("#author");
const versionElement = document.querySelector("#version");
const packagesElement = document.querySelector("#packages");
const pathElement = document.querySelector("#path");

function getStatusLabel(mod) {
  if (mod.source === "workshop") {
    return {
      text: mod.status === "active" ? "Workshop On" : "Workshop Off",
      className: "workshop"
    };
  }
  return {
    text: mod.status === "active" ? "Active" : "Disabled",
    className: mod.status
  };
}

function render(mod) {
  const status = getStatusLabel(mod);
  statusElement.textContent = status.text;
  statusElement.className = `pill ${status.className}`;
  titleElement.textContent = mod.title || mod.folderName;
  descriptionElement.textContent = mod.description || "No description in modinfo.json.";
  sourceElement.textContent = mod.workshopId ? `${mod.sourceLabel} #${mod.workshopId}` : mod.sourceLabel;
  folderElement.textContent = mod.displayFolderName || mod.folderName;
  authorElement.textContent = mod.author || "Unknown";
  versionElement.textContent = mod.version || "Not listed";
  packagesElement.textContent = String(mod.packageCount ?? 0);
  pathElement.textContent = mod.path || "";
}

window.bellwrightMods.onTooltip(render);
