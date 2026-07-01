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
const aboutMaker = document.querySelector("#aboutMaker");
const appVersion = document.querySelector("#appVersion");
const donateButton = document.querySelector("#donateButton");
const discordButton = document.querySelector("#discordButton");
const toast = document.querySelector("#toast");
const dropColumns = [...document.querySelectorAll(".modColumn")];

let state = null;
let busy = false;
let toastTimer = null;

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

function setBusy(value) {
  busy = value;
  refreshButton.disabled = value;
  folderButton.disabled = value;
  launchButton.disabled = value;
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

refreshButton.addEventListener("click", loadState);

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

searchInput.addEventListener("input", render);

window.addEventListener("resize", hideModTooltip);
window.addEventListener("scroll", hideModTooltip, true);

loadAppInfo();
loadState();
