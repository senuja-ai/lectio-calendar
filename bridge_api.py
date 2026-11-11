"""Authenticated browser uploads -> durable, token-protected calendar feed."""
from __future__ import annotations

import hashlib
import json
from contextlib import contextmanager, closing
import os
import secrets
import sqlite3
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.concurrency import run_in_threadpool

UTC = timezone.utc
COPENHAGEN = ZoneInfo('Europe/Copenhagen')
ROOT = Path(__file__).resolve().parent
CONFIG = Path(os.getenv('LECTIO_CONFIG', str(ROOT / 'runtime' / 'config.json')))
MAX_UPLOAD = 5_000_000
VIEW_HTML = ROOT / 'web' / 'calendar.html'
NO_STORE = {'Cache-Control': 'no-store'}
ENV_FIELDS = {  # Settings field -> (environment variable, type)
    'school_id': ('LECTIO_SCHOOL_ID', int), 'class_id': ('LECTIO_CLASS_ID', int),
    'upload_token': ('LECTIO_UPLOAD_TOKEN', str), 'feed_token': ('LECTIO_FEED_TOKEN', str),
    'database': ('LECTIO_DATABASE', str), 'past_weeks': ('LECTIO_PAST_WEEKS', int),
    'future_weeks': ('LECTIO_FUTURE_WEEKS', int), 'google_client_id': ('LECTIO_GOOGLE_CLIENT_ID', str),
}

# Headers for every response. Pages that need more (the calendar page) set
# their own Content-Security-Policy.
SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    # Lets the Google account popup report back, while isolating the page otherwise.
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    'Cross-Origin-Resource-Policy': 'same-origin',
}
DEFAULT_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"


class FailedAuthLimiter:
    """Slow down key guessing: after too many wrong keys from one client,
    answer 429 for a while. (Keys are 256-bit random, so this is defence in
    depth, and it also keeps noisy scanners out of the logs.)"""

    def __init__(self, limit: int = 20, window: int = 600):
        self.limit, self.window, self.failures = limit, window, {}

    def _recent(self, client: str, now: float) -> list:
        times = [t for t in self.failures.get(client, []) if now - t < self.window]
        if times:
            self.failures[client] = times
        else:
            self.failures.pop(client, None)
        return times

    def blocked(self, client: str) -> bool:
        import time
        return len(self._recent(client, time.monotonic())) >= self.limit

    def record(self, client: str) -> None:
        import time
        now = time.monotonic()
        self.failures.setdefault(client, []).append(now)
        if len(self.failures) > 10_000:  # Bound memory under a flood.
            for key in list(self.failures)[:5_000]:
                self.failures.pop(key, None)


@dataclass(frozen=True)
class Settings:
    school_id: int
    class_id: int
    upload_token: str
    feed_token: str
    database: str
    past_weeks: int = 1
    future_weeks: int = 2
    # Optional: OAuth "Web application" client ID from Google Cloud, enables
    # the page's "Add to Google Calendar" button. Public value, not a secret.
    google_client_id: str = ''

    def __post_init__(self):
        if self.school_id <= 0 or self.class_id <= 0:
            raise ValueError('School and class IDs must be positive')
        if not 0 <= self.past_weeks <= 4 or not 0 <= self.future_weeks <= 8:
            raise ValueError('Week window out of range')
        if self.google_client_id and not self.google_client_id.endswith('.apps.googleusercontent.com'):
            raise ValueError('google_client_id must end with .apps.googleusercontent.com')
        if min(len(self.upload_token), len(self.feed_token)) < 32 or self.upload_token == self.feed_token:
            raise ValueError('Use distinct upload and feed tokens of at least 32 characters')

    @classmethod
    def load(cls):
        """Read runtime/config.json, then let LECTIO_* environment variables
        override it. Hosting services usually provide only environment
        variables, so a hosted server needs no config file at all."""
        try:
            data = json.loads(CONFIG.read_text(encoding='utf-8')) if CONFIG.exists() else {}
            for field, (env, cast) in ENV_FIELDS.items():
                if os.getenv(env):
                    data[field] = cast(os.environ[env])
            data.setdefault('database', str(ROOT / 'runtime' / 'calendar.sqlite3'))
            return cls(**data)
        except (OSError, ValueError, TypeError) as exc:
            raise HTTPException(503, 'Server not configured: run python setup_project.py, or set the LECTIO_* '
                                     'environment variables (see README), then restart.', headers=NO_STORE) from exc


