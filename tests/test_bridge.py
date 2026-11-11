from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
import subprocess
import sys

import pytest
from fastapi.testclient import TestClient
from icalendar import Calendar

from app import SourceError, build_calendar, has_empty_marker, parse_schedule
from bridge_api import Settings, create_app


@pytest.fixture
def bridge(tmp_path):
    settings = Settings(21,31,'u'*43,'f'*43,str(tmp_path/'feed.sqlite3'),0,0)
    client = TestClient(create_app(parse_schedule,build_calendar,SourceError,settings,empty_marker=has_empty_marker))
    return client,settings


def auth(s):
    return {'Authorization':'Bearer '+s.upload_token}


def upload_data(client,s,malformed=False):
    plan = client.get('/api/v1/bridge/config',headers=auth(s)).json()['weeks']
    for week in plan:
        day = datetime.fromisoformat(week['monday'])
        tooltip = f'Matematik&#10;{day.day}/{day.month}-{day.year} 08:00 til 09:30&#10;Lærer: AB&#10;Lokale: A12'
        week['html'] = '<p>Unilogin</p>' if malformed else f'<table class="s2skema"><tr><td><a class="s2skemabrik" href="a.aspx?absid=123" data-tooltip="{tooltip}">MA</a></td></tr></table>'
    return {'captured_at':datetime.now(timezone.utc).isoformat(),'weeks':plan}


def feed_url(s):
    return f'/api/v1/class/{s.school_id}/{s.class_id}/schedule.ics?key={s.feed_token}'


def test_auth_keys_are_separate(bridge):
    client,s = bridge
    assert client.get('/api/v1/bridge/config').status_code == 401
    assert client.get('/api/v1/bridge/config',headers={'Authorization':'Bearer '+s.feed_token}).status_code == 401
    assert client.get('/api/v1/class/21/31/schedule.ics').status_code == 401
    assert client.get('/api/v1/class/21/31/schedule.ics?key='+s.upload_token).status_code == 401
    assert client.post('/api/v1/class/21/31/snapshot',json={}).status_code == 401


def test_initial_feed_explains_setup(bridge):
    client,s = bridge
    response = client.get(feed_url(s))
    assert response.status_code == 503
    assert 'Sign in to Lectio' in response.json()['detail']
    assert response.headers['cache-control'] == 'no-store'


def test_authenticated_upload_feed_headers_and_restart(bridge):
    client,s = bridge
    data = upload_data(client,s)
    result = client.post('/api/v1/class/21/31/snapshot',json=data,headers=auth(s))
    assert result.status_code == 200
    assert result.json()['lessons'] == 1
    response = client.get(feed_url(s))
    assert response.status_code == 200
    assert response.headers['content-type'] == 'text/calendar; charset=utf-8'
    assert response.headers['content-disposition'] == 'inline; filename="class_schedule.ics"'
    assert 'max-age=1800' in response.headers['cache-control']
    assert response.headers['x-lectio-stale'] == 'false'
    assert len(Calendar.from_ical(response.content).walk('VEVENT')) == 1
    restarted = TestClient(create_app(parse_schedule,build_calendar,SourceError,s))
    assert restarted.get(feed_url(s)).content == response.content
    assert client.get(feed_url(s),headers={'If-None-Match':response.headers['etag']}).status_code == 304
    # Neither cookie data, credentials nor source HTML is persisted.
    raw = Path(s.database).read_bytes()
    assert b'<table' not in raw and s.upload_token.encode() not in raw


def test_expired_session_preserves_last_good_snapshot(bridge):
    client,s = bridge
    client.post('/api/v1/class/21/31/snapshot',json=upload_data(client,s),headers=auth(s))
    before = client.get(feed_url(s)).content
    response = client.post('/api/v1/class/21/31/snapshot',json=upload_data(client,s,True),headers=auth(s))
    assert response.status_code == 422
    assert 'sign in' in response.json()['detail']
    assert client.get(feed_url(s)).content == before


