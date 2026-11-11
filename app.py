"""Authenticated Lectio class timetable -> subscribable RFC 5545 calendar.

Run: uvicorn app:app --host 127.0.0.1 --port 8000 --no-access-log

Python 3.11+. Browser authentication stays in the user's signed-in Lectio tab.
Selectors/formats must be validated against the school's real HTML before use.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit
from zoneinfo import ZoneInfo

from bs4 import BeautifulSoup
from icalendar import Calendar, Event

COPENHAGEN = ZoneInfo("Europe/Copenhagen")
UTC = timezone.utc
TABLE_SELECTOR = "table.s2skema, table[id$='skema'], table[id$='Skema']"
BRICK_SELECTOR = ".s2skemabrik"
DATE_PATTERN = r"(?P<day>\d{1,2})[/.](?P<month>\d{1,2})[-/.](?P<year>\d{4})"
DATE_RE = re.compile(DATE_PATTERN)
TIME_RE = re.compile(r"(?<!\d)(\d{1,2})[:.](\d{2})\s*(?:til|[-–—])\s*(\d{1,2})[:.](\d{2})(?!\d)", re.I)


class SourceError(Exception):
    """An upstream fetch or parse failed. Never publish an empty replacement."""


@dataclass(frozen=True)
class Lesson:
    subject: str
    teachers: str
    room: str
    start: datetime
    end: datetime
    notes: str
    activity_id: str | None
    cancelled: bool = False
    all_day: bool = False


def plain_text(value: str) -> str:
    """Decode HTML tooltip markup, preserving useful line boundaries."""
    soup = BeautifulSoup(value, "html.parser")
    for br in soup.find_all("br"):
        br.replace_with("\n")
    return "\n".join(line.strip() for line in soup.get_text("\n").splitlines() if line.strip())


def local_datetime(day: date, hour: str, minute: str) -> datetime:
    """Reject invalid/nonexistent/ambiguous wall times instead of guessing DST."""
    wall = datetime.combine(day, datetime.min.time()).replace(hour=int(hour), minute=int(minute))
    aware = wall.replace(tzinfo=COPENHAGEN)
    if aware.astimezone(UTC).astimezone(COPENHAGEN).replace(tzinfo=None) != wall:
        raise ValueError("Nonexistent Copenhagen time")
    if aware.utcoffset() != wall.replace(tzinfo=COPENHAGEN, fold=1).utcoffset():
        raise ValueError("Ambiguous Copenhagen time")
    return aware


def field(text: str, labels: str) -> str:
    match = re.search(rf"^(?:{labels})\s*:\s*(.+)$", text, re.I | re.M)
    return match.group(1).strip() if match else ""


# Lectio prefixes changed/cancelled lessons with a status line such as
# "Ændret!" or "Aflyst!". That line is not the subject.
STATUS_LINE_RE = re.compile(r"^(?:ændret|aflyst|cancelled|changed|ny|new)!?$", re.I)
WEEKDAY_RE = re.compile(r"^(mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)\b", re.I)
EMPTY_MARKER_RE = re.compile(r"ingen (?:aktiviteter|lektioner|skemabrikker)", re.I)
EXPLICIT_RE = re.compile(DATE_PATTERN + r"\s+(\d{1,2})[:.](\d{2})\s*(?:til|[-–—])\s*" +
                         r"(\d{1,2})[/.](\d{1,2})[-/.](\d{4})\s+(\d{1,2})[:.](\d{2})", re.I)


def _date(match: re.Match) -> date:
    return date(int(match['year']), int(match['month']), int(match['day']))


OUTSIDE_WEEK = "outside-week"


def parse_brick(brick, monday: date) -> Lesson | str | None:
    """Parse one schedule brick.

    Returns a Lesson; None for bricks without a date (info/decoration);
    OUTSIDE_WEEK for activities entirely outside the requested week.
    Raises SourceError for dated bricks whose date/time is invalid."""
    # A tooltip may be on the brick or a nested anchor/content span.
    tooltip_nodes = ([brick] if brick.has_attr("data-tooltip") else []) + brick.select("[data-tooltip]")
    raw = "\n".join(dict.fromkeys(node["data-tooltip"] for node in tooltip_nodes))
    text = plain_text(raw) if raw else plain_text(str(brick))
    dates = list(DATE_RE.finditer(text))
    if not dates:
        return None  # Not a dated activity (decorative/info brick).
    first = dates[0]
    try:
        day = _date(first)
        explicit = EXPLICIT_RE.search(text)
        times = TIME_RE.search(text)
        all_day = False
        if explicit:
            # Groups 1..3 are named day/month/year; 4..5 start time, 6..10 end.
            start = local_datetime(day, explicit[4], explicit[5])
            end_day = date(int(explicit[8]), int(explicit[7]), int(explicit[6]))
            end = local_datetime(end_day, explicit[9], explicit[10])
        elif times:
            start = local_datetime(day, times[1], times[2])
            end = local_datetime(day, times[3], times[4])
        else:
            # Date-only brick, e.g. "9/11-2026 til 13/11-2026" (excursion,
            # study trip): an all-day event. DTEND for dates is exclusive.
            all_day = True
            last = _date(dates[1]) if len(dates) > 1 else day
            start = datetime.combine(day, datetime.min.time(), COPENHAGEN)
            end = datetime.combine(last + timedelta(days=1), datetime.min.time(), COPENHAGEN)
        if end <= start:
            raise ValueError("Non-positive lesson duration")
    except ValueError as exc:
        raise SourceError(f"Invalid activity date/time: {text.splitlines()[0] if text else '?'}") from exc
    # Keep activities that overlap the requested week (multi-day events can
    # start before Monday); drop anything entirely outside it.
    week_start = datetime.combine(monday, datetime.min.time(), COPENHAGEN)
    if end <= week_start or start >= week_start + timedelta(days=7):
        return OUTSIDE_WEEK
    subject = field(text, "Fag|Subject|Titel|Title")
    if not subject:
        # Free-text title lines come before the date; skip status/weekday lines.
        before_date = text[:first.start()]
        candidates = [line.strip() for line in before_date.splitlines() if line.strip()]
        candidates = [c for c in candidates if not STATUS_LINE_RE.match(c) and not WEEKDAY_RE.match(c)]
        subject = candidates[0] if candidates else ""
    # Lectio often provides only a hold/course code; preserve it verbatim.
    subject = subject or field(text, "Hold|Class")
    if not subject:
        visible = brick.get_text(" ", strip=True)
        subject = visible or ("Aktivitet" if all_day else "")
    if not subject:
        raise SourceError("Activity subject/course missing; adapt parser to the school's HTML")
    teachers = field(text, "Lærere|Lærer|Teachers|Teacher")
    room = field(text, "Lokaler|Lokale|Rooms|Room")
    links = ([brick] if brick.name == "a" else []) + brick.select("a[href]")
    ids = [parse_qs(urlsplit(a.get("href", "")).query).get("absid", [None])[0] for a in links]
    activity_id = next((value for value in ids if value), None)
    classes = " ".join(brick.get("class", []))
    cancelled = bool(re.search(r"\baflyst\b|\bcancelled\b", text, re.I) or "s2cancelled" in classes)
    return Lesson(subject, teachers, room, start, end, text, activity_id, cancelled, all_day)


def parse_schedule(html: str, monday: date) -> list[Lesson]:
    """Parse one weekly grid.

    A login page or a missing table is an error (the last good feed is kept).
    An empty grid is a valid empty week (holidays); the bridge separately
    refuses a snapshot in which *every* week is empty, so a changed brick
    selector can never silently wipe the subscribed calendar.
    """
    soup = BeautifulSoup(html, "html.parser")
    if soup.select_one("input[type='password']"):
        raise SourceError("Lectio returned a login page; sign in to Lectio again in your browser")
    table = soup.select_one(TABLE_SELECTOR)
    if table is None:
        if "unilogin" in soup.get_text(" ", strip=True).lower():
            raise SourceError("Lectio returned a login page; sign in to Lectio again in your browser")
        raise SourceError("Schedule table missing: wrong class ID or changed Lectio HTML")
    bricks = table.select(BRICK_SELECTOR)
    lessons: dict[tuple, Lesson] = {}
    undated = outside = 0
    for brick in bricks:
        lesson = parse_brick(brick, monday)
        if lesson is None:
            undated += 1
            continue
        if lesson == OUTSIDE_WEEK:
            outside += 1
            continue
        key = (lesson.activity_id, lesson.start, lesson.end, lesson.subject, lesson.teachers, lesson.room)
        lessons[key] = lesson
    if bricks and not lessons:
        if outside:
            # Every activity belongs to another week: Lectio ignored the week
            # parameter, so this page is not the week we asked for.
            raise SourceError("Lectio returned activities outside the requested week")
        # Bricks exist but none carry a date we understand: the tooltip format
        # changed. Fail instead of publishing an empty week.
        sample = plain_text(bricks[0].get("data-tooltip", "") or str(bricks[0]))[:120]
        raise SourceError(f"Unsupported Lectio brick format (first brick: {sample!r})")
    return sorted(lessons.values(), key=lambda lesson: (lesson.start, lesson.subject))


def has_empty_marker(html: str) -> bool:
    """True when Lectio explicitly says the week has no activities."""
    return bool(EMPTY_MARKER_RE.search(BeautifulSoup(html, "html.parser").get_text(" ", strip=True)))


def build_calendar(lessons: list[Lesson], school_id: int, class_id: int) -> bytes:
    calendar = Calendar()
    calendar.add("prodid", "-//Class Timetable Calendar//Lectio authenticated class feed//EN")
    calendar.add("version", "2.0")
    calendar.add("calscale", "GREGORIAN")
    calendar.add("x-wr-calname", f"Lectio class {class_id} — school {school_id}")
    calendar.add("x-wr-timezone", "Europe/Copenhagen")
    now = datetime.now(UTC)
    for lesson in lessons:
        event = Event()
        # absid survives room/time changes. Fallback identity cannot track moves.
        identity = lesson.activity_id or f"{lesson.start.isoformat()}|{lesson.subject}|{lesson.teachers}"
        uid = hashlib.sha256(f"{school_id}:{class_id}:{identity}".encode()).hexdigest()
        event.add("uid", f"{uid}@lectio-class-calendar")
        event.add("dtstamp", now)
        event.add("last-modified", now)
        # Parse Copenhagen wall time, then serialize UTC. This avoids floating
        # times and VTIMEZONE compatibility issues while preserving CET/CEST.
        if lesson.all_day:
            event.add("dtstart", lesson.start.date())
            event.add("dtend", lesson.end.date())
            event.add("transp", "TRANSPARENT")
        else:
            event.add("dtstart", lesson.start.astimezone(UTC))
            event.add("dtend", lesson.end.astimezone(UTC))
        event.add("summary", f"AFLYST: {lesson.subject}" if lesson.cancelled else lesson.subject)
        if lesson.room:
            event.add("location", lesson.room)
        event.add("description", f"Teacher(s): {lesson.teachers or 'Not supplied'}\n{lesson.notes}")
        event.add("status", "CANCELLED" if lesson.cancelled else "CONFIRMED")
        event.add("url", f"https://www.lectio.dk/lectio/{school_id}/SkemaNy.aspx?klasseid={class_id}")
        calendar.add_component(event)
    # icalendar handles UTF-8, CRLF, escaping and RFC line folding.
    return calendar.to_ical()



# Browser-session uploads replace anonymous server-side Lectio requests.
from bridge_api import create_app  # noqa: E402  (bridge imports nothing from here)
app = create_app(parse_schedule, build_calendar, SourceError, empty_marker=has_empty_marker)
