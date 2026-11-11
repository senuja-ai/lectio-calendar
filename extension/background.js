// Only the extension UI may start uploads. Never expose the synchronization key
// to content scripts or Lectio. Host permissions enable uploads from this worker.
// Best effort: some Chrome versions only support setAccessLevel on
// storage.session and reject for storage.local. A rejection here must not
// break synchronization (content.js never reads storage anyway).
const ready = Promise.resolve()
  .then(() => chrome.storage.local.setAccessLevel?.({accessLevel: "TRUSTED_CONTEXTS"}))
  .catch(() => {});
let inFlight = null;

async function ensureAlarm() {
  if (!(await chrome.alarms.get("lectio-sync"))) {
    await chrome.alarms.create("lectio-sync", {periodInMinutes: 30});
  }
}
async function api(base, key, path, body) {
  let response;
  try {
    response = await fetch(base + path, {
      method: body ? "POST" : "GET", redirect: "error", cache: "no-store",
      credentials: "omit", signal: AbortSignal.timeout(body ? 60000 : 20000),
      headers: {Authorization: `Bearer ${key}`, ...(body ? {"Content-Type": "application/json"} : {})},
      ...(body ? {body: JSON.stringify(body)} : {})
    });
  } catch {
    throw new Error(`Cannot reach the calendar server at ${base}. Check the server address in this popup.`);
  }
  let result = null;
  try { result = await response.json(); } catch { /* non-JSON error page */ }
  if (!response.ok) {
    if (response.status === 401) throw new Error("Upload key rejected. Paste the UPLOAD_TOKEN you set on the server.");
    throw new Error(typeof result?.detail === "string" ? result.detail : `Server returned HTTP ${response.status}`);
  }
  if (!result) throw new Error("Calendar server sent an unreadable response");
  return result;
}
async function sync() {
  await ready;
  const {settings} = await chrome.storage.local.get("settings");
  if (!settings) throw new Error("Enter your calendar server address and upload key first");
  const config = await api(settings.base, settings.key, "/api/v1/bridge/config");
  const tabs = await chrome.tabs.query({url: "https://www.lectio.dk/lectio/*"});
  // Prefer a tab on the configured school; skip login/logout pages and
  // discarded (sleeping) tabs that cannot run the content script.
  const usable = tabs.filter(t => /\/lectio\/\d+\//.test(t.url || "") && !/login|logout/i.test(t.url || "") && !t.discarded);
  const tab = usable.find(t => (t.url || "").includes(`/lectio/${config.school_id}/`)) || usable[0];
  if (!tab) throw new Error("Open Lectio in a tab and sign in normally, then retry");
  const capturedAt = new Date().toISOString();
  if (!Array.isArray(config.weeks) || config.weeks.length < 1 || config.weeks.length > 13) {
    throw new Error("Server supplied an invalid week plan");
  }
  const weeks = [];
  for (const week of config.weeks) {
    let response;
    try { response = await chrome.tabs.sendMessage(tab.id, {type: "FETCH_WEEK", url: week.url, monday: week.monday}); }
    catch { throw new Error("Reload your signed-in Lectio tab, then retry"); }
    if (!response?.ok) throw new Error(response?.error || "Lectio timetable fetch failed");
    // Only parsed lessons are uploaded, never Lectio HTML.
    weeks.push({monday: week.monday, url: response.url, lessons: response.lessons, empty_marker: !!response.emptyMarker});
  }
  const result = await api(settings.base, settings.key,
    `/api/v1/class/${config.school_id}/${config.class_id}/snapshot`, {captured_at: capturedAt, weeks});
  await chrome.storage.local.set({status: {ok: true, text: `Synchronized ${result.lessons} lessons`,
    lastSynced: result.last_synced, viewUrl: settings.base + config.view_path}});
  return result;
}
function runSync() {
  if (inFlight) return inFlight;
  inFlight = sync().catch(async error => {
    const {status} = await chrome.storage.local.get("status");
    await chrome.storage.local.set({status: {...status, ok: false, text: error.message}});
    throw error;
  }).finally(() => { inFlight = null; });
  return inFlight;
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html") || message.type !== "SYNC") return;
  runSync().then(() => reply({ok: true})).catch(error => reply({ok: false, error: error.message}));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "lectio-sync") runSync().catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => ensureAlarm());
chrome.runtime.onStartup.addListener(() => ensureAlarm());
ensureAlarm().catch(() => {});