@pytest.mark.parametrize('change', ['missing_week','wrong_class','wrong_week','duplicate_week','old_timestamp','no_timezone','external_url'])
def test_incomplete_or_invalid_upload_is_rejected(bridge,change):
    client,s = bridge
    data = upload_data(client,s)
    if change == 'missing_week': data['weeks'] = []
    elif change == 'wrong_class': data['weeks'][0]['url'] = data['weeks'][0]['url'].replace('klasseid=31','klasseid=99')
    elif change == 'wrong_week': data['weeks'][0]['monday'] = '2000-01-03'
    elif change == 'duplicate_week': data['weeks'] *= 2
    elif change == 'old_timestamp': data['captured_at'] = (datetime.now(timezone.utc)-timedelta(hours=1)).isoformat()
    elif change == 'no_timezone': data['captured_at'] = datetime.now().isoformat()
    elif change == 'external_url': data['weeks'][0]['url'] = 'https://example.com/lectio/21/SkemaNy.aspx'
    assert client.post('/api/v1/class/21/31/snapshot',json=data,headers=auth(s)).status_code == 422
    assert client.get(feed_url(s)).status_code == 503


def test_replay_cannot_overwrite_snapshot(bridge):
    client,s = bridge
    data = upload_data(client,s)
    assert client.post('/api/v1/class/21/31/snapshot',json=data,headers=auth(s)).status_code == 200
    assert client.post('/api/v1/class/21/31/snapshot',json=data,headers=auth(s)).status_code == 409


def test_unknown_class_and_content_type(bridge):
    client,s = bridge
    assert client.get('/api/v1/class/99/31/schedule.ics?key='+s.feed_token).status_code == 404
    assert client.post('/api/v1/class/99/31/snapshot',json={},headers=auth(s)).status_code == 404
    assert client.post('/api/v1/class/21/31/snapshot',content='x',headers=auth(s)).status_code == 415


def test_oversize_upload_is_rejected(bridge):
    client,s = bridge
    response=client.post('/api/v1/class/21/31/snapshot',content=b'x'*5_000_001,headers={**auth(s),'Content-Type':'application/json'})
    assert response.status_code == 413


def test_stale_snapshot_retained_and_labelled(bridge):
    import sqlite3
    client,s = bridge
    client.post('/api/v1/class/21/31/snapshot',json=upload_data(client,s),headers=auth(s))
    old=(datetime.now(timezone.utc)-timedelta(hours=2)).isoformat()
    with sqlite3.connect(s.database) as con:
        con.execute('UPDATE feed SET received=?',(old,))
    response=client.get(feed_url(s))
    assert response.status_code == 200
    assert response.headers['x-lectio-stale'] == 'true'


def test_setup_creates_secrets_without_replacing_them(tmp_path):
    import os
    config=tmp_path/'config.json'
    env={**os.environ,'LECTIO_CONFIG':str(config)}
    command=[sys.executable,str(Path(__file__).resolve().parents[1]/'setup_project.py'),'--school-id','123','--class-id','456']
    subprocess.run(command,env=env,check=True,capture_output=True)
    initial=json.loads(config.read_text())
    assert initial['school_id']==123 and initial['class_id']==456
    assert initial['upload_token'] != initial['feed_token']
    subprocess.run(command,env=env,check=True,capture_output=True)
    assert json.loads(config.read_text()) == initial


EMPTY_GRID = '<table class="s2skema"><tr><td></td></tr></table>'


def test_holiday_week_is_allowed_but_all_empty_snapshot_is_rejected(tmp_path):
    s = Settings(21,31,'u'*43,'f'*43,str(tmp_path/'feed.sqlite3'),0,1)
    client = TestClient(create_app(parse_schedule,build_calendar,SourceError,s,empty_marker=has_empty_marker))
    data = upload_data(client,s)
    data['weeks'][1]['html'] = EMPTY_GRID
    assert client.post('/api/v1/class/21/31/snapshot',json=data,headers=auth(s)).status_code == 200
    data = upload_data(client,s)
    for week in data['weeks']:
        week['html'] = EMPTY_GRID
    response = client.post('/api/v1/class/21/31/snapshot',json=data,headers=auth(s))
    assert response.status_code == 422 and 'No lessons' in response.json()['detail']
    # Explicit Lectio marker allows a genuinely empty window.
    data = upload_data(client,s)
    for week in data['weeks']:
        week['html'] = '<table class="s2skema"><tr><td>Ingen aktiviteter</td></tr></table>'
    assert client.post('/api/v1/class/21/31/snapshot',json=data,headers=auth(s)).status_code == 200