def week_plan(settings: Settings):
    today = datetime.now(COPENHAGEN).date()
    monday = today - timedelta(days=today.weekday())
    result = []
    for offset in range(-settings.past_weeks, settings.future_weeks + 1):
        day = monday + timedelta(weeks=offset)
        year, week, _ = day.isocalendar()
        query = urlencode({'klasseid': settings.class_id, 'week': f'{week:02}{year}'})
        result.append({'monday': day.isoformat(), 'url': f'https://www.lectio.dk/lectio/{settings.school_id}/SkemaNy.aspx?{query}'})
    return result


class WeekPage(BaseModel):
    model_config = ConfigDict(extra='forbid')
    monday: date
    url: str = Field(max_length=1000)
    html: str = Field(min_length=1, max_length=2_000_000)


class SnapshotUpload(BaseModel):
    model_config = ConfigDict(extra='forbid')
    captured_at: datetime
    weeks: list[WeekPage] = Field(min_length=1, max_length=13)


class SnapshotStore:
    def __init__(self, path: str):
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as con:
            con.execute('CREATE TABLE IF NOT EXISTS feed (school INTEGER, class INTEGER, captured REAL, received TEXT, calendar BLOB, count INTEGER, PRIMARY KEY(school,class))')

    @contextmanager
    def connect(self):
        with closing(sqlite3.connect(self.path, timeout=10)) as con:
            with con:
                yield con

    def save(self, s: Settings, captured: datetime, calendar: bytes, count: int):
        received = datetime.now(UTC).isoformat()
        with self.connect() as con:
            # Serialize read/check/write, including across Uvicorn workers.
            con.execute('BEGIN IMMEDIATE')
            existing = con.execute('SELECT captured FROM feed WHERE school=? AND class=?', (s.school_id,s.class_id)).fetchone()
            if existing and captured.timestamp() <= existing[0]:
                raise HTTPException(409, 'A newer or equal snapshot is already stored', headers=NO_STORE)
            con.execute('INSERT OR REPLACE INTO feed VALUES (?,?,?,?,?,?)',
                        (s.school_id,s.class_id,captured.timestamp(),received,calendar,count))
        return received

    def read(self, s: Settings):
        with self.connect() as con:
            return con.execute('SELECT received,calendar,count FROM feed WHERE school=? AND class=?', (s.school_id,s.class_id)).fetchone()


# Which non-subject items are shown by default. Subjects are always on;
# whole-class / whole-school events (class photo, exams, field trips, theme
# days, all-day items) are on; clubs, committees and other optional activities
# start off. No word boundaries around most terms: Danish compounds
# ("Klassefoto", "Trænerakademiet") must match. The calendar page and every
# subscription link use this same rule, so new clubs never appear uninvited.
import re as _re
OPTIONAL_RE = _re.compile(r'(club|klub|udvalg|committee|frivillig|voluntary|study ?hall|akademi|academy|orkester|'
                          r'pop-?up|café|instamøde|kursus|skriver|\bteam\b|\bkor\b|\bchoir\b|\bband\b|\bmun\b)', _re.I)
SCHOOL_RE = _re.compile(r'(klasse|class|alle elever|all students|fælles|school|skole|eksamen|exam|prøve|\btest\b|'
                        r'field ?trip|ekskursion|studietur|excursion|foto|photo|ferie|holiday|fridag|(dag|day)\b|aula|'
                        r'intro|orientering|information|forældre|parents|graduation|dimission|oprydning|tidying|cleaning)', _re.I)


def default_shown(fields: dict, group_all_day: bool) -> bool:
    if fields['kind'] == 'course':
        return True  # Real subjects, and class-wide "Hold" (e.g. just "3i").
    if OPTIONAL_RE.search(fields['title']):
        return False
    return group_all_day or bool(SCHOOL_RE.search(fields['title']))


def _with_defaults(items: list[tuple[dict, bool]]) -> list[dict]:
    """items = [(fields, all_day)] -> fields + 'default_on' (decided per group)."""
    all_day = {}
    for fields, is_all_day in items:
        all_day[fields['group']] = all_day.get(fields['group'], True) and is_all_day
    for fields, _ in items:
        fields['default_on'] = default_shown(fields, all_day[fields['group']])
    return [fields for fields, _ in items]


