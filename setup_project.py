"""Initialize or update local bridge configuration. Never enters Lectio credentials.

    python setup_project.py --school-id 21 --class-id 12345678901

First run: creates runtime/config.json with two new random keys.
Later runs: keeps the keys, but applies any --school-id / --class-id /
--past-weeks / --future-weeks you pass (restart Uvicorn afterwards).
"""
import argparse
import json
import os
import secrets
import sys

from bridge_api import CONFIG, Settings


def positive_int(text: str) -> int:
    """Argparse type with a readable error, e.g. for '--class-id 3i'."""
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"{text!r} is not a number. Use the numeric klasseid from the Lectio URL "
            "(…/SkemaNy.aspx?klasseid=NUMBER), not the class name.") from None
    if value <= 0:
        raise argparse.ArgumentTypeError("must be a positive number")
    return value


def write_config(data: dict) -> None:
    Settings(**data)  # Validate before writing anything.
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG.with_suffix('.tmp')
    descriptor = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, CONFIG)  # Atomic on Windows and POSIX.


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--school-id', type=positive_int, help='Number after /lectio/ in the URL (e.g. 21)')
    parser.add_argument('--class-id', type=positive_int, help='klasseid from the class schedule URL')
    parser.add_argument('--past-weeks', type=int, help='Weeks before the current week to include (0-4)')
    parser.add_argument('--future-weeks', type=int, help='Weeks after the current week to include (0-8)')
    parser.add_argument('--google-client-id', help='OAuth web client ID (…apps.googleusercontent.com) for "Add to Google Calendar"')
    parser.add_argument('--port', type=int, default=8000, help='Port shown in the printed URLs')
    args = parser.parse_args()
    overrides = {k: v for k, v in dict(school_id=args.school_id, class_id=args.class_id,
                 past_weeks=args.past_weeks, future_weeks=args.future_weeks,
                 google_client_id=args.google_client_id).items() if v is not None}

    if CONFIG.exists():
        data = json.loads(CONFIG.read_text(encoding='utf-8'))
        changed = {k: v for k, v in overrides.items() if data.get(k) != v}
        if changed:
            data.update(changed)
            try:
                write_config(data)
            except ValueError as exc:
                sys.exit(f'Not saved: {exc}')
            print('Updated settings: ' + ', '.join(f'{k}={v}' for k, v in changed.items()))
            print('Restart Uvicorn, then click "Save and sync" in the extension.')
        else:
            Settings(**data)
            print('Using existing settings (keys unchanged).')
    else:
        data = dict(school_id=21, class_id=31, past_weeks=1, future_weeks=2,
                    upload_token=secrets.token_urlsafe(32), feed_token=secrets.token_urlsafe(32),
                    database=str(CONFIG.parent / 'calendar.sqlite3'))
        data.update(overrides)
        try:
            write_config(data)
        except ValueError as exc:
            sys.exit(f'Not saved: {exc}')
        print(f'Created {CONFIG}')

    # Google sign-in requires the "localhost" host name, not 127.0.0.1.
    base = f'http://localhost:{args.port}'
    print()
    print(f"School {data['school_id']}, class {data['class_id']}, "
          f"weeks -{data.get('past_weeks', 1)}..+{data.get('future_weeks', 2)}")
    print('Backend URL:                   ' + base)
    print('Google Calendar export:        ' + ('enabled' if data.get('google_client_id') else
          'off (see README: python setup_project.py --google-client-id ID)'))
    print('Extension synchronization key: ' + data['upload_token'])
    print(f"Calendar page:  {base}/class/{data['school_id']}/{data['class_id']}#key={data['feed_token']}")
    print(f"Subscribe URL:  {base}/api/v1/class/{data['school_id']}/{data['class_id']}/schedule.ics?key={data['feed_token']}")
    print(f'Start: uvicorn app:app --host 127.0.0.1 --port {args.port} --no-access-log')
    print('(localhost and 127.0.0.1 are the same server; open the page via localhost.)')


if __name__ == '__main__':
    main()
