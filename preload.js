const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bellwrightMods", {
  getAppInfo: () => ipcRenderer.invoke("app:getInfo"),
  getState: () => ipcRenderer.invoke("mods:getState"),
  enable: (payload) => ipcRenderer.invoke("mods:enable", payload),
  disable: (payload) => ipcRenderer.invoke("mods:disable", payload),
  showTooltip: (payload) => ipcRenderer.invoke("mods:showTooltip", payload),
  hideTooltip: () => ipcRenderer.invoke("mods:hideTooltip"),
  onTooltip: (callback) => ipcRenderer.on("tooltip:setMod", (_event, mod) => callback(mod)),
  openModsFolder: () => ipcRenderer.invoke("mods:openModsFolder"),
  launchGame: () => ipcRenderer.invoke("mods:launchGame"),
  openDonate: () => ipcRenderer.invoke("app:openDonate"),
  openDiscord: () => ipcRenderer.invoke("app:openDiscord")
});
