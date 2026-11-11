// Worker tests: run the real fetch handler with in-memory KV and assets.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import worker, {_internal} from "../worker/index.js";

const PAGE = readFileSync(new URL("../worker/public/calendar.html", import.meta.url), "utf8");
const UP = "u".repeat(43), FEED = "f".repeat(43);
function makeEnv(over = {}) {
  const kv = new Map();
  return {
    SCHOOL_ID: "21", CLASS_ID: "31", UPLOAD_TOKEN: UP, FEED_TOKEN: FEED, PAST_WEEKS: "1", FUTURE_WEEKS: "2",
    TIMETABLE: {get: async (k, t) => kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null, put: async (k, v) => kv.set(k, v)},
    ASSETS: {fetch: async req => new URL(req.url).pathname === "/calendar.html" ? new Response(PAGE) : new Response("nope", {status: 404})},
    ...over,
  };
}
let ipCounter = 0;
const call = (env, path, {method = "GET", key, body, ip, headers = {}} = {}) => worker.fetch(new Request("https://cal.example" + path, {
  method, body: body ? JSON.stringify(body) : undefined,
  headers: {"CF-Connecting-IP": ip || `10.0.0.${++ipCounter % 250}`, ...(key ? {Authorization: `Bearer ${key}`} : {}),
            ...(body ? {"Content-Type": "application/json"} : {}), ...headers}}), env);

async function plan(env) { return (await (await call(env, "/api/v1/bridge/config", {key: UP})).json()).weeks; }
const lesson = (date, start, end, subject, extra = {}) => ({subject, teachers: "AB", room: "A12", start_date: date, start_time: start,
  end_date: date, end_time: end, all_day: false, notes: `${subject}\n${date} ${start} til ${end}\nLærer: AB`, activity_id: null, cancelled: false, ...extra});
async function snapshot(env, perWeek = (monday, i) => [
  lesson(monday, "08:00", "09:35", "3i maHL", {notes: "3i maHL\nHold: 3i maHL\nLærer: Michael (MI)", activity_id: `1${i}`}),
  lesson(monday, "10:00", "11:30", "Euler's method", {notes: "Euler's method\nHold: 3i maHL\nNote: bring calculator, ruler; pens", activity_id: `2${i}`}),
  lesson(monday, "12:00", "13:00", "Psychology", {notes: "Hold: 3i psHL, 3i psSL", activity_id: `3${i}`, cancelled: true}),
  lesson(monday, "14:00", "15:00", "Chess Club", {activity_id: `4${i}`}),
  lesson(monday, "15:00", "15:30", "Klassefoto", {activity_id: `5${i}`}),
  {...lesson(monday, null, null, "Studietur"), all_day: true, start_time: null, end_time: null, end_date: monday.replace(/\d\d$/, d => String(+d + 1).padStart(2, "0")), activity_id: `6${i}`},
]) {
  const weeks = (await plan(env)).map((w, i) => ({monday: w.monday, url: w.url, lessons: perWeek(w.monday, i), empty_marker: false}));
  return {captured_at: new Date().toISOString(), weeks};
}

test("unconfigured server explains what to set", async () => {
  const r = await call(makeEnv({UPLOAD_TOKEN: ""}), "/api/v1/bridge/config", {key: UP});
  assert.equal(r.status, 503); assert.match((await r.json()).detail, /UPLOAD_TOKEN/);
});

test("config: needs upload key, plans ISO weeks, page link keeps key after #", async () => {
  const env = makeEnv();
  assert.equal((await call(env, "/api/v1/bridge/config", {key: FEED})).status, 401);
  const cfg = await (await call(env, "/api/v1/bridge/config", {key: UP})).json();
  assert.equal(cfg.weeks.length, 4);
  assert.match(cfg.weeks[0].url, /^https:\/\/www\.lectio\.dk\/lectio\/21\/SkemaNy\.aspx\?klasseid=31&week=\d{6}$/);
  assert.equal(cfg.view_path, `/class/21/31#key=${FEED}`);
});