def test_setup_updates_ids_but_keeps_keys(tmp_path):
    import os
    config=tmp_path/'config.json'
    env={**os.environ,'LECTIO_CONFIG':str(config)}
    script=str(Path(__file__).resolve().parents[1]/'setup_project.py')
    subprocess.run([sys.executable,script,'--school-id','21','--class-id','31'],env=env,check=True,capture_output=True)
    first=json.loads(config.read_text())
    out=subprocess.run([sys.executable,script,'--class-id','12345678901'],env=env,check=True,capture_output=True,text=True).stdout
    second=json.loads(config.read_text())
    assert 'Updated settings' in out
    assert second['class_id']==12345678901 and second['school_id']==21
    assert (second['upload_token'],second['feed_token'])==(first['upload_token'],first['feed_token'])
    bad=subprocess.run([sys.executable,script,'--class-id','3i'],env=env,capture_output=True,text=True)
    assert bad.returncode!=0 and 'klasseid' in bad.stderr


def test_events_json_and_calendar_page(bridge):
    client,s = bridge
    # The page is a static shell; the key travels in the URL fragment.
    html = client.get('/class/21/31')
    assert html.status_code == 200 and 'text/html' in html.headers['content-type']
    assert "connect-src 'self'" in html.headers['content-security-policy']
    assert client.get('/class/21/99').status_code == 404
    events_url = '/api/v1/class/21/31/events.json'
    bearer = {'Authorization': f'Bearer {s.feed_token}'}
    assert client.get(events_url, headers=bearer).status_code == 503
    client.post('/api/v1/class/21/31/snapshot',json=upload_data(client,s),headers=auth(s))
    data = client.get(events_url, headers=bearer).json()
    ev = data['events'][0]
    assert ev['title'] == 'Matematik' and ev['teacher'] == 'AB' and ev['location'] == 'A12'
    assert ev['start'].endswith('08:00') and ev['end'].endswith('09:30') and not ev['all_day']
    assert client.get(f'{events_url}?key={s.feed_token}').status_code == 200   # old links still work
    assert client.get(events_url, headers={'Authorization': f'Bearer {s.upload_token}'}).status_code == 401
    cfg = client.get('/api/v1/bridge/config',headers=auth(s)).json()
    assert cfg['view_path'] == f'/class/21/31#key={s.feed_token}'

def test_subscription_can_hide_subject_groups(bridge):
    client,s = bridge
    client.post('/api/v1/class/21/31/snapshot',json=upload_data(client,s),headers=auth(s))
    events = client.get(f'/api/v1/class/21/31/events.json?key={s.feed_token}').json()['events']
    group = events[0]['group']
    assert len(group) == 10 and events[0]['kind'] in ('course','event')
    full = Calendar.from_ical(client.get(feed_url(s)).content).walk('VEVENT')
    filtered = Calendar.from_ical(client.get(feed_url(s)+'&hide='+group).content).walk('VEVENT')
    assert len(full) == 1 and len(filtered) == 0
    # Junk in ?hide= is ignored rather than breaking the feed.
    assert len(Calendar.from_ical(client.get(feed_url(s)+'&hide=<script>,zz').content).walk('VEVENT')) == 1


def test_google_client_id_is_validated_and_exposed(tmp_path):
    with pytest.raises(ValueError):
        Settings(21,31,'u'*43,'f'*43,str(tmp_path/'x.db'),0,0,'not-a-client-id')
    s = Settings(21,31,'u'*43,'f'*43,str(tmp_path/'x.db'),0,0,'123-abc.apps.googleusercontent.com')
    client = TestClient(create_app(parse_schedule,build_calendar,SourceError,s,empty_marker=has_empty_marker))
    client.post('/api/v1/class/21/31/snapshot',json=upload_data(client,s),headers=auth(s))
    data = client.get(f'/api/v1/class/21/31/events.json?key={s.feed_token}').json()
    assert data['google_client_id'] == '123-abc.apps.googleusercontent.com'
    page = client.get(f'/class/21/31?key={s.feed_token}')
    assert 'https://accounts.google.com/gsi/client' in page.headers['content-security-policy']


