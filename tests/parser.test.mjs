// Parser tests, run against a DOM (linkedom).
import {test} from "node:test";
import assert from "node:assert/strict";
import {DOMParser} from "linkedom";
// parser.js registers itself as globalThis.LectioParser, as in the browser.
await import("../extension/parser.js");
const {parseWeek, ParseError} = globalThis.LectioParser;

const MONDAY = "2026-11-09";
const doc = html => new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html");
const grid = (tooltip, extra = "") => `<table class="s2skema"><tr><td><a class="s2skemabrik ${extra}"
  href="aktivitet.aspx?absid=12345" data-tooltip="${tooltip}">MA</a></td></tr></table>`;
const tip = (day = "9/11-2026", times = "08:00 til 09:30", subject = "Matematik") =>
  `${subject}&#10;${day} ${times}&#10;Lærer: AB&#10;Lokale: A12&#10;Note: Læs side 5; øvelse, 2`;
const parse = (html, monday = MONDAY) => parseWeek(doc(html), monday).lessons;

test("fields", () => {
  const [l] = parse(grid(tip()));
  assert.deepEqual([l.subject, l.teachers, l.room, l.activity_id], ["Matematik", "AB", "A12", "12345"]);
  assert.deepEqual([l.start_date, l.start_time, l.end_date, l.end_time, l.all_day], ["2026-11-09", "08:00", "2026-11-09", "09:30", false]);
  assert.match(l.notes, /Læs side 5; øvelse, 2/);
});

test("cancelled lessons and explicit empty week", () => {
  assert.equal(parse(grid(tip() + "&#10;Aflyst"))[0].cancelled, true);
  const week = parseWeek(doc('<table class="s2skema"><tr><td>Ingen aktiviteter</td></tr></table>'), MONDAY);
  assert.deepEqual(week, {lessons: [], emptyMarker: true});
});

for (const [name, html] of Object.entries({
  "login page": '<form><input type="password"></form>', "unilogin text": "<p>Unilogin</p>", "unknown layout": "<p>Unknown layout</p>",
  "undated brick only": grid("Matematik ved AB"), "other week": grid(tip("2/11-2026")), "negative duration": grid(tip(undefined, "10:00-09:00")),
  "impossible date": grid(tip("31/11-2026")),
})) {
  test(`fails closed: ${name}`, () => assert.throws(() => parse(html), ParseError));
}

test("activity crossing midnight", () => {
  const [l] = parse(grid(tip(undefined, "23:00 til 10/11-2026 01:00")));
  assert.deepEqual([l.end_date, l.end_time], ["2026-11-10", "01:00"]);
});

test("grid without bricks is an empty (holiday) week", () => {
  assert.deepEqual(parseWeek(doc('<table class="s2skema"><tr><td>MA</td></tr></table>'), MONDAY), {lessons: [], emptyMarker: false});
});

test("status line is not the subject", () => {
  let [l] = parse(grid("Ændret!&#10;9/11-2026 08:15 til 09:45&#10;Hold: 3i MA&#10;Lærer: Michael (MH)&#10;Lokale: 12"));
  assert.deepEqual([l.subject, l.teachers, l.room], ["3i MA", "Michael (MH)", "12"]);
  [l] = parse(grid("Aflyst!&#10;9/11-2026 08:15 til 09:45&#10;Hold: 3i FY"));
  assert.equal(l.subject, "3i FY"); assert.equal(l.cancelled, true);
});

test("plural teacher and room labels", () => {
  const [l] = parse(grid("9/11-2026 10:00 til 11:30&#10;Hold: 3i BI&#10;Lærere: AB, CD&#10;Lokaler: B1, B2"));
  assert.deepEqual([l.teachers, l.room], ["AB, CD", "B1, B2"]);
});

test("date-only brick becomes an all-day event (exclusive end)", () => {
  const [l] = parse(grid("Studietur&#10;10/11-2026 til 12/11-2026"));
  assert.deepEqual([l.all_day, l.start_date, l.end_date, l.start_time], [true, "2026-11-10", "2026-11-13", null]);
});

test("multi-day event from previous week kept; undated bricks ignored", () => {
  const html = '<table class="s2skema"><tr><td><a class="s2skemabrik" data-tooltip="Projektuge&#10;6/11-2026 til 10/11-2026">P</a>' +
    '<span class="s2skemabrik">info</span>' +
    '<a class="s2skemabrik" href="x?absid=9" data-tooltip="9/11-2026 08:00 til 09:00&#10;Hold: MA">MA</a></td></tr></table>';
  assert.deepEqual(parse(html).map(l => l.subject), ["Projektuge", "MA"]);
});

test("tooltip markup is decoded, never executed", () => {
  const [l] = parse(grid("Fysik&lt;br&gt;9/11-2026 08:00 til 09:00&lt;br&gt;Lokale: &lt;b&gt;F1&lt;/b&gt;&lt;img src=x onerror=alert(1)&gt;"));
  assert.equal(l.subject, "Fysik"); assert.equal(l.room, "F1");
  assert.ok(!l.notes.includes("<"));
});
