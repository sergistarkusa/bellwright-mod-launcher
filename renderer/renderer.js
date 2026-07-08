const availableList = document.querySelector("#availableList");
const shell = document.querySelector(".shell");
const windowTitlebar = document.querySelector("#windowTitlebar");
const windowMinimizeButton = document.querySelector("#windowMinimizeButton");
const windowCloseButton = document.querySelector("#windowCloseButton");
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
const sharePresetButton = document.querySelector("#sharePresetButton");
const importPresetButton = document.querySelector("#importPresetButton");
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
const shareModalBackdrop = document.querySelector("#shareModalBackdrop");
const shareModalCloseButton = document.querySelector("#shareModalCloseButton");
const shareModalCancelButton = document.querySelector("#shareModalCancelButton");
const sharePreviewButton = document.querySelector("#sharePreviewButton");
const shareImportButton = document.querySelector("#shareImportButton");
const shareCodeInput = document.querySelector("#shareCodeInput");
const sharePreview = document.querySelector("#sharePreview");
const sharePreviewName = document.querySelector("#sharePreviewName");
const sharePreviewCounts = document.querySelector("#sharePreviewCounts");
const sharePreviewWarning = document.querySelector("#sharePreviewWarning");
const shareModList = document.querySelector("#shareModList");
const toast = document.querySelector("#toast");
const conflictTooltip = document.querySelector("#conflictTooltip");
const dropColumns = [...document.querySelectorAll(".modColumn")];

let state = null;
let presets = [];
let busy = false;
let toastTimer = null;
let pendingModal = null;
let pendingGameRunningState = null;
let gameStateRefreshRunning = false;
let fitContentFrame = null;
let inspectedShareCode = null;

const icons = {
  power: '<svg viewBox="0 0 24 24"><path d="M12 2v10" /><path d="M18.4 6.6a9 9 0 1 1-12.8 0" /></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M8 5v14" /><path d="M16 5v14" /></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="m18 15-6-6-6 6" /></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg>',
  alert: '<svg viewBox="0 0 24 24"><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>',
  external: '<svg viewBox="0 0 24 24"><path d="M15 3h6v6" /><path d="m10 14 11-11" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></svg>'
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
  scheduleFitContent();
}

