from datetime import date, datetime, timezone
from concurrent.futures import ThreadPoolExecutor
import time

import pytest
from fastapi.testclient import TestClient
from icalendar import Calendar
import app

MONDAY = date(2026, 11, 9)


def grid(tooltip, extra=''):
    return f'''<table class="s2skema"><tr><td><a class="s2skemabrik {extra}"
    href="aktivitet.aspx?absid=12345" data-tooltip="{tooltip}">MA</a></td></tr></table>'''


def tip(day='9/11-2026', times='08:00 til 09:30', subject='Matematik'):
    return f'{subject}&#10;{day} {times}&#10;Lærer: AB&#10;Lokale: A12&#10;Note: Læs side 5; øvelse, 2'


def test_fields_and_rfc_round_trip():
    lessons = app.parse_schedule(grid(tip()), MONDAY)
    lesson = lessons[0]
    assert (lesson.subject, lesson.teachers, lesson.room, lesson.activity_id) == ('Matematik', 'AB', 'A12', '12345')
    assert 'Læs side' in lesson.notes
    data = app.build_calendar(lessons, 21, 31)
    event = Calendar.from_ical(data).walk('VEVENT')[0]
    assert event.decoded('dtstart') == datetime(2026, 11, 9, 7, tzinfo=timezone.utc)
    assert event.decoded('dtend') == datetime(2026, 11, 9, 8, 30, tzinfo=timezone.utc)
    assert str(event['location']) == 'A12'
    assert 'øvelse, 2' in str(event['description'])
    assert b'\r\n' in data


def test_summer_time():
    lessons = app.parse_schedule(grid(tip('8/6-2026')), date(2026, 6, 8))
    event = Calendar.from_ical(app.build_calendar(lessons, 21, 31)).walk('VEVENT')[0]
    assert event.decoded('dtstart').hour == 6


def test_uid_survives_time_room_subject_changes():
    a = app.parse_schedule(grid(tip()), MONDAY)
    b = app.parse_schedule(grid(tip(times='10:00-11:30', subject='Dansk').replace('A12', 'B21')), MONDAY)
    def uid(lessons):
        return Calendar.from_ical(app.build_calendar(lessons, 21, 31)).walk('VEVENT')[0]['uid']
    assert uid(a) == uid(b)


def test_cancelled_and_empty_week():
    lessons = app.parse_schedule(grid(tip() + '&#10;Aflyst'), MONDAY)
    event = Calendar.from_ical(app.build_calendar(lessons, 21, 31)).walk('VEVENT')[0]
    assert str(event['status']) == 'CANCELLED'
    assert app.parse_schedule('<table class="s2skema"><tr><td>Ingen aktiviteter</td></tr></table>', MONDAY) == []


@pytest.mark.parametrize('html', ['<p>Unilogin</p>', '<html>Unknown layout</html>', grid('Matematik'), grid(tip('2/11-2026')), grid(tip(times='10:00-09:00'))])
def test_fail_closed(html):
    with pytest.raises(app.SourceError):
        app.parse_schedule(html, MONDAY)


def test_explicit_overnight_date():
    lessons = app.parse_schedule(grid(tip(times='23:00 til 10/11-2026 01:00')), MONDAY)
    assert lessons[0].end.day == 10


@pytest.mark.parametrize('day,hour', [(date(2026, 3, 29), '2'), (date(2026, 10, 25), '2')])
def test_dst_edge_is_not_guessed(day, hour):
    with pytest.raises(ValueError):
        app.local_datetime(day, hour, '30')


def test_grid_without_bricks_is_an_empty_week_at_parse_level():
    # The bridge rejects a snapshot where *every* week is empty (see test_bridge).
    assert app.parse_schedule('<table class="s2skema"><tr><td class="new-brick">MA</td></tr></table>', MONDAY) == []


def test_unknown_brick_tooltip_format_fails():
    html = '<table class="s2skema"><tr><td><a class="s2skemabrik" data-tooltip="MA ved AB">MA</a></td></tr></table>'
    with pytest.raises(app.SourceError, match='Unsupported'):
        app.parse_schedule(html, MONDAY)


def test_status_line_is_not_the_subject():
    lessons = app.parse_schedule(grid('Ændret!&#10;9/11-2026 08:15 til 09:45&#10;Hold: 3i MA&#10;Lærer: Michael (MH)&#10;Lokale: 12'), MONDAY)
    assert (lessons[0].subject, lessons[0].teachers, lessons[0].room) == ('3i MA', 'Michael (MH)', '12')
    lessons = app.parse_schedule(grid('Aflyst!&#10;9/11-2026 08:15 til 09:45&#10;Hold: 3i FY'), MONDAY)
    assert lessons[0].subject == '3i FY' and lessons[0].cancelled
    event = Calendar.from_ical(app.build_calendar(lessons, 21, 31)).walk('VEVENT')[0]
    assert str(event['summary']).startswith('AFLYST')


def test_plural_teacher_and_room_labels():
    lessons = app.parse_schedule(grid('9/11-2026 10:00 til 11:30&#10;Hold: 3i BI&#10;Lærere: AB, CD&#10;Lokaler: B1, B2'), MONDAY)
    assert (lessons[0].teachers, lessons[0].room) == ('AB, CD', 'B1, B2')


def test_date_only_brick_becomes_all_day_event():
    lessons = app.parse_schedule(grid('Studietur&#10;10/11-2026 til 12/11-2026'), MONDAY)
    assert lessons[0].all_day
    event = Calendar.from_ical(app.build_calendar(lessons, 21, 31)).walk('VEVENT')[0]
    assert event.decoded('dtstart') == date(2026, 11, 10)
    assert event.decoded('dtend') == date(2026, 11, 13)


def test_multiday_event_from_previous_week_is_kept_and_undated_bricks_ignored():
    html = ('<table class="s2skema"><tr><td><a class="s2skemabrik" data-tooltip="Projektuge&#10;6/11-2026 til 10/11-2026">P</a>'
            '<span class="s2skemabrik">info</span>'
            '<a class="s2skemabrik" href="x?absid=9" data-tooltip="9/11-2026 08:00 til 09:00&#10;Hold: MA">MA</a></td></tr></table>')
    lessons = app.parse_schedule(html, MONDAY)
    assert [lesson.subject for lesson in lessons] == ['Projektuge', 'MA']