def test_security_headers_and_no_api_docs(bridge):
    client,s = bridge
    r = client.get('/')
    assert r.headers['x-content-type-options'] == 'nosniff'
    assert r.headers['x-frame-options'] == 'DENY'
    assert r.headers['referrer-policy'] == 'no-referrer'
    assert "default-src 'none'" in r.headers['content-security-policy']
    for path in ('/docs', '/redoc', '/openapi.json'):
        assert client.get(path).status_code == 404
    assert client.get('/healthz').json() == {'ok': True}


def test_repeated_wrong_keys_are_locked_out(bridge):
    client,s = bridge
    for _ in range(20):
        assert client.get(feed_url(s).replace(s.feed_token, 'x'*43)).status_code == 401
    assert client.get(feed_url(s)).status_code == 429   # even the right key, for a while
    assert client.get('/healthz').status_code == 200


def test_settings_from_environment(tmp_path, monkeypatch):
    import bridge_api
    monkeypatch.setattr(bridge_api, 'CONFIG', tmp_path/'missing.json')
    env = {'LECTIO_SCHOOL_ID':'21','LECTIO_CLASS_ID':'31','LECTIO_UPLOAD_TOKEN':'u'*43,
           'LECTIO_FEED_TOKEN':'f'*43,'LECTIO_DATABASE':str(tmp_path/'db.sqlite3'),'LECTIO_FUTURE_WEEKS':'4'}
    for k,v in env.items():
        monkeypatch.setenv(k,v)
    s = bridge_api.Settings.load()
    assert (s.school_id, s.class_id, s.future_weeks, s.google_client_id) == (21, 31, 4, '')
    monkeypatch.delenv('LECTIO_FEED_TOKEN')
    with pytest.raises(Exception):
        bridge_api.Settings.load()


def test_default_rule_and_personal_subscription(tmp_path):
    from bridge_api import default_shown, filter_calendar, calendar_to_events
    ev = lambda title, kind='event': {'title': title, 'kind': kind, 'group': 'g'}
    assert default_shown(ev('Mathematics', 'course'), False)
    assert default_shown(ev('Klassefoto'), False) and default_shown(ev('Field trip'), False)
    assert default_shown(ev('Projektuge'), True)                    # all-day item
    assert not default_shown(ev('General Physics Club'), False)
    assert not default_shown(ev('Trænerakademiet'), False) and not default_shown(ev('OD-udvalgsmøde'), True)
    lessons = [
        app_lesson('Matematik', 8, '1', hold='3i maHL'),
        app_lesson('Klassefoto', 10, '2'),
        app_lesson('Chess Club', 12, '3'),
    ]
    cal = build_calendar(lessons, 21, 31)
    events = {e['title']: e for e in calendar_to_events(cal)}
    assert [events[t]['default_on'] for t in ('Matematik', 'Klassefoto', 'Chess Club')] == [True, True, False]
    titles = lambda body: sorted(str(e['summary']) for e in Calendar.from_ical(body).walk('VEVENT'))
    assert titles(filter_calendar(cal, on=set())) == ['Klassefoto', 'Matematik']                  # defaults
    assert titles(filter_calendar(cal, on={events['Chess Club']['group']})) == ['Chess Club', 'Klassefoto', 'Matematik']
    assert titles(filter_calendar(cal, on=set(), off={events['Matematik']['group']})) == ['Klassefoto']
    assert len(titles(filter_calendar(cal))) == 3                                               # plain link: everything


def app_lesson(title, hour, absid, hold=''):
    from datetime import datetime
    import app
    start = datetime(2026, 11, 2, hour, 0, tzinfo=app.COPENHAGEN)
    notes = f'{title}\nHold: {hold}' if hold else title
    return app.Lesson(title, '', '', start, start.replace(hour=hour + 1), notes, absid)
