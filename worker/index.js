// Lectio class calendar on Cloudflare Workers.
//
//   POST /api/v1/class/:school/:class/snapshot   extension uploads parsed lessons (upload key)
//   GET  /api/v1/bridge/config                   extension asks which weeks to read (upload key)
//   GET  /class/:school/:class#key=…             the calendar page (key stays in the browser)
//   GET  /api/v1/class/:school/:class/events.json  page data (calendar key, Bearer header)
//   GET  /api/v1/class/:school/:class/schedule.ics?key=…&on=…&off=…
//                                                 personal iCal feed for Google/Apple/Outlook
//
// Settings come from Worker secrets/vars: SCHOOL_ID, CLASS_ID, UPLOAD_TOKEN,
// FEED_TOKEN (secrets), PAST_WEEKS, FUTURE_WEEKS (vars). Data lives in the
// KV namespace bound as TIMETABLE. The page is a static asset (ASSETS).

const TZ = "Europe/Copenhagen";
const MAX_UPLOAD = 2_000_000;
const NO_STORE = {"Cache-Control": "no-store"};
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000",
};
const DEFAULT_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; " +
                 "img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// Which non-subject items are shown by default. Subjects are always on;
// whole-class / whole-school events (class photo, exams, field trips, theme
// days, all-day items) are on; clubs, committees and optional activities start
// off. Mostly no word boundaries: Danish compounds ("Klassefoto",
// "Trænerakademiet") must match. The page and every personal feed use this.
const OPTIONAL_RE = /(club|klub|udvalg|committee|frivillig|voluntary|study ?hall|akademi|academy|orkester|pop-?up|café|instamøde|kursus|skriver|\bteam\b|\bkor\b|\bchoir\b|\bband\b|\bmun\b)/i;
const SCHOOL_RE = /(klasse|class|alle elever|all students|fælles|school|skole|eksamen|exam|prøve|\btest\b|field ?trip|ekskursion|studietur|excursion|foto|photo|ferie|holiday|fridag|(dag|day)\b|aula|intro|orientering|information|forældre|parents|graduation|dimission|oprydning|tidying|cleaning)/i;
const COURSE_TITLE_RE = /^\S+\s+[A-Za-zæøåÆØÅ]+?(?:A|B)?(?:HL|SL)\b/;

class HttpError extends Error {
  constructor(status, message, headers = {}) { super(message); this.status = status; this.headers = headers; }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {status, headers: {"Content-Type": "application/json; charset=utf-8", ...NO_STORE, ...headers}});

