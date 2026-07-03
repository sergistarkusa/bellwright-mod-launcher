const availableList = document.querySelector("#availableList");
const activeList = document.querySelector("#activeList");
const availableEmpty = document.querySelector("#availableEmpty");
const activeEmpty = document.querySelector("#activeEmpty");
const pathLine = document.querySelector("#pathLine");
const gameState = document.querySelector("#gameState");
const activeCount = document.querySelector("#activeCount");
const availableCount = document.querySelector("#availableCount");
const workshopCount = document.querySelector("#workshopCount");
const activeColumnCount = document.querySelector("#activeColumnCount");
const availableColumnCount = document.querySelector("#availableColumnCount");
const refreshButton = document.querySelector("#refreshButton");
const folderButton = document.querySelector("#folderButton");
const launchButton = document.querySelector("#launchButton");
const searchInput = document.querySelector("#searchInput");
const presetSelect = document.querySelector("#presetSelect");
const savePresetButton = document.querySelector("#savePresetButton");
const loadPresetButton = document.querySelector("#loadPresetButton");
const deletePresetButton = document.querySelector("#deletePresetButton");
const aboutMaker = document.querySelector("#aboutMaker");
const appVersion = document.querySelector("#appVersion");
const updateButton = document.querySelector("#updateButton");
const donateButton = document.querySelector("#donateButton");
const discordButton = document.querySelector("#discordButton");
const updateProgress = document.querySelector("#updateProgress");
const updateProgressTitle = document.querySelector("#updateProgressTitle");
const updateProgressPercent = document.querySelector("#updateProgressPercent");
const updateProgressBar = document.querySelector("#updateProgressBar");
const updateProgressMessage = document.querySelector("#updateProgressMessage");
const modalBackdrop = document.querySelector("#modalBackdrop");
const modalTitle = document.querySelector("#modalTitle");
const modalMessage = document.querySelector("#modalMessage");
const modalInput = document.querySelector("#modalInput");
const modalCancelButton = document.querySelector("#modalCancelButton");
const modalConfirmButton = document.querySelector("#modalConfirmButton");
const toast = document.querySelector("#toast");
const dropColumns = [...document.querySelectorAll(".modColumn")];

let state = null;
let presets = [];
let busy = false;
let toastTimer = null;
let pendingModal = null;

const icons = {
  power: '<svg viewBox="0 0 24 24"><path d="M12 2v10" /><path d="M18.4 6.6a9 9 0 1 1-12.8 0" /></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M8 5v14" /><path d="M16 5v14" /></svg>'
};

function showToast(message, error = false) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.hidden = false;
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 4200);
}

function showUpdateProgress(progress) {
  updateProgress.hidden = false;
  updateProgressTitle.textContent = progress.phase === "done" ? "Launcher update" : "Updating launcher";
  updateProgressMessage.textContent = progress.message || "Working...";

  const percent = Number.isFinite(progress.percent) ? Math.max(0, Math.min(progress.percent, 100)) : 8;
  updateProgressPercent.textContent = Number.isFinite(progress.percent) ? `${percent}%` : "";
  updateProgressBar.style.width = `${percent}%`;
}

function hideUpdateProgressSoon() {
  setTimeout(() => {
    updateProgress.hidden = true;
  }, 1800);
}

function closeModal(result) {
  if (!pendingModal) {
    return;
  }
  const { resolve } = pendingModal;
  pendingModal = null;
  modalBackdrop.hidden = true;
  modalInput.value = "";
  modalInput.hidden = false;
  resolve(result);
}

function openModal({ title, message, input = false, defaultValue = "", confirmText = "OK" }) {
  if (pendingModal) {
    closeModal(null);
  }

  modalTitle.textContent = title;
  modalMessage.textContent = message || "";
  modalInput.hidden = !input;
  modalInput.value = defaultValue || "";
  modalConfirmButton.textContent = confirmText;
  modalBackdrop.hidden = false;

  return new Promise((resolve) => {
    pendingModal = { resolve, input };
    requestAnimationFrame(() => {
      if (input) {
        modalInput.focus();
        modalInput.select();
      } else {
        modalConfirmButton.focus();
      }
    });
  });
}

function askPresetName(defaultValue) {
  return openModal({
    title: "Save preset",
    message: "Preset name",
    input: true,
    defaultValue,
    confirmText: "Save"
  });
}

function askConfirm(title, message, confirmText = "OK") {
  return openModal({
    title,
    message,
    input: false,
    confirmText
  });
}

