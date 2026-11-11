// Runs on Lectio pages. Loads the requested week of the class timetable using
// the session you are already signed in with, parses it here in your browser
// (parser.js), and hands only the lesson list back to the extension.
// No password, cookie or Lectio HTML is read out or sent anywhere.
(() => {
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || message.type !== "FETCH_WEEK") return;
    (async () => {
      const url = new URL(message.url);
      if (url.origin !== "https://www.lectio.dk" ||
          !/^\/lectio\/\d+\/SkemaNy\.aspx$/.test(url.pathname) ||
          !/^\d+$/.test(url.searchParams.get("klasseid") || "") ||
          !/^\d{6}$/.test(url.searchParams.get("week") || "") ||
          [...url.searchParams.keys()].some(key => !["klasseid", "week"].includes(key)) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(message.monday || "")) {
        throw new Error("Invalid class timetable request");
      }
      let response;
      try {
        response = await fetch(url.href, {credentials: "same-origin", redirect: "follow",
          cache: "no-store", signal: AbortSignal.timeout(20000)});
      } catch {
        // An expired session redirects to MitID on another site, which the
        // browser reports as a network error.
        throw new Error("Could not load the Lectio timetable. Your Lectio session has probably expired: " +
                        "sign in to Lectio (MitID) in this browser, reload the Lectio tab, then retry.");
      }
      const finalUrl = new URL(response.url);
      if (finalUrl.origin !== "https://www.lectio.dk" ||
          (response.redirected && !/\/SkemaNy\.aspx$/i.test(finalUrl.pathname))) {
        throw new Error("Sign in to Lectio again, then retry.");
      }
      if (!response.ok) throw new Error(`Lectio returned HTTP ${response.status}`);
      const html = await response.text();
      if (html.length > 5000000) throw new Error("Lectio page is too large");
      // DOMParser documents are inert: no scripts run and nothing loads.
      const doc = new DOMParser().parseFromString(html, "text/html");
      const {lessons, emptyMarker} = globalThis.LectioParser.parseWeek(doc, message.monday);
      return {ok: true, url: url.href, lessons, emptyMarker};
    })().then(reply).catch(error => reply({ok: false, error: error.message}));
    return true;
  });
})();