function safeEqual(a, b) {                        // Constant-time string compare.
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}
async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function addDays(iso, n) { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function weekday(iso) { return (new Date(iso + "T00:00:00Z").getUTCDay() + 6) % 7; }   // Monday = 0
function isoWeek(iso) {                          // ISO 8601 week, as Lectio's ?week=WWYYYY uses
  const thursday = new Date(iso + "T00:00:00Z");
  thursday.setUTCDate(thursday.getUTCDate() + 3 - weekday(iso));      // Thursday decides the year
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((thursday - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return {year, week};
}
function todayInCopenhagen(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"}).format(now);
}

function settings(env) {
  const int = (value, name, min, max) => {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new HttpError(503, `Server not configured: set ${name} (see README).`);
    return n;
  };
  const s = {
    schoolId: int(env.SCHOOL_ID, "SCHOOL_ID", 1, 1e9), classId: int(env.CLASS_ID, "CLASS_ID", 1, 1e15),
    uploadToken: String(env.UPLOAD_TOKEN || ""), feedToken: String(env.FEED_TOKEN || ""),
    pastWeeks: int(env.PAST_WEEKS ?? 1, "PAST_WEEKS", 0, 4), futureWeeks: int(env.FUTURE_WEEKS ?? 2, "FUTURE_WEEKS", 0, 8),
  };
  if (s.uploadToken.length < 32 || s.feedToken.length < 32 || s.uploadToken === s.feedToken) {
    throw new HttpError(503, "Server not configured: UPLOAD_TOKEN and FEED_TOKEN must be different and at least 32 characters.");
  }
  if (!env.TIMETABLE) throw new HttpError(503, "Server not configured: KV namespace TIMETABLE is not bound.");
  return s;
}

function weekPlan(s, now = new Date()) {
  const today = todayInCopenhagen(now);
  const monday = addDays(today, -weekday(today));
  const weeks = [];
  for (let offset = -s.pastWeeks; offset <= s.futureWeeks; offset++) {
    const day = addDays(monday, offset * 7);
    const {year, week} = isoWeek(day);
    weeks.push({monday: day, url: `https://www.lectio.dk/lectio/${s.schoolId}/SkemaNy.aspx?klasseid=${s.classId}&week=${String(week).padStart(2, "0")}${year}`});
  }
  return weeks;
}

// Wrong keys: after 20 failures in 10 minutes from one address, answer 429.
// (Keys are 256-bit random; this keeps scanners away. Best effort, per isolate.)
const failures = new Map();
function blocked(ip) {
  const now = Date.now(), recent = (failures.get(ip) || []).filter(t => now - t < 600_000);
  if (recent.length) failures.set(ip, recent); else failures.delete(ip);
  return recent.length >= 20;
}
function recordFailure(ip) {
  if (failures.size > 10_000) failures.clear();
  failures.set(ip, [...(failures.get(ip) || []), Date.now()]);
}

function requireKey(supplied, expected, message) {
  if (!supplied || !safeEqual(supplied, expected)) throw new HttpError(401, message, {"WWW-Authenticate": "Bearer"});
}
const bearer = request => (request.headers.get("Authorization") || "").replace(/^Bearer /, "");

// ---------------------------------------------------------------------------
// Upload: validate the extension's parsed lessons, enrich, store in KV
// ---------------------------------------------------------------------------
const DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
function checkLesson(l, monday) {
  const fail = why => { throw new HttpError(422, `Invalid lesson data (${why})`); };
  const keys = ["subject", "teachers", "room", "start_date", "start_time", "end_date", "end_time", "all_day", "notes", "activity_id", "cancelled"];
  if (!l || typeof l !== "object" || Array.isArray(l)) fail("not an object");
  for (const k of Object.keys(l)) if (!keys.includes(k)) fail(`unknown field ${k}`);
  const str = (k, max, min = 0) => { if (typeof l[k] !== "string" || l[k].length < min || l[k].length > max) fail(k); };
  str("subject", 300, 1); str("teachers", 300); str("room", 300); str("notes", 4000);
  if (typeof l.all_day !== "boolean" || typeof l.cancelled !== "boolean") fail("flags");
  if (!(l.activity_id === null || (typeof l.activity_id === "string" && /^\d{1,20}$/.test(l.activity_id)))) fail("activity_id");
  if (!DATE.test(l.start_date) || !DATE.test(l.end_date)) fail("dates");
  if (l.all_day ? (l.start_time !== null || l.end_time !== null) : (!TIME.test(l.start_time || "") || !TIME.test(l.end_time || ""))) fail("times");
  const start = l.all_day ? l.start_date : `${l.start_date}T${l.start_time}`;
  const end = l.all_day ? l.end_date : `${l.end_date}T${l.end_time}`;
  if (end <= start) fail("ends before it starts");
  const weekEnd = addDays(monday, 7);
  if ((l.all_day ? l.end_date <= monday : end <= `${monday}T00:00`) || l.start_date >= weekEnd) fail("outside its week");
}

function cleanNotes(lesson) {
  return lesson.notes.split("\n").map(s => s.trim()).filter(line => line && line !== lesson.subject &&
    !/^(Hold|Lærere?|Lokaler?|Teachers?|Rooms?)\s*:/i.test(line) && !/^\d{1,2}[/.]\d{1,2}[-/.]\d{4}/.test(line) &&
    !/^(ændret|aflyst|cancelled|changed)!?$/i.test(line)).join("\n");
}

async function enrich(lessons, s) {
  const events = [];
  for (const l of lessons) {
    const hold = l.notes.match(/^Hold:\s*(.+)$/im);
    let course = hold ? hold[1].trim() : "";
    if (!course && COURSE_TITLE_RE.test(l.subject)) course = l.subject;   // untitled lesson = course code
    const groupKey = course ? `course:${course.toLowerCase()}` : `event:${l.subject.trim().toLowerCase()}`;
    const identity = l.activity_id || `${l.start_date}T${l.start_time}|${l.subject}|${l.teachers}`;
    events.push({
      id: await sha256(`${s.schoolId}:${s.classId}:${identity}`),
      title: l.subject, course, teacher: l.teachers, location: l.room, notes: cleanNotes(l),
      all_day: l.all_day, cancelled: l.cancelled,
      start: l.all_day ? l.start_date : `${l.start_date}T${l.start_time}`,
      end: l.all_day ? l.end_date : `${l.end_date}T${l.end_time}`,
      group: (await sha256(groupKey)).slice(0, 10), kind: course ? "course" : "event",
    });
  }
  // Default visibility per group (a group counts as all-day only if every item is).
  const allDay = new Map();
  for (const e of events) allDay.set(e.group, (allDay.get(e.group) ?? true) && e.all_day);
  for (const e of events) {
    e.default_on = e.kind === "course" ? true
      : OPTIONAL_RE.test(e.title) ? false
      : allDay.get(e.group) || SCHOOL_RE.test(e.title);
  }
  events.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  return events;
}

function className(events) {                       // "3i maHL" -> "3i"
  const counts = new Map();
  for (const e of events) { const m = e.course.match(/^(\S+)\s/); if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1); }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

async function upload(request, env, s) {
  requireKey(bearer(request), s.uploadToken, "Invalid upload key");
  if ((request.headers.get("Content-Type") || "").split(";")[0].trim() !== "application/json") throw new HttpError(415, "Use application/json");
  const text = await request.text();
  if (text.length > MAX_UPLOAD) throw new HttpError(413, "Snapshot is too large");
  let body;
  try { body = JSON.parse(text); } catch { throw new HttpError(422, "Invalid snapshot format"); }
  if (!body || typeof body.captured_at !== "string" || !Array.isArray(body.weeks)) throw new HttpError(422, "Invalid snapshot format");
  const captured = Date.parse(body.captured_at);
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(body.captured_at) || !Number.isFinite(captured) || Math.abs(Date.now() - captured) > 600_000) {
    throw new HttpError(422, "Snapshot time must include a timezone and be within ten minutes of now");
  }
  const plan = new Map(weekPlan(s).map(w => [w.monday, w.url]));
  const mondays = body.weeks.map(w => w && w.monday);
  if (body.weeks.length !== plan.size || new Set(mondays).size !== plan.size || !mondays.every(m => plan.has(m))) {
    throw new HttpError(422, "Upload must contain every configured week exactly once");
  }
  const lessons = new Map();
  let explicitEmpty = false;
  for (const week of body.weeks) {
    const expected = new URL(plan.get(week.monday));
    let actual;
    try { actual = new URL(week.url); } catch { throw new HttpError(422, "Invalid week URL"); }
    const params = u => [...u.searchParams].sort().join("&");
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || params(actual) !== params(expected) || actual.hash) {
      throw new HttpError(422, "Snapshot URL does not match the configured class and week");
    }
    if (!Array.isArray(week.lessons) || week.lessons.length > 500) throw new HttpError(422, "Invalid lesson list");
    if (!week.lessons.length && week.empty_marker === true) explicitEmpty = true;
    for (const l of week.lessons) {
      checkLesson(l, week.monday);
      // Multi-day activities appear in several weeks: keep one copy.
      const identity = l.activity_id || `${l.start_date}T${l.start_time}|${l.subject}|${l.teachers}`;
      if (!lessons.has(identity)) lessons.set(identity, l);
    }
  }
  if (!lessons.size && !explicitEmpty) {
    // One empty week (holiday) is fine; every week empty almost always means
    // something broke. Keep the last good calendar.
    throw new HttpError(422, "No lessons found in any synchronized week; the last calendar was kept. Check the class ID.");
  }
  const key = `snapshot:${s.schoolId}:${s.classId}`;
  const previous = await env.TIMETABLE.get(key, "json");
  if (previous && captured <= previous.captured) throw new HttpError(409, "A newer snapshot is already stored");
  const events = await enrich([...lessons.values()], s);
  const received = new Date().toISOString();
  await env.TIMETABLE.put(key, JSON.stringify({captured, received, class_name: className(events), events}));
  return json({ok: true, lessons: events.length, last_synced: received});
}

async function readSnapshot(env, s) {
  const record = await env.TIMETABLE.get(`snapshot:${s.schoolId}:${s.classId}`, "json");
  if (!record) throw new HttpError(503, "No timetable synchronized yet. Sign in to Lectio and click Save and sync in the extension.", {"Retry-After": "60"});
  return record;
}

// ---------------------------------------------------------------------------
// iCalendar (RFC 5545)
// ---------------------------------------------------------------------------
const VTIMEZONE = [
  "BEGIN:VTIMEZONE", "TZID:Europe/Copenhagen", "X-LIC-LOCATION:Europe/Copenhagen",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST", "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET", "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD", "END:VTIMEZONE",
];
const escapeText = v => String(v).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
function fold(line) {                              // Max 75 octets per line, never splitting a character.
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts = []; let current = "", size = 0, limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (size + n > limit) { parts.push(current); current = ""; size = 0; limit = 74; }
    current += ch; size += n;
  }
  parts.push(current);
  return parts.join("\r\n ");
}
const icsDate = iso => iso.replace(/-/g, "");                                   // 2026-11-10 -> 20261110
const icsLocal = iso => iso.replace(/-/g, "").replace(":", "") + "00";          // 2026-11-10T08:00 -> 20261110T080000
const icsUtc = iso => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");