function setBusy(value) {
  busy = value;
  refreshButton.disabled = value;
  folderButton.disabled = value;
  launchButton.disabled = value;
  savePresetButton.disabled = value;
  updateButton.disabled = value;
  loadPresetButton.disabled = value || !presetSelect.value || !state || state.gameRunning;
  deletePresetButton.disabled = value || !presetSelect.value;
  presetSelect.disabled = value || presets.length === 0;
  document.querySelectorAll(".toggleButton").forEach((button) => {
    button.disabled = value || state?.gameRunning;
  });
  document.querySelectorAll(".modCard").forEach((card) => {
    card.draggable = !(value || state?.gameRunning);
  });
}

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

function showModTooltip(mod, anchorElement) {
  const rect = anchorElement.getBoundingClientRect();
  window.bellwrightMods
    .showTooltip({
      mod,
      anchorRect: {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height
      }
    })
    .catch(() => {});
}

function hideModTooltip() {
  window.bellwrightMods.hideTooltip().catch(() => {});
}

async function loadState() {
  try {
    setBusy(true);
    hideModTooltip();
    state = await window.bellwrightMods.getState();
    render();
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
}

async function loadAppInfo() {
  try {
    const appInfo = await window.bellwrightMods.getAppInfo();
    aboutMaker.textContent = appInfo.maker || "FSD Software";
    appVersion.textContent = `v${appInfo.version || "0.1.0"}`;
    donateButton.disabled = !appInfo.donateUrl;
    donateButton.title = appInfo.donateUrl ? "Support FSD Software" : "Ko-fi link is not configured";
    discordButton.disabled = !appInfo.discordUrl;
    discordButton.title = appInfo.discordUrl ? "Join the Bellwright Discord section" : "Discord link is not configured";
    updateButton.title = appInfo.updateSupported
      ? `Update from ${appInfo.updateRepo || "GitHub"}`
      : "Updates are applied from the packaged launcher";
  } catch (error) {
    showToast(error.message || String(error), true);
  }
}

function getSelectedPreset() {
  return presets.find((preset) => preset.id === presetSelect.value) || null;
}

function renderPresets(selectedId = presetSelect.value) {
  presetSelect.innerHTML = "";

  if (presets.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No presets";
    presetSelect.appendChild(option);
  } else {
    for (const preset of presets) {
      const option = document.createElement("option");
      option.value = preset.id;
      option.textContent = `${preset.name} (${preset.activeCount})`;
      presetSelect.appendChild(option);
    }
    presetSelect.value = presets.some((preset) => preset.id === selectedId) ? selectedId : presets[0].id;
  }

  setBusy(busy);
}

async function loadPresets(selectedId = presetSelect.value) {
  try {
    presets = await window.bellwrightMods.listPresets();
    renderPresets(selectedId);
  } catch (error) {
    showToast(error.message || String(error), true);
  }
}

function render() {
  if (!state) {
    return;
  }

  const query = searchInput.value.trim().toLowerCase();
  const activeMods = state.mods.filter((mod) => mod.status === "active");
  const availableMods = state.mods.filter((mod) => mod.status === "disabled");
  const workshopMods = state.mods.filter((mod) => mod.source === "workshop");

  pathLine.textContent = `Local: ${state.modsRoot} | Workshop: ${state.workshopRoot}`;
  gameState.textContent = state.gameRunning ? "Running" : "Closed";
  gameState.style.color = state.gameRunning ? "var(--danger)" : "var(--ok)";
  activeCount.textContent = activeMods.length;
  availableCount.textContent = availableMods.length;
  workshopCount.textContent = workshopMods.length;

  const visibleActive = filterMods(activeMods, query);
  const visibleAvailable = filterMods(availableMods, query);

  activeColumnCount.textContent = visibleActive.length;
  availableColumnCount.textContent = visibleAvailable.length;

  renderColumn(activeList, activeEmpty, visibleActive);
  renderColumn(availableList, availableEmpty, visibleAvailable);
  setBusy(busy);
}

function filterMods(mods, query) {
  if (!query) {
    return mods;
  }
  return mods.filter((mod) => {
    const haystack =
      `${mod.title} ${mod.folderName} ${mod.displayFolderName} ${mod.description} ${mod.author} ${mod.tag} ${mod.workshopId || ""}`.toLowerCase();
    return haystack.includes(query);
  });
}

function renderColumn(list, empty, mods) {
  list.innerHTML = "";
  empty.hidden = mods.length !== 0;

  for (const mod of mods) {
    const card = document.createElement("article");
    card.className = "modCard";
    card.draggable = !(busy || state.gameRunning);
    card.dataset.folder = mod.folderName;
    card.dataset.source = mod.source;
    card.dataset.status = mod.status;
    card.dataset.key = modKey(mod);
    card.tabIndex = 0;

    const actionLabel = mod.status === "active" ? "Deactivate" : "Activate";
    const actionClass = mod.status === "active" ? "disable" : "enable";
    const actionIcon = mod.status === "active" ? icons.pause : icons.power;
    const status = getStatusLabel(mod);
    const note = state.gameRunning
      ? "Close game first"
      : mod.source === "workshop"
        ? "Steam may restore on update"
        : "";

    card.innerHTML = `
      <div class="modHeader">
        <div class="modTitle">
          <h2>${escapeHtml(mod.title)}</h2>
          <div class="folderName">${escapeHtml(mod.displayFolderName || mod.folderName)}</div>
        </div>
        <span class="pill ${status.className}">${status.text}</span>
      </div>
      <div class="cardActions">
        <button class="toggleButton ${actionClass}">
          ${actionIcon}
          <span>${actionLabel}</span>
        </button>
        <span class="note">${escapeHtml(note)}</span>
      </div>
    `;

    card.addEventListener("mouseenter", () => showModTooltip(mod, card));
    card.addEventListener("mouseleave", hideModTooltip);
    card.addEventListener("focus", () => showModTooltip(mod, card));
    card.addEventListener("blur", hideModTooltip);

    card.addEventListener("dragstart", (event) => {
      if (busy || state.gameRunning) {
        event.preventDefault();
        return;
      }
      hideModTooltip();
      card.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(
        "application/json",
        JSON.stringify({
          folderName: mod.folderName,
          source: mod.source,
          sourceRoot: mod.sourceRoot,
          status: mod.status
        })
      );
    });

    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      dropColumns.forEach((column) => column.classList.remove("dragOver"));
    });

    const button = card.querySelector(".toggleButton");
    button.disabled = busy || state.gameRunning;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      moveMod(mod, mod.status === "active" ? "available" : "active");
    });

    list.appendChild(card);
  }
}