function hideUpdateProgressSoon() {
  setTimeout(() => {
    updateProgress.hidden = true;
    scheduleFitContent();
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
  sharePresetButton.disabled = value || !presetSelect.value;
  importPresetButton.disabled = value;
  deletePresetButton.disabled = value || !presetSelect.value;
  presetSelect.disabled = value || presets.length === 0;
  document.querySelectorAll(".toggleButton").forEach((button) => {
    button.disabled = value || state?.gameRunning;
  });
  document.querySelectorAll(".orderButton").forEach((button) => {
    button.disabled = value || state?.gameRunning || button.dataset.blocked === "true";
  });
  document.querySelectorAll(".modCard").forEach((card) => {
    card.draggable = !(value || state?.gameRunning);
  });
  if (!value && pendingGameRunningState !== null) {
    queueMicrotask(flushPendingGameRunningState);
  }
}

function fitContentToWindow() {
  fitContentFrame = null;
  const horizontalSpace = Math.max(1, window.innerWidth - 44);
  const bottomGap = 10;
  const fits = (scale) => {
    shell.style.zoom = String(scale);
    shell.style.width = `${horizontalSpace / scale}px`;
    return shell.getBoundingClientRect().bottom <= window.innerHeight - bottomGap;
  };

  let scale = 1;
  if (!fits(scale)) {
    let low = 0.1;
    let high = 1;
    for (let pass = 0; pass < 12; pass += 1) {
      const candidate = (low + high) / 2;
      if (fits(candidate)) {
        low = candidate;
      } else {
        high = candidate;
      }
    }
    scale = low;
    fits(scale);
  }

  shell.style.setProperty("--content-scale", scale.toFixed(4));
}

function scheduleFitContent() {
  if (fitContentFrame !== null) {
    cancelAnimationFrame(fitContentFrame);
  }
  fitContentFrame = requestAnimationFrame(() => requestAnimationFrame(fitContentToWindow));
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

async function flushPendingGameRunningState() {
  if (busy || gameStateRefreshRunning || pendingGameRunningState === null) {
    return;
  }

  gameStateRefreshRunning = true;
  try {
    while (!busy && pendingGameRunningState !== null) {
      const gameRunning = pendingGameRunningState;
      pendingGameRunningState = null;
      if (!state || gameRunning !== state.gameRunning) {
        await loadState();
      }
    }
  } finally {
    gameStateRefreshRunning = false;
    if (!busy && pendingGameRunningState !== null) {
      queueMicrotask(flushPendingGameRunningState);
    }
  }
}

function handleGameRunningChanged(gameRunning) {
  pendingGameRunningState = Boolean(gameRunning);
  flushPendingGameRunningState();
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

function resetSharePreview() {
  inspectedShareCode = null;
  sharePreview.hidden = true;
  shareImportButton.hidden = true;
  shareModList.innerHTML = "";
}

function openShareImportModal() {
  shareCodeInput.value = "";
  resetSharePreview();
  shareModalBackdrop.hidden = false;
  requestAnimationFrame(() => shareCodeInput.focus());
}

function closeShareImportModal() {
  shareModalBackdrop.hidden = true;
  shareCodeInput.value = "";
  resetSharePreview();
}

function setShareModalBusy(value) {
  shareCodeInput.disabled = value;
  sharePreviewButton.disabled = value;
  shareImportButton.disabled = value;
  shareModalCancelButton.disabled = value;
  shareModalCloseButton.disabled = value;
}

function getSharedModStatus(mod) {
  if (!mod.installed) {
    return mod.source === "workshop" ? "Workshop missing" : "Local missing";
  }
  return mod.status === "active" ? "Active" : "Available";
}

function renderSharePreview(inspection) {
  sharePreviewName.textContent = inspection.name;
  sharePreviewCounts.textContent = `${inspection.activeCount} mod${inspection.activeCount === 1 ? "" : "s"} · ${inspection.installedCount} installed`;
  const missingCount = inspection.missingWorkshopCount + inspection.missingLocalCount;
  sharePreviewWarning.hidden = missingCount === 0;
  sharePreviewWarning.textContent = missingCount ? `${missingCount} missing` : "";
  shareModList.innerHTML = "";

  for (const mod of inspection.mods) {
    const row = document.createElement("li");
    row.className = "shareModRow";

    const order = document.createElement("span");
    order.className = "shareModOrder";
    order.textContent = String(mod.order).padStart(2, "0");

    const identity = document.createElement("div");
    identity.className = "shareModIdentity";
    const title = document.createElement("strong");
    title.textContent = mod.title;
    const modName = document.createElement("span");
    modName.textContent = mod.modName;
    identity.append(title, modName);

    const status = document.createElement("span");
    status.className = `shareModStatus${mod.installed ? "" : " missing"}`;
    status.textContent = getSharedModStatus(mod);

    row.append(order, identity, status);
    if (!mod.installed && mod.source === "workshop" && mod.workshopId) {
      const workshopButton = document.createElement("button");
      workshopButton.className = "openWorkshopButton";
      workshopButton.type = "button";
      workshopButton.title = "Open in Steam Workshop";
      workshopButton.setAttribute("aria-label", `Open ${mod.title} in Steam Workshop`);
      workshopButton.innerHTML = icons.external;
      workshopButton.addEventListener("click", async () => {
        try {
          workshopButton.disabled = true;
          await window.bellwrightMods.openWorkshopItem(mod.workshopId);
        } catch (error) {
          showToast(error.message || String(error), true);
        } finally {
          workshopButton.disabled = false;
        }
      });
      row.appendChild(workshopButton);
    }
    shareModList.appendChild(row);
  }

  sharePreview.hidden = false;
  shareImportButton.hidden = false;
}

async function previewSharedPreset() {
  const code = shareCodeInput.value.trim();
  if (!code) {
    showToast("Paste a BWL1 preset code first.", true);
    shareCodeInput.focus();
    return;
  }

  try {
    setShareModalBusy(true);
    const inspection = await window.bellwrightMods.inspectPresetShareCode(code);
    inspectedShareCode = code;
    renderSharePreview(inspection);
  } catch (error) {
    resetSharePreview();
    showToast(error.message || String(error), true);
  } finally {
    setShareModalBusy(false);
  }
}

async function importSharedPreset() {
  const code = shareCodeInput.value.trim();
  if (!inspectedShareCode || inspectedShareCode !== code) {
    await previewSharedPreset();
    return;
  }

  try {
    setShareModalBusy(true);
    const result = await window.bellwrightMods.importPresetShareCode(code);
    presets = result.presets || [];
    renderPresets(result.preset?.id);
    closeShareImportModal();
    showToast(`${result.preset?.name || "Shared preset"} imported.`);
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    setShareModalBusy(false);
  }
}

async function copySelectedPresetShareCode() {
  if (busy) {
    return;
  }
  const preset = getSelectedPreset();
  if (!preset) {
    showToast("Choose a preset first.", true);
    return;
  }

  try {
    setBusy(true);
    await window.bellwrightMods.copyPresetShareCode(preset.id);
    showToast(`${preset.name} share code copied.`);
  } catch (error) {
    showToast(error.message || String(error), true);
  } finally {
    setBusy(false);
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
  scheduleFitContent();
}

function filterMods(mods, query) {
  if (!query) {
    return mods;
  }
  return mods.filter((mod) => {
    const haystack =
      `${mod.title} ${mod.folderName} ${mod.displayFolderName} ${mod.modName || ""} ${mod.description} ${mod.author} ${mod.tag} ${mod.workshopId || ""} ${mod.steamId || ""}`.toLowerCase();
    return haystack.includes(query);
  });
}

function compareActiveOrder(left, right) {
  const leftOrder = Number.isInteger(left.loadOrderIndex) ? left.loadOrderIndex : Number.MAX_SAFE_INTEGER;
  const rightOrder = Number.isInteger(right.loadOrderIndex) ? right.loadOrderIndex : Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
}

function getOrderedActiveMods() {
  return [...(state?.mods || []).filter((mod) => mod.status === "active")].sort(compareActiveOrder);
}

function renderColumn(list, empty, mods) {
  list.innerHTML = "";
  empty.hidden = mods.length !== 0;
  const orderedActiveMods = getOrderedActiveMods();
  const activeIndexByKey = new Map(orderedActiveMods.map((mod, index) => [modKey(mod), index]));

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
    const activeIndex = activeIndexByKey.get(modKey(mod));
    const loadOrderText = Number.isInteger(activeIndex) ? String(activeIndex + 1).padStart(2, "0") : "";
    const conflictCount = mod.status === "active" ? mod.activeConflictCount : mod.conflictCount;
    const conflictClass = mod.conflictSeverity ? ` ${mod.conflictSeverity}` : "";
    const conflictBadge = conflictCount
      ? `<button class="conflictBadge${conflictClass}" type="button" aria-label="${mod.status === "active" ? "Active conflict" : "Potential conflict"}">${icons.alert}<span>${conflictCount}</span></button>`
      : "";
    const orderControls =
      mod.status === "active"
        ? `<div class="orderControls" aria-label="Load priority">
            <button class="orderButton" type="button" data-direction="-1" data-blocked="${activeIndex <= 0}" title="Move earlier" aria-label="Move earlier">${icons.up}</button>
            <button class="orderButton" type="button" data-direction="1" data-blocked="${activeIndex >= orderedActiveMods.length - 1}" title="Move later" aria-label="Move later">${icons.down}</button>
          </div>`
        : "";
    const note = state.gameRunning
      ? "Close game first"
      : mod.activeConflictCount
        ? `${mod.activeConflictCount} active conflict${mod.activeConflictCount === 1 ? "" : "s"}`
      : mod.source === "workshop"
        ? "Steam may restore on update"
        : "";

    card.innerHTML = `
      <div class="modHeader">
        ${loadOrderText ? `<span class="loadOrderBadge" title="Load priority ${mod.priority || ""}">${loadOrderText}</span>` : ""}
        <div class="modTitle">
          <h2>${escapeHtml(mod.title)}</h2>
          <div class="folderName">${escapeHtml(mod.modName || mod.displayFolderName || mod.folderName)}</div>
        </div>
        ${conflictBadge}
        <span class="pill ${status.className}">${status.text}</span>
      </div>
      <div class="cardActions">
        ${orderControls}
        <button class="toggleButton ${actionClass}">
          ${actionIcon}
          <span>${actionLabel}</span>
        </button>
        <span class="note">${escapeHtml(note)}</span>
      </div>
    `;

    card.addEventListener("mouseenter", () => showModTooltip(mod, card));
    card.addEventListener("mouseleave", () => {
      hideModTooltip();
      hideConflictTooltip();
    });
    card.addEventListener("focus", () => showModTooltip(mod, card));
    card.addEventListener("blur", () => {
      hideModTooltip();
      hideConflictTooltip();
    });

    const conflictBadgeElement = card.querySelector(".conflictBadge");
    if (conflictBadgeElement) {
      conflictBadgeElement.addEventListener("mouseenter", (event) => {
        event.stopPropagation();
        hideModTooltip();
        showConflictTooltip(mod, event);
      });
      conflictBadgeElement.addEventListener("mousemove", (event) => {
        positionConflictTooltip(event);
      });
      conflictBadgeElement.addEventListener("mouseleave", hideConflictTooltip);
      conflictBadgeElement.addEventListener("focus", (event) => {
        hideModTooltip();
        showConflictTooltip(mod, event);
      });
      conflictBadgeElement.addEventListener("blur", hideConflictTooltip);
    }

    card.addEventListener("dragstart", (event) => {
      if (busy || state.gameRunning) {
        event.preventDefault();
        return;
      }
      hideModTooltip();
      hideConflictTooltip();
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

    card.querySelectorAll(".orderButton").forEach((orderButton) => {
      orderButton.disabled = busy || state.gameRunning || orderButton.dataset.blocked === "true";
      orderButton.addEventListener("click", (event) => {
        event.stopPropagation();
        moveLoadOrder(mod, Number(orderButton.dataset.direction));
      });
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

async function moveLoadOrder(mod, direction) {
  if (busy || !direction) {
    return;
  }
  hideModTooltip();
  if (state?.gameRunning) {
    showToast("Close Bellwright before changing load order.", true);
    return;
  }

  const activeMods = getOrderedActiveMods();
  const currentIndex = activeMods.findIndex((candidate) => modKey(candidate) === modKey(mod));
  const nextIndex = currentIndex + direction;
  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= activeMods.length) {
    return;
  }

  const nextOrder = [...activeMods];
  [nextOrder[currentIndex], nextOrder[nextIndex]] = [nextOrder[nextIndex], nextOrder[currentIndex]];

  try {
    setBusy(true);
    state = await window.bellwrightMods.setLoadOrder({ keys: nextOrder.map(modKey) });
    render();
    showToast("Load order updated.");
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

function getSeverityText(severity) {
  if (severity === "high") {
    return "High";
  }
  if (severity === "medium") {
    return "Warning";
  }
  return "Notice";
}

function formatOperations(operations) {
  return (operations || [])
    .map((operation) => operation.charAt(0).toUpperCase() + operation.slice(1))
    .join(", ");
}

function getConflictsForMod(mod) {
  const conflicts = Array.isArray(state?.conflicts) ? state.conflicts : [];
  const key = modKey(mod);
  return conflicts.filter((conflict) => conflict.mods?.some((conflictMod) => conflictMod.key === key));
}

function getOtherConflictMod(conflict, mod) {
  const key = modKey(mod);
  return conflict.mods?.find((conflictMod) => conflictMod.key !== key) || null;
}

function getConflictAssetLines(conflict, limit = 3) {
  const assets = conflict.assets || [];
  const lines = assets.slice(0, limit).map((asset) => {
    const operations = [...new Set([...(asset.leftOperations || []), ...(asset.rightOperations || [])])];
    return `<li><strong>${escapeHtml(asset.path)}</strong><span>${escapeHtml(formatOperations(operations))}</span></li>`;
  });
  if (conflict.assetCount > limit) {
    lines.push(`<li class="moreAssets">+${conflict.assetCount - limit} more shared asset${conflict.assetCount - limit === 1 ? "" : "s"}</li>`);
  }
  return lines.join("") || "<li>No shared asset path listed</li>";
}

function positionConflictTooltip(event) {
  if (conflictTooltip.hidden) {
    return;
  }

  const sourceRect = event.currentTarget?.getBoundingClientRect?.();
  const baseX = Number.isFinite(event.clientX) && event.clientX > 0 ? event.clientX : sourceRect?.right || 16;
  const baseY = Number.isFinite(event.clientY) && event.clientY > 0 ? event.clientY : sourceRect?.top || 16;
  const margin = 14;
  const rect = conflictTooltip.getBoundingClientRect();
  let left = baseX + margin;
  let top = baseY + margin;

  if (left + rect.width > window.innerWidth - margin) {
    left = Math.max(margin, baseX - rect.width - margin);
  }
  if (top + rect.height > window.innerHeight - margin) {
    top = Math.max(margin, baseY - rect.height - margin);
  }

  conflictTooltip.style.left = `${Math.round(left)}px`;
  conflictTooltip.style.top = `${Math.round(top)}px`;
}

function showConflictTooltip(mod, event) {
  const conflicts = getConflictsForMod(mod);
  if (!conflicts.length) {
    hideConflictTooltip();
    return;
  }

  const rows = conflicts.slice(0, 3).map((conflict) => {
    const other = getOtherConflictMod(conflict, mod);
    const winner = conflict.winner ? `<span>Winner now: ${escapeHtml(conflict.winner.title)}</span>` : "";
    const duplicate = conflict.duplicateInstall ? "<span>Duplicate install</span>" : "";
    return `<section class="conflictTooltipItem ${conflict.severity || "low"}">
      <div class="conflictTooltipTitle">
        <span class="severity ${conflict.severity || "low"}">${getSeverityText(conflict.severity)}</span>
        <strong>${escapeHtml(other?.title || "Unknown mod")}</strong>
      </div>
      <div class="conflictTooltipMeta">
        <span>${conflict.bothActive ? "Active conflict" : "Potential conflict"}</span>
        <span>${conflict.assetCount} shared asset${conflict.assetCount === 1 ? "" : "s"}</span>
        ${winner}
        ${duplicate}
      </div>
      <ul>${getConflictAssetLines(conflict)}</ul>
    </section>`;
  });
  if (conflicts.length > 3) {
    rows.push(`<p class="conflictTooltipMore">+${conflicts.length - 3} more conflict${conflicts.length - 3 === 1 ? "" : "s"}</p>`);
  }

  conflictTooltip.innerHTML = `<div class="conflictTooltipHeader">Conflicts for ${escapeHtml(mod.title)}</div>${rows.join("")}`;
  conflictTooltip.hidden = false;
  positionConflictTooltip(event);
}

function hideConflictTooltip() {
  conflictTooltip.hidden = true;
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
  if (event.key === "Escape" && !shareModalBackdrop.hidden) {
    event.preventDefault();
    closeShareImportModal();
    return;
  }
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
    const orderText = result.orderChanged ? " Load order applied." : "";
    showToast(
      `${preset.name} loaded. ${result.changed} mod change(s) applied.${orderText}${missingText}`.trim(),
      Boolean(result.missing?.length)
    );
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

sharePresetButton.addEventListener("click", copySelectedPresetShareCode);

importPresetButton.addEventListener("click", openShareImportModal);

deletePresetButton.addEventListener("click", deleteSelectedPreset);

shareModalCloseButton.addEventListener("click", closeShareImportModal);
shareModalCancelButton.addEventListener("click", closeShareImportModal);
sharePreviewButton.addEventListener("click", previewSharedPreset);
shareImportButton.addEventListener("click", importSharedPreset);
shareCodeInput.addEventListener("input", resetSharePreview);
shareModalBackdrop.addEventListener("click", (event) => {
  if (event.target === shareModalBackdrop) {
    closeShareImportModal();
  }
});

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

windowMinimizeButton.addEventListener("click", () => window.bellwrightMods.minimizeWindow());
windowCloseButton.addEventListener("click", () => window.bellwrightMods.closeWindow());
windowTitlebar.addEventListener("dblclick", (event) => {
  if (!event.target.closest(".windowControls")) {
    window.bellwrightMods.toggleMaximizeWindow();
  }
});

searchInput.addEventListener("input", render);

window.addEventListener("resize", () => {
  hideModTooltip();
  scheduleFitContent();
});
window.addEventListener("scroll", hideModTooltip, true);

window.bellwrightMods.onUpdateProgress(showUpdateProgress);
window.bellwrightMods.onGameRunningChanged(handleGameRunningChanged);

loadAppInfo();
loadPresets();
loadState();