def event_fields(ev) -> dict:
    """Readable fields of one stored VEVENT, plus its filter group.

    Group = the Lectio course ("Hold") for lessons, or the title for clubs and
    events. The same group ids drive the page's toggles and the ?hide= filter.
    """
    import re
    description = str(ev.get('description', ''))
    teacher = re.search(r'^Teacher\(s\): (.*)$', description, re.M)
    hold = re.search(r'^Hold:\s*(.+)$', description, re.M | re.I)
    title = str(ev.get('summary', ''))
    cancelled = str(ev.get('status', '')) == 'CANCELLED'
    if cancelled and title.startswith('AFLYST: '):
        title = title[len('AFLYST: '):]
    course = hold[1].strip() if hold else ''
    if not course and re.match(r'^\S+\s+[A-Za-zæøå]+?(?:A|B)?(?:HL|SL)\b', title):
        course = title  # Untitled lesson: the summary is the course code.
    key = ('course:' + course.lower()) if course else ('event:' + title.strip().lower())
    notes = '\n'.join(line for line in description.splitlines()[1:]
                      if not re.match(r'^(Hold|Lærere?|Lokaler?)\s*:', line, re.I))
    return {'title': title, 'course': course, 'cancelled': cancelled, 'notes': notes.strip(),
            'teacher': '' if not teacher or teacher[1] == 'Not supplied' else teacher[1],
            'location': str(ev.get('location', '')),
            'group': hashlib.sha256(key.encode('utf-8')).hexdigest()[:10],
            'kind': 'course' if course else 'event'}


def calendar_to_events(calendar: bytes) -> list[dict]:
    """Decode stored ICS bytes into plain dicts with local (Copenhagen) times."""
    from icalendar import Calendar
    items = []
    for ev in Calendar.from_ical(calendar).walk('VEVENT'):
        start, end = ev.decoded('dtstart'), ev.decoded('dtend')
        all_day = not isinstance(start, datetime)
        if not all_day:
            start, end = start.astimezone(COPENHAGEN).isoformat()[:16], end.astimezone(COPENHAGEN).isoformat()[:16]
        else:
            start, end = start.isoformat(), end.isoformat()
        uid = str(ev.get('uid', ''))
        items.append(({'id': uid.split('@')[0], 'start': start, 'end': end, 'all_day': all_day, **event_fields(ev)}, all_day))
    result = _with_defaults(items)
    result.sort(key=lambda e: (e['start'], e['title']))
    return result


def filter_calendar(calendar: bytes, hidden: set[str] = frozenset(), on: set[str] | None = None,
                    off: set[str] = frozenset()) -> bytes:
    """Per-student subscription feeds.

    on is None  -> legacy ?hide= links: everything except `hidden`.
    on is a set -> ?v=2 links: the page's rule. Groups in `off` are removed,
                   groups in `on` kept, everything else follows default_shown().
    """
    if on is None and not hidden:
        return calendar
    from icalendar import Calendar
    cal = Calendar.from_ical(calendar)
    events = [c for c in cal.subcomponents if c.name == 'VEVENT']
    fields = _with_defaults([(event_fields(c), not isinstance(c.decoded('dtstart'), datetime)) for c in events])
    keep = set()
    for component, f in zip(events, fields):
        g = f['group']
        if on is None:
            shown = g not in hidden
        else:
            shown = g not in off and (g in on or f['default_on'])
        if shown:
            keep.add(id(component))
    cal.subcomponents[:] = [c for c in cal.subcomponents if c.name != 'VEVENT' or id(c) in keep]
    return cal.to_ical()