async function moveMod(mod, targetColumn) {
  if (busy) {
    return;
  }
  hideModTooltip();
  if (state?.gameRunning) {
    showToast("Close Bellwright before changing enabled mods.", true);
    return;
  }
  if ((targetColumn === "active" && mod.status === "active") || (targetColumn === "available" && mod.status === "disabled")) {
    return;
  }

  try {
    setBusy(true);
    if (targetColumn === "active") {
      state = await window.bellwrightMods.enable({
        folderName: mod.folderName,
        sourceRoot: mod.sourceRoot,
        source: mod.source
      });
      showToast(`${mod.title} activated.`);
    } else {
      state = await window.bellwrightMods.disable({
        folderName: mod.folderName,
        source: mod.source
      });
      showToast(`${mod.title} deactivated.`);
    }
    render();
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
}

function modKey(mod) {
  return modKeyFromParts(mod.source, mod.folderName);
}

function modKeyFromParts(source, folderName) {
  return `${source}:${folderName}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function findModByPayload(payload) {
  return state?.mods.find((mod) => mod.folderName === payload.folderName && mod.source === payload.source) || null;
}

dropColumns.forEach((column) => {
  column.addEventListener("dragover", (event) => {
    if (busy || state?.gameRunning) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    column.classList.add("dragOver");
  });

  column.addEventListener("dragleave", () => {
    column.classList.remove("dragOver");
  });

  column.addEventListener("drop", async (event) => {
    event.preventDefault();
    column.classList.remove("dragOver");
    let payload;
    try {
      payload = JSON.parse(event.dataTransfer.getData("application/json"));
    } catch {
      return;
    }
    const mod = findModByPayload(payload);
    if (!mod) {
      return;
    }
    await moveMod(mod, column.dataset.dropTarget);
  });
});

modalConfirmButton.addEventListener("click", () => {
  if (!pendingModal) {
    return;
  }
  closeModal(pendingModal.input ? modalInput.value : true);
});

modalCancelButton.addEventListener("click", () => {
  if (!pendingModal) {
    return;
  }
  closeModal(pendingModal.input ? null : false);
});

modalBackdrop.addEventListener("click", (event) => {
  if (event.target !== modalBackdrop || !pendingModal) {
    return;
  }
  closeModal(pendingModal.input ? null : false);
});

document.addEventListener("keydown", (event) => {
  if (!pendingModal) {
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeModal(pendingModal.input ? null : false);
  } else if (event.key === "Enter") {
    event.preventDefault();
    closeModal(pendingModal.input ? modalInput.value : true);
  }
});

async function saveCurrentPreset() {
  if (busy) {
    return;
  }
  const selectedPreset = getSelectedPreset();
  const defaultName = selectedPreset?.name || "";
  const name = await askPresetName(defaultName);
  if (name === null) {
    return;
  }
  const trimmedName = name.trim().replace(/\s+/g, " ");
  if (!trimmedName) {
    showToast("Preset name is required.", true);
    return;
  }

  try {
    setBusy(true);
    const result = await window.bellwrightMods.savePreset({ name: trimmedName });
    presets = result.presets || [];
    renderPresets(result.preset?.id);
    showToast(`${result.preset?.name || trimmedName} saved.`);
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
}

async function loadSelectedPreset() {
  if (busy) {
    return;
  }
  if (state?.gameRunning) {
    showToast("Close Bellwright before loading a preset.", true);
    return;
  }

  const preset = getSelectedPreset();
  if (!preset) {
    showToast("Choose a preset first.", true);
    return;
  }
  if (!(await askConfirm("Load preset", `Load "${preset.name}"? Current active mods will be changed.`, "Load"))) {
    return;
  }

  try {
    setBusy(true);
    const result = await window.bellwrightMods.loadPreset(preset.id);
    state = result.state;
    render();
    const missingText = result.missing?.length ? ` ${result.missing.length} saved mod(s) were not found.` : "";
    showToast(`${preset.name} loaded. ${result.changed} change(s) applied.${missingText}`.trim(), Boolean(result.missing?.length));
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
}

async function deleteSelectedPreset() {
  if (busy) {
    return;
  }
  const preset = getSelectedPreset();
  if (!preset) {
    showToast("Choose a preset first.", true);
    return;
  }
  if (!(await askConfirm("Delete preset", `Delete "${preset.name}"?`, "Delete"))) {
    return;
  }

  try {
    setBusy(true);
    presets = await window.bellwrightMods.deletePreset(preset.id);
    renderPresets();
    showToast(`${preset.name} deleted.`);
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
}

async function updateLauncher() {
  if (busy) {
    return;
  }

  try {
    setBusy(true);
    showUpdateProgress({ phase: "check", percent: 0, message: "Checking GitHub release..." });
    const result = await window.bellwrightMods.updateLauncher();
    if (result.status === "up-to-date") {
      showToast("Launcher is up to date.");
      hideUpdateProgressSoon();
    } else if (result.status === "staged") {
      showToast(`Update v${result.latestVersion} downloaded. Restart when ready.`);
    }
  } catch (error) {
    showToast(error.message || String(error), true);
    hideUpdateProgressSoon();
  } finally {
    setBusy(false);
  }
}

refreshButton.addEventListener("click", loadState);

presetSelect.addEventListener("change", () => setBusy(busy));

savePresetButton.addEventListener("click", saveCurrentPreset);

loadPresetButton.addEventListener("click", loadSelectedPreset);

deletePresetButton.addEventListener("click", deleteSelectedPreset);

folderButton.addEventListener("click", async () => {
  try {
    await window.bellwrightMods.openModsFolder();
  } catch (error) {
    showToast(error.message || String(error), true);
  }
});

launchButton.addEventListener("click", async () => {
  try {
    await window.bellwrightMods.launchGame();
    showToast("Launching Bellwright through Steam.");
    setTimeout(loadState, 2500);
  } catch (error) {
    showToast(error.message || String(error), true);
  }
});

donateButton.addEventListener("click", async () => {
  if (donateButton.disabled) {
    return;
  }
  try {
    await window.bellwrightMods.openDonate();
  } catch (error) {
    showToast(error.message || String(error), true);
  }
});

discordButton.addEventListener("click", async () => {
  if (discordButton.disabled) {
    return;
  }
  try {
    await window.bellwrightMods.openDiscord();
  } catch (error) {
    showToast(error.message || String(error), true);
  }
});

updateButton.addEventListener("click", updateLauncher);

searchInput.addEventListener("input", render);

window.addEventListener("resize", hideModTooltip);
window.addEventListener("scroll", hideModTooltip, true);

window.bellwrightMods.onUpdateProgress(showUpdateProgress);

loadAppInfo();
loadPresets();
loadState();
