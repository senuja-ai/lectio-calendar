const baseInput = document.getElementById("base");
const keyInput = document.getElementById("key");
const button = document.getElementById("sync");
const statusElement = document.getElementById("status");
async function render() {
  const {status} = await chrome.storage.local.get("status");
  statusElement.textContent = status ? `${status.text}${status.lastSynced ? `\nLast success: ${new Date(status.lastSynced).toLocaleString()}` : ""}` : "Not synchronized yet.";
  const view = document.getElementById("view");
  const viewUrl = status?.viewUrl || "";
  view.hidden = !viewUrl;
  document.getElementById("share").value = viewUrl;
  document.getElementById("shareBox").hidden = !viewUrl;
  if (viewUrl) view.href = viewUrl;
}
chrome.storage.local.get("settings").then(({settings}) => {
  baseInput.value = settings?.base || "";
  keyInput.value = settings?.key || "";
});
render();
button.addEventListener("click", async () => {
  try {
    const url = new URL(baseInput.value.trim());
    const loopback = ["127.0.0.1", "localhost"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
        url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("Use your Worker's https:// address, e.g. https://lectio-calendar.yourname.workers.dev");
    }
    const key = keyInput.value.trim();
    if (key.length < 32) throw new Error("Paste the UPLOAD_TOKEN you set on the server (at least 32 characters)");
    // Request the specific hosted API origin during the user's click gesture.
    if (!loopback && !(await chrome.permissions.request({origins: [`${url.origin}/*`]}))) {
      throw new Error("Calendar server access was not granted");
    }
    button.disabled = true;
    statusElement.textContent = "Reading your Lectio timetable…";
    await chrome.storage.local.set({settings: {base: url.origin, key}});
    const result = await chrome.runtime.sendMessage({type: "SYNC"});
    if (!result?.ok) throw new Error(result?.error || "Synchronization failed");
    await render();
  } catch (error) {
    statusElement.textContent = error.message;
  } finally { button.disabled = false; }
});
document.getElementById("copyShare").addEventListener("click", async () => {
  const value = document.getElementById("share").value;
  try { await navigator.clipboard.writeText(value); document.getElementById("copyShare").textContent = "Copied"; }
  catch { document.getElementById("share").select(); }
});