test("upload → page data with groups, defaults and class name", async () => {
  const env = makeEnv();
  const r = await call(env, "/api/v1/class/21/31/snapshot", {method: "POST", key: UP, body: await snapshot(env)});
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await r.json()).lessons, 24);
  const data = await (await call(env, "/api/v1/class/21/31/events.json", {key: FEED})).json();
  assert.equal(data.class_name, "3i");
  const by = t => data.events.find(e => e.title === t);
  assert.equal(by("Euler's method").course, "3i maHL");
  assert.equal(by("Euler's method").group, by("3i maHL").group);           // same course, same switch
  assert.deepEqual(["3i maHL", "Chess Club", "Klassefoto", "Studietur"].map(t => by(t).default_on), [true, false, true, true]);
  assert.equal(by("3i maHL").teacher, "AB"); assert.equal(by("3i maHL").notes.includes("Hold:"), false);
  assert.equal((await call(env, "/api/v1/class/21/31/events.json", {key: UP})).status, 401);
});

test("personal iCal feed follows defaults and the student's choices", async () => {
  const env = makeEnv();
  await call(env, "/api/v1/class/21/31/snapshot", {method: "POST", key: UP, body: await snapshot(env)});
  const data = await (await call(env, "/api/v1/class/21/31/events.json", {key: FEED})).json();
  const group = t => data.events.find(e => e.title === t).group;
  const feed = async q => (await call(env, `/api/v1/class/21/31/schedule.ics?key=${FEED}${q}`)).text();
  const titles = ics => [...new Set([...ics.matchAll(/^SUMMARY:(.*)$/gm)].map(m => m[1].trim()))].sort();
  assert.deepEqual(titles(await feed("&v=2")), ["3i maHL", "AFLYST: Psychology", "Euler's method", "Klassefoto", "Studietur"]);
  assert.ok(titles(await feed(`&v=2&on=${group("Chess Club")}`)).includes("Chess Club"));
  assert.ok(!titles(await feed(`&v=2&off=${group("Psychology")}`)).includes("AFLYST: Psychology"));
  assert.equal(titles(await feed("")).length, 6);                             // plain link: everything
  assert.equal((await call(env, "/api/v1/class/21/31/schedule.ics?key=wrong")).status, 401);
});

test("iCal output is valid RFC 5545", async () => {
  const env = makeEnv();
  await call(env, "/api/v1/class/21/31/snapshot", {method: "POST", key: UP, body: await snapshot(env)});
  const r = await call(env, `/api/v1/class/21/31/schedule.ics?key=${FEED}&v=2`);
  assert.equal(r.headers.get("Content-Type"), "text/calendar; charset=utf-8");
  assert.match(r.headers.get("Cache-Control"), /max-age=1800/);
  const ics = await r.text();
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n") && ics.endsWith("END:VCALENDAR\r\n"));
  assert.ok(!/[^\r]\n/.test(ics), "only CRLF line endings");
  for (const line of ics.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75, `line too long: ${line}`);
  assert.match(ics, /X-WR-CALNAME:3i timetable/);
  assert.match(ics, /BEGIN:VTIMEZONE\r\nTZID:Europe\/Copenhagen/);
  assert.match(ics, /DTSTART;TZID=Europe\/Copenhagen:\d{8}T080000/);
  assert.match(ics, /DTSTART;VALUE=DATE:\d{8}/);
  const unfolded = ics.replace(/\r\n /g, "");
  const BS = String.fromCharCode(92);   // a single backslash
  assert.ok(unfolded.includes(`Note: bring calculator${BS}, ruler${BS}; pens`), "comma and semicolon escaped");
  assert.match(unfolded, /SUMMARY:AFLYST: Psychology\r\n(?:.*\r\n)*?TRANSP:TRANSPARENT/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, (ics.match(/END:VEVENT/g) || []).length);
  const etag = r.headers.get("ETag");
  assert.equal((await call(env, `/api/v1/class/21/31/schedule.ics?key=${FEED}&v=2`, {headers: {"If-None-Match": etag}})).status, 304);
});