function buildIcs(record, events, s) {
  const name = record.class_name ? `${record.class_name} timetable` : "Class timetable";
  const stamp = icsUtc(record.received);
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Lectio class calendar//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(name)}`, `X-WR-TIMEZONE:${TZ}`, "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H", ...VTIMEZONE];
  for (const e of events) {
    const description = [e.course && `Course: ${e.course}`, e.teacher && `Teacher: ${e.teacher}`, e.notes].filter(Boolean).join("\n");
    lines.push("BEGIN:VEVENT", `UID:${e.id}@lectio-class-calendar`, `DTSTAMP:${stamp}`,
      e.all_day ? `DTSTART;VALUE=DATE:${icsDate(e.start)}` : `DTSTART;TZID=${TZ}:${icsLocal(e.start)}`,
      e.all_day ? `DTEND;VALUE=DATE:${icsDate(e.end)}` : `DTEND;TZID=${TZ}:${icsLocal(e.end)}`,
      `SUMMARY:${escapeText((e.cancelled ? "AFLYST: " : "") + e.title)}`);
    if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
    if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
    // Cancelled lessons stay visible (prefixed AFLYST) but don't block time.
    lines.push("STATUS:CONFIRMED", `TRANSP:${e.all_day || e.cancelled ? "TRANSPARENT" : "OPAQUE"}`,
      `URL:https://www.lectio.dk/lectio/${s.schoolId}/SkemaNy.aspx?klasseid=${s.classId}`, "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

// Personal feed: ?on=GROUPS&off=GROUPS on top of the default rule.
function selectEvents(events, params) {
  const ids = name => new Set((params.get(name) || "").split(",").filter(g => /^[0-9a-f]{10}$/.test(g)));
  if (!params.has("on") && !params.has("off") && params.get("v") !== "2") return events;   // plain link: everything
  const on = ids("on"), off = ids("off");
  return events.filter(e => !off.has(e.group) && (on.has(e.group) || e.default_on));
}

async function cached(request, body, contentType, received, extra = {}) {
  const etag = `"${(await sha256(body)).slice(0, 32)}"`;
  const headers = {"Content-Type": contentType, "Cache-Control": "private, max-age=1800", ETag: etag,
                   "X-Lectio-Last-Synced": received, ...extra};
  const tags = (request.headers.get("If-None-Match") || "").split(",").map(t => t.trim().replace(/^W\//, ""));
  if (tags.includes(etag)) return new Response(null, {status: 304, headers});
  return new Response(body, {headers});
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname, method = request.method;
  if (path === "/healthz") return json({ok: true});
  if (path === "/") return json({service: "Lectio class calendar"});
  if (method === "OPTIONS") return new Response(null, {status: 204});

  const s = settings(env);
  const classPath = path.match(/^\/(?:api\/v1\/)?class\/(\d+)\/(\d+)(\/[a-z.]+)?$/);
  if (classPath && (Number(classPath[1]) !== s.schoolId || Number(classPath[2]) !== s.classId)) {
    throw new HttpError(404, "Class is not configured");
  }

  if (path === "/api/v1/bridge/config" && method === "GET") {
    requireKey(bearer(request), s.uploadToken, "Invalid upload key");
    const record = await env.TIMETABLE.get(`snapshot:${s.schoolId}:${s.classId}`, "json");
    return json({school_id: s.schoolId, class_id: s.classId, weeks: weekPlan(s),
                 // Key after "#": browsers never send it to the server, so it stays out of logs.
                 view_path: `/class/${s.schoolId}/${s.classId}#key=${s.feedToken}`,
                 last_synced: record ? record.received : null});
  }
  if (classPath && classPath[3] === "/snapshot" && path.startsWith("/api/") && method === "POST") return upload(request, env, s);

  if (classPath && classPath[3] === "/events.json" && path.startsWith("/api/") && method === "GET") {
    requireKey(bearer(request) || url.searchParams.get("key"), s.feedToken, "A valid calendar key is required");
    const record = await readSnapshot(env, s);
    const body = JSON.stringify({last_synced: record.received, class_name: record.class_name, events: record.events});
    return cached(request, body, "application/json; charset=utf-8", record.received, NO_STORE);
  }
  if (classPath && classPath[3] === "/schedule.ics" && path.startsWith("/api/") && method === "GET") {
    requireKey(url.searchParams.get("key"), s.feedToken, "A valid calendar key is required");
    const record = await readSnapshot(env, s);
    const body = buildIcs(record, selectEvents(record.events, url.searchParams), s);
    return cached(request, body, "text/calendar; charset=utf-8", record.received,
                  {"Content-Disposition": 'inline; filename="timetable.ics"'});
  }
  if (classPath && !classPath[3] && path.startsWith("/class/") && method === "GET") {
    // Static page shell; it reads the key from #key=… and fetches events.json.
    const asset = await env.ASSETS.fetch(new Request(new URL("/calendar.html", url)));
    if (!asset.ok) throw new HttpError(500, "Calendar page missing from the deployment");
    return new Response(await asset.text(), {headers: {"Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache", "Content-Security-Policy": PAGE_CSP}});
  }
  throw new HttpError(404, "Not found");
}

export default {
  async fetch(request, env) {
    const ip = request.headers.get("CF-Connecting-IP") || "local";
    let response;
    if (blocked(ip) && new URL(request.url).pathname !== "/healthz") {
      response = json({detail: "Too many invalid keys. Try again later."}, 429, {"Retry-After": "600"});
    } else {
      try {
        response = await route(request, env);
      } catch (error) {
        if (!(error instanceof HttpError)) {
          console.error(error);
          error = new HttpError(500, "Internal error");
        }
        if (error.status === 401) recordFailure(ip);
        response = json({detail: error.message}, error.status, error.headers);
      }
    }
    // Security headers on everything (copy: asset responses are immutable).
    response = new Response(response.body, response);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!response.headers.has(name)) response.headers.set(name, value);
    if (!response.headers.has("Content-Security-Policy")) response.headers.set("Content-Security-Policy", DEFAULT_CSP);
    return response;
  },
};

// Exposed for tests.
export const _internal = {weekPlan, isoWeek, buildIcs, selectEvents, enrich, fold, todayInCopenhagen};