def create_app(parse_schedule, build_calendar, source_error, settings: Settings | None = None, empty_marker=None):
    # No interactive API docs on a public server.
    app = FastAPI(title='Lectio class calendar', version='2.3.0', docs_url=None, redoc_url=None, openapi_url=None)
    limiter = FailedAuthLimiter()
    trust_proxy = os.getenv('LECTIO_TRUST_PROXY', '') == '1'

    def client_id(request: Request) -> str:
        # Behind a hosting proxy every request comes from the proxy; then the
        # real client is the first X-Forwarded-For address.
        if trust_proxy and request.headers.get('x-forwarded-for'):
            return request.headers['x-forwarded-for'].split(',')[0].strip()
        return request.client.host if request.client else '?'

    @app.middleware('http')
    async def security(request: Request, call_next):
        if limiter.blocked(client_id(request)) and request.url.path != '/healthz':
            response = Response('{"detail":"Too many invalid keys. Try again later."}', status_code=429,
                                media_type='application/json', headers={**NO_STORE, 'Retry-After': '600'})
        else:
            response = await call_next(request)
            if response.status_code == 401:
                limiter.record(client_id(request))
        for name, value in SECURITY_HEADERS.items():
            response.headers.setdefault(name, value)
        response.headers.setdefault('Content-Security-Policy', DEFAULT_CSP)
        https = request.url.scheme == 'https' or (trust_proxy and request.headers.get('x-forwarded-proto') == 'https')
        if https:
            response.headers.setdefault('Strict-Transport-Security', 'max-age=31536000')
        return response

    def configured():
        return settings or Settings.load()

    def authorize(request: Request, expected: str, message: str = 'Invalid synchronization key'):
        supplied = request.headers.get('Authorization', '')
        if not secrets.compare_digest(supplied.encode(), ('Bearer ' + expected).encode()):
            raise HTTPException(401, message, headers={**NO_STORE, 'WWW-Authenticate':'Bearer'})

    @app.get('/')
    def home():
        return {'service': 'Lectio class calendar'}

    @app.get('/healthz')
    def health():
        return {'ok': True}

    @app.get('/api/v1/bridge/config')
    def bridge_config(request: Request, response: Response):
        s = configured()
        authorize(request, s.upload_token)
        response.headers.update(NO_STORE)
        record = SnapshotStore(s.database).read(s)
        return {'school_id': s.school_id, 'class_id': s.class_id, 'weeks': week_plan(s),
                'subscription_path': f'/api/v1/class/{s.school_id}/{s.class_id}/schedule.ics?key={s.feed_token}',
                # Key after "#": browsers never send it to the server, so it stays out of logs.
                'view_path': f'/class/{s.school_id}/{s.class_id}#key={s.feed_token}',
                'last_synced': record[0] if record else None}

    @app.post('/api/v1/class/{school_id}/{class_id}/snapshot')
    async def upload(school_id: int, class_id: int, request: Request):
        s = configured()
        authorize(request, s.upload_token)
        if (school_id,class_id) != (s.school_id,s.class_id):
            raise HTTPException(404, 'Class is not configured', headers=NO_STORE)
        if request.headers.get('content-type','').split(';')[0].strip().lower() != 'application/json':
            raise HTTPException(415, 'Use application/json', headers=NO_STORE)
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_UPLOAD:
                raise HTTPException(413, 'Snapshot is too large', headers=NO_STORE)
        try:
            payload = SnapshotUpload.model_validate_json(bytes(body))
        except ValidationError as exc:
            # Do not echo authenticated timetable HTML in validation responses.
            raise HTTPException(422, 'Invalid snapshot format', headers=NO_STORE) from exc
        return await run_in_threadpool(process_upload, s, payload, school_id, class_id)

    def process_upload(s, payload, school_id, class_id):
        captured = payload.captured_at
        if captured.tzinfo is None or abs((datetime.now(UTC)-captured).total_seconds()) > 600:
            raise HTTPException(422, 'Snapshot timestamp must include a timezone and be within ten minutes', headers=NO_STORE)
        plan = {item['monday']: item['url'] for item in week_plan(s)}
        if len(payload.weeks) != len(plan) or {w.monday.isoformat() for w in payload.weeks} != set(plan):
            raise HTTPException(422, 'Upload must contain every configured week exactly once', headers=NO_STORE)
        lessons = {}
        explicit_empty = False
        try:
            for page in payload.weeks:
                expected = urlsplit(plan[page.monday.isoformat()])
                actual = urlsplit(page.url)
                if (actual.scheme,actual.netloc,actual.path,parse_qs(actual.query),actual.fragment) != (expected.scheme,expected.netloc,expected.path,parse_qs(expected.query),''):
                    raise source_error('Snapshot URL does not match the configured class and week')
                week_lessons = parse_schedule(page.html, page.monday)
                if not week_lessons and empty_marker and empty_marker(page.html):
                    explicit_empty = True
                for lesson in week_lessons:
                    # Multi-day activities appear in several weeks; keep one copy.
                    identity = lesson.activity_id or (lesson.start,lesson.subject,lesson.teachers)
                    lessons.setdefault(identity, lesson)
        except source_error as exc:
            raise HTTPException(422, str(exc), headers=NO_STORE) from exc
        if not lessons and not explicit_empty:
            # Single empty weeks (holidays) are fine, but a whole window with
            # zero lessons almost always means the HTML changed. Keep the old feed.
            raise HTTPException(422, 'No lessons found in any synchronized week; the last calendar was kept. '
                                     'Check the class ID, or the Lectio page layout may have changed.', headers=NO_STORE)
        calendar = build_calendar(sorted(lessons.values(),key=lambda lesson:lesson.start),school_id,class_id)
        received = SnapshotStore(s.database).save(s,captured,calendar,len(lessons))
        return Response(content=json.dumps({'ok':True,'lessons':len(lessons),'last_synced':received}),media_type='application/json',headers=NO_STORE)

    def feed_record(school_id: int, class_id: int, key: str):
        """Shared checks for every read endpoint (ICS, JSON, page)."""
        s = configured()
        if not secrets.compare_digest(key.encode(),s.feed_token.encode()):
            raise HTTPException(401, 'A valid calendar subscription key is required', headers=NO_STORE)
        if (school_id,class_id) != (s.school_id,s.class_id):
            raise HTTPException(404, 'Class is not configured', headers=NO_STORE)
        record = SnapshotStore(s.database).read(s)
        if record is None:
            raise HTTPException(503, 'No timetable synchronized yet. Sign in to Lectio and click Save and sync in the extension.', headers={**NO_STORE,'Retry-After':'60'})
        return record

    def feed_headers(received: str, body: bytes, content_type: str) -> dict:
        age = max(0,int((datetime.now(UTC)-datetime.fromisoformat(received)).total_seconds()))
        return {'Content-Type':content_type,
                'Cache-Control':'private, max-age=1800','ETag':'"'+hashlib.sha256(body).hexdigest()+'"',
                'X-Lectio-Last-Synced':received,'X-Lectio-Stale':str(age>3600).lower(),
                'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}

    def conditional(request: Request, body: bytes, headers: dict) -> Response:
        tags = {t.strip().removeprefix('W/') for t in request.headers.get('if-none-match','').split(',')}
        if headers['ETag'] in tags or '*' in tags:
            return Response(status_code=304,headers=headers)
        return Response(content=body,headers=headers)

    @app.get('/api/v1/class/{school_id}/{class_id}/schedule.ics')
    def schedule(school_id: int, class_id: int, request: Request, key: str = '', hide: str = '',
                 v: str = '', on: str = '', off: str = ''):
        received, calendar, count = feed_record(school_id, class_id, key)
        # Per-student links: ?v=2&on=GROUPS&off=GROUPS (the page's choices on
        # top of the default rule). Older ?hide=GROUPS links still work.
        ids = lambda text: {g for g in text.split(',') if len(g) == 10 and all(c in '0123456789abcdef' for c in g)}
        calendar = filter_calendar(calendar, ids(hide), ids(on) if v == '2' else None, ids(off))
        headers = feed_headers(received, calendar, 'text/calendar; charset=utf-8')
        headers['Content-Disposition'] = 'inline; filename="class_schedule.ics"'
        # A failed/expired browser session never erases the last successful feed.
        return conditional(request, calendar, headers)

    @app.get('/api/v1/class/{school_id}/{class_id}/events.json')
    def events(school_id: int, class_id: int, request: Request, key: str = ''):
        """The stored calendar as JSON for the web view (Copenhagen wall times).
        The page sends the key as a Bearer header so it never appears in URLs."""
        header = request.headers.get('Authorization', '')
        if header.startswith('Bearer '):
            key = header[len('Bearer '):]
        received, calendar, count = feed_record(school_id, class_id, key)
        s = configured()
        body = json.dumps({'last_synced': received, 'class_id': s.class_id,
                           'google_client_id': s.google_client_id, 'events': calendar_to_events(calendar)},
                          ensure_ascii=False).encode('utf-8')
        return conditional(request, body, feed_headers(received, body, 'application/json; charset=utf-8'))

    @app.get('/class/{school_id}/{class_id}', response_class=HTMLResponse)
    def view(school_id: int, class_id: int):
        """Graphical week view. The page itself holds no timetable data: it
        reads the key from the URL fragment (#key=...) and then loads
        events.json with it, so the key never reaches the server's logs."""
        s = configured()
        if (school_id,class_id) != (s.school_id,s.class_id):
            raise HTTPException(404, 'Class is not configured', headers=NO_STORE)
        return HTMLResponse(VIEW_HTML.read_text(encoding='utf-8'), headers={
            'Cache-Control':'no-cache',
            # Google Identity Services (account picker) and the Calendar API.
            'Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline' https://accounts.google.com/gsi/client; "
                "style-src 'unsafe-inline' https://accounts.google.com/gsi/style; frame-src https://accounts.google.com; "
                "connect-src 'self' https://www.googleapis.com https://accounts.google.com; img-src data: https:; "
                "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"})

    return app