test("folding never splits a character", () => {
  const line = "DESCRIPTION:" + "æøå".repeat(40);
  const folded = _internal.fold(line);
  assert.equal(folded.replace(/\r\n /g, ""), line);
  for (const part of folded.split("\r\n")) assert.ok(new TextEncoder().encode(part).length <= 75);
});

test("bad uploads are rejected and keep the last good calendar", async () => {
  const env = makeEnv();
  const post = body => call(env, "/api/v1/class/21/31/snapshot", {method: "POST", key: UP, body});
  const good = await snapshot(env);
  const bad = async mutate => { const b = structuredClone(good); mutate(b); return (await post(b)).status; };
  assert.equal(await bad(b => b.weeks.pop()), 422);                                       // missing week
  assert.equal(await bad(b => { b.weeks[0].url = b.weeks[0].url.replace("klasseid=31", "klasseid=32"); }), 422);
  assert.equal(await bad(b => { b.weeks[0].lessons[0].evil = 1; }), 422);                 // unknown field
  assert.equal(await bad(b => { b.weeks[0].lessons[0].start_time = "25:00"; }), 422);
  assert.equal(await bad(b => { b.weeks[0].lessons[0].start_date = "2001-01-01"; b.weeks[0].lessons[0].end_date = "2001-01-01"; }), 422);
  assert.equal(await bad(b => { b.captured_at = "2020-01-01T00:00:00Z"; }), 422);
  assert.equal(await bad(b => b.weeks.forEach(w => { w.lessons = []; })), 422);           // everything empty = broken
  assert.equal((await call(env, "/api/v1/class/21/31/events.json", {key: FEED})).status, 503);
  assert.equal((await post(good)).status, 200);
  assert.equal((await post(good)).status, 409);                                           // not newer
  const holiday = structuredClone(good); holiday.captured_at = new Date(Date.now() + 1000).toISOString();
  holiday.weeks.forEach(w => { w.lessons = []; w.empty_marker = true; });
  assert.equal((await post(holiday)).status, 200);                                        // Lectio said "no activities"
  assert.equal((await call(env, "/api/v1/class/21/32/snapshot", {method: "POST", key: UP, body: good})).status, 404);
});

test("calendar page: static shell with strict headers", async () => {
  const env = makeEnv();
  const r = await call(env, "/class/21/31");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("Content-Type"), /text\/html/);
  assert.equal(r.headers.get("Content-Security-Policy").includes("connect-src 'self'"), true);
  assert.equal(r.headers.get("Content-Security-Policy").includes("https:"), false);   // no third-party scripts
  assert.equal(r.headers.get("X-Frame-Options"), "DENY");
  assert.match(await r.text(), /Add to Google Calendar/);
  assert.equal((await call(env, "/class/21/99")).status, 404);
});

test("security headers everywhere; unknown paths 404; key guessing gets locked out", async () => {
  const env = makeEnv();
  const home = await call(env, "/");
  for (const h of ["X-Content-Type-Options", "Referrer-Policy", "Content-Security-Policy", "Strict-Transport-Security"]) assert.ok(home.headers.get(h), h);
  assert.equal((await call(env, "/docs")).status, 404);
  for (let i = 0; i < 20; i++) assert.equal((await call(env, `/api/v1/class/21/31/schedule.ics?key=x${i}`, {ip: "9.9.9.9"})).status, 401);
  assert.equal((await call(env, `/api/v1/class/21/31/schedule.ics?key=${FEED}`, {ip: "9.9.9.9"})).status, 429);
  assert.equal((await call(env, "/healthz", {ip: "9.9.9.9"})).status, 200);
});

test("week plan uses Copenhagen dates and ISO weeks across New Year", () => {
  const s = {schoolId: 21, classId: 31, pastWeeks: 1, futureWeeks: 1};
  const weeks = _internal.weekPlan(s, new Date("2026-12-31T23:30:00Z"));   // already 1 Jan 2027 in Copenhagen
  assert.deepEqual(weeks.map(w => [w.monday, w.url.slice(-6)]), [["2026-12-21", "522026"], ["2026-12-28", "532026"], ["2027-01-04", "012027"]]);
});
