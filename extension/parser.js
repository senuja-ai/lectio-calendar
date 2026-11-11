// Lectio timetable parser. Runs in the content script (on the page you are
// signed in to) and turns one week's timetable into plain lesson objects, so
// no Lectio HTML ever leaves your browser. Also loaded by the Node tests.
(function (root) {
  "use strict";

  const TABLE_SELECTOR = "table.s2skema, table[id$='skema'], table[id$='Skema']";
  const BRICK_SELECTOR = ".s2skemabrik";
  const DATE_SRC = "(\\d{1,2})[/.](\\d{1,2})[-/.](\\d{4})";
  const DATE_RE = new RegExp(DATE_SRC, "g");
  const TIME_RE = /(?<!\d)(\d{1,2})[:.](\d{2})\s*(?:til|[-–—])\s*(\d{1,2})[:.](\d{2})(?!\d)/i;
  // "9/11-2026 23:00 til 10/11-2026 01:00" (activity crossing midnight)
  const EXPLICIT_RE = new RegExp(DATE_SRC + "\\s+(\\d{1,2})[:.](\\d{2})\\s*(?:til|[-–—])\\s*" +
                                 "(\\d{1,2})[/.](\\d{1,2})[-/.](\\d{4})\\s+(\\d{1,2})[:.](\\d{2})", "i");
  // Lectio prefixes changed/cancelled lessons with "Ændret!" / "Aflyst!": not the subject.
  const STATUS_LINE_RE = /^(?:ændret|aflyst|cancelled|changed|ny|new)!?$/i;
  const WEEKDAY_RE = /^(mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)(\s|$)/i;
  const EMPTY_MARKER_RE = /ingen (?:aktiviteter|lektioner|skemabrikker)/i;
  const OUTSIDE = "outside-week";

  class ParseError extends Error {}

  const pad = n => String(n).padStart(2, "0");
  // Dates are plain "YYYY-MM-DD" strings; arithmetic in UTC avoids DST surprises.
  function isoDate(day, month, year) {
    const d = new Date(Date.UTC(+year, +month - 1, +day));
    if (d.getUTCFullYear() !== +year || d.getUTCMonth() !== +month - 1 || d.getUTCDate() !== +day) {
      throw new ParseError(`Invalid date ${day}/${month}-${year}`);
    }
    return d.toISOString().slice(0, 10);
  }
  function addDays(iso, n) {
    const d = new Date(iso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function hhmm(h, m) {
    if (+h > 23 || +m > 59) throw new ParseError(`Invalid time ${h}:${m}`);
    return `${pad(+h)}:${pad(+m)}`;
  }

  // Tooltip text may contain markup (<br>, entities). Decode it in the inert
  // parsed document (no scripts run, nothing loads) and keep line breaks.
  function plainText(value, doc) {
    let text = value;
    if (/<[a-z!/]/i.test(value)) {
      const box = doc.createElement("div");
      box.innerHTML = value.replace(/<br\s*\/?>/gi, "\n");
      text = box.textContent;
    }
    return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).join("\n");
  }
  function field(text, labels) {
    const m = text.match(new RegExp(`^(?:${labels})\\s*:\\s*(.+)$`, "im"));
    return m ? m[1].trim() : "";
  }

  function parseBrick(brick, monday, doc) {
    const nodes = [...(brick.hasAttribute("data-tooltip") ? [brick] : []), ...brick.querySelectorAll("[data-tooltip]")];
    const raw = [...new Set(nodes.map(n => n.getAttribute("data-tooltip")))].join("\n");
    const text = plainText(raw || brick.innerHTML, doc);
    const dates = [...text.matchAll(DATE_RE)];
    if (!dates.length) return null;                       // Undated info/decoration brick.
    const first = dates[0];
    let startDate, startTime = null, endDate, endTime = null, allDay = false;
    try {
      startDate = isoDate(first[1], first[2], first[3]);
      const explicit = text.match(EXPLICIT_RE);
      const times = text.match(TIME_RE);
      if (explicit) {
        startTime = hhmm(explicit[4], explicit[5]);
        endDate = isoDate(explicit[6], explicit[7], explicit[8]);
        endTime = hhmm(explicit[9], explicit[10]);
      } else if (times) {
        startTime = hhmm(times[1], times[2]);
        endDate = startDate;
        endTime = hhmm(times[3], times[4]);
      } else {
        // Date-only brick ("10/11-2026 til 12/11-2026"): an all-day event;
        // the end date is exclusive, as in iCalendar.
        allDay = true;
        const last = dates[1] ? isoDate(dates[1][1], dates[1][2], dates[1][3]) : startDate;
        endDate = addDays(last, 1);
      }
      const startKey = allDay ? startDate : `${startDate}T${startTime}`;
      const endKey = allDay ? endDate : `${endDate}T${endTime}`;
      if (endKey <= startKey) throw new ParseError("Non-positive duration");
    } catch (error) {
      throw new ParseError(`Invalid activity date/time: ${text.split("\n")[0] || "?"}`);
    }
    // Keep activities overlapping the requested week (multi-day events may
    // start before Monday); anything entirely outside it is not this week.
    const weekEnd = addDays(monday, 7);
    const endsOnOrBefore = allDay ? endDate <= monday : `${endDate}T${endTime}` <= `${monday}T00:00`;
    if (endsOnOrBefore || startDate >= weekEnd) return OUTSIDE;

    let subject = field(text, "Fag|Subject|Titel|Title");
    if (!subject) {
      const before = text.slice(0, first.index).split("\n").map(l => l.trim())
        .filter(l => l && !STATUS_LINE_RE.test(l) && !WEEKDAY_RE.test(l));
      subject = before[0] || "";
    }
    subject = subject || field(text, "Hold|Class");      // Often only the course code.
    if (!subject) subject = (brick.textContent || "").replace(/\s+/g, " ").trim() || (allDay ? "Aktivitet" : "");
    if (!subject) throw new ParseError("Activity subject/course missing; the Lectio layout may have changed");

    const links = [...(brick.matches("a[href]") ? [brick] : []), ...brick.querySelectorAll("a[href]")];
    let activityId = null;
    for (const a of links) {
      try {
        const id = new URL(a.getAttribute("href"), "https://www.lectio.dk/").searchParams.get("absid");
        if (id && /^\d{1,20}$/.test(id)) { activityId = id; break; }
      } catch { /* ignore malformed links */ }
    }
    const cancelled = /\baflyst\b|\bcancelled\b/i.test(text) || brick.classList.contains("s2cancelled");
    const clip = (s, n) => s.length > n ? s.slice(0, n) : s;
    return {
      subject: clip(subject, 300), teachers: clip(field(text, "Lærere|Lærer|Teachers|Teacher"), 300),
      room: clip(field(text, "Lokaler|Lokale|Rooms|Room"), 300),
      start_date: startDate, start_time: startTime, end_date: endDate, end_time: endTime,
      all_day: allDay, notes: clip(text, 4000), activity_id: activityId, cancelled
    };
  }

  /**
   * Parse one week page. Returns {lessons, emptyMarker}. Throws ParseError for
   * a login page, a missing table, or bricks in a format we don't understand:
   * failing is better than publishing an empty week by mistake.
   */
  function parseWeek(doc, monday) {
    if (doc.querySelector("input[type='password']")) {
      throw new ParseError("Lectio showed a login page. Sign in to Lectio again, then retry.");
    }
    const table = doc.querySelector(TABLE_SELECTOR);
    if (!table) {
      if (/unilogin|mitid/i.test(doc.body ? doc.body.textContent : "")) {
        throw new ParseError("Lectio showed a login page. Sign in to Lectio again, then retry.");
      }
      throw new ParseError("Timetable table missing: wrong class ID, or Lectio changed its page layout.");
    }
    const bricks = [...table.querySelectorAll(BRICK_SELECTOR)];
    const lessons = new Map();
    let outside = 0;
    for (const brick of bricks) {
      const lesson = parseBrick(brick, monday, doc);
      if (lesson === null) continue;
      if (lesson === OUTSIDE) { outside++; continue; }
      const key = [lesson.activity_id, lesson.start_date, lesson.start_time, lesson.end_date, lesson.end_time,
                   lesson.subject, lesson.teachers, lesson.room].join("|");
      if (!lessons.has(key)) lessons.set(key, lesson);
    }
    if (bricks.length && !lessons.size) {
      if (outside) throw new ParseError("Lectio returned activities from a different week.");
      const sample = plainText(bricks[0].getAttribute("data-tooltip") || bricks[0].innerHTML, doc).slice(0, 120);
      throw new ParseError(`Unsupported Lectio brick format (first brick: "${sample}")`);
    }
    const sorted = [...lessons.values()].sort((a, b) =>
      `${a.start_date}T${a.start_time || ""}`.localeCompare(`${b.start_date}T${b.start_time || ""}`) || a.subject.localeCompare(b.subject));
    return {lessons: sorted, emptyMarker: !sorted.length && EMPTY_MARKER_RE.test(table.textContent || "")};
  }

  const api = {parseWeek, ParseError, TABLE_SELECTOR};
  root.LectioParser = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
