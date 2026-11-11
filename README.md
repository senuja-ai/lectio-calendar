# Lectio class calendar

Turns a Lectio class timetable into a clean week view **and personal,
auto-updating calendar links** for Google Calendar, Apple Calendar and Outlook.
Each student switches off the subjects they don't take, copies their own link,
and their calendar app keeps it up to date.

It has two parts:

* **`extension/`** – a Chrome/Edge extension. It reads the timetable from *your*
  signed-in Lectio tab, turns it into a lesson list in your browser, and uploads
  that list every 30 minutes while Chrome is open. Your Lectio password, cookies
  and the Lectio pages themselves never leave your browser.
* **`worker/`** – a Cloudflare Worker (free, always on, HTTPS). It stores the
  latest timetable, serves the calendar page, and builds each student's
  personal iCal feed.

```
Lectio (signed in) ──► extension (parses lessons) ──► Cloudflare Worker ──► calendar page
                                                                      └──► personal .ics links ──► Google / Apple / Outlook
```

---

## 1. Put it online (once, about 15 minutes)

You need [Node.js](https://nodejs.org) (LTS) and a free Cloudflare account.
Run these in the project folder (PowerShell on Windows):

```powershell
npm install                     # installs Wrangler, Cloudflare's tool
npx wrangler login              # opens the browser; sign up / log in to Cloudflare
npx wrangler kv namespace create TIMETABLE
```

The last command prints an `id`. Paste it into `wrangler.toml` in place of
`PASTE_YOUR_KV_NAMESPACE_ID_HERE`. Then deploy:

```powershell
npm run deploy
```

It prints your address, for example `https://lectio-calendar.yourname.workers.dev`.
(The first time, Cloudflare asks you to choose the `yourname` part.)

Now set the four secrets. Each command asks you to type or paste a value:

```powershell
npm run keys                          # prints two new random keys
npx wrangler secret put SCHOOL_ID     # the number after /lectio/ in Lectio's address, e.g. 21
npx wrangler secret put CLASS_ID      # the klasseid=… number from your class timetable's address
npx wrangler secret put UPLOAD_TOKEN  # first key from `npm run keys` (extension only)
npx wrangler secret put FEED_TOKEN    # second key (goes into the class's calendar links)
```

Check it: opening `https://…workers.dev/healthz` should show `{"ok":true}`.

> The school and class IDs are stored as secrets, so nothing in this repository
> identifies your class. `PAST_WEEKS` / `FUTURE_WEEKS` in `wrangler.toml` set
> how many weeks around today are included (default 1 back, 4 ahead).

## 2. Connect the extension

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**
   and pick the `extension` folder (or click **Reload** if it's already there).
2. Sign in to Lectio in a normal tab.
3. Click the extension icon. Enter your `https://…workers.dev` address and the
   **UPLOAD_TOKEN**, then **Save and sync** (allow access when Chrome asks).
4. When it says *Synchronized N lessons*, copy **Link to share with your class**
   and send it to your classmates.

The extension re-syncs every 30 minutes while Chrome is open and you're signed
in to Lectio. If your Lectio session expires, the class calendar simply keeps
the last good timetable until you sign in again.

## 3. What classmates do

1. Open the shared link. It's a week view of the class timetable.
2. In the list on the left, switch **off** subjects they don't take and switch
   **on** any clubs they join. (Subjects and whole-class/school events start on;
   clubs, committees and optional activities start off.)
3. Click **Add to Google Calendar**. Their personal link is copied and the page
   shows step-by-step instructions:
   open Google Calendar's *From URL* page on a computer → paste → **Add calendar**.
   The **▾** button has instructions for Apple Calendar and Outlook.

Google refreshes subscribed calendars on its own schedule (usually every few
hours, sometimes up to a day). To change subjects later, switch them on the page,
remove the old calendar in Google Calendar and add the new link.

No Google sign-in, app verification or user limit is involved: Google simply
fetches the link, so it works for any class size.

---

## Security and privacy

* **Two keys.** `UPLOAD_TOKEN` can change the timetable and lives only in your
  extension. `FEED_TOKEN` can only read it and is part of the class links.
  Share only the class link.
* **Keys stay out of logs.** The page link carries the key after `#`, which
  browsers never send to the server; the page sends it in a request header.
  Calendar apps need it in the `.ics` address (`?key=`), which is unavoidable
  for subscriptions.
* **Only lesson data is uploaded**, never Lectio HTML, passwords or cookies.
  Uploads are strictly validated; a broken or empty sync is rejected and the
  last good timetable is kept.
* **Strict headers** on every response (Content-Security-Policy with no
  third-party scripts, no framing, no referrer, HSTS). Repeated wrong keys from
  one address get HTTP 429.
* **Rotating keys** (if one leaks): run `npm run keys`, set the new value with
  `npx wrangler secret put …`, update the extension (upload key) and re-share
  the class link (feed key).

Cloudflare's free plan covers this comfortably (Workers: 100,000 requests/day;
KV: 1,000 writes/day, while a sync every 30 minutes uses 48).

## Troubleshooting

| Extension message | Fix |
|---|---|
| Cannot reach the calendar server | Check the `https://…workers.dev` address in the popup. |
| Upload key rejected | Paste the same value you set with `wrangler secret put UPLOAD_TOKEN`. |
| Server not configured: set … | A secret is missing; set it with `npx wrangler secret put NAME`. |
| Reload your signed-in Lectio tab | The tab was open before the extension was (re)loaded. Refresh it. |
| Sign in to Lectio again | Session expired. Sign in, then **Save and sync**. |
| Timetable table missing | Wrong `CLASS_ID`, or Lectio changed its page layout. |
| No lessons found in any synchronized week | Every week came back empty: usually a wrong class ID. The old calendar is kept. |
| Unsupported Lectio brick format | Lectio changed how lessons are written; the message shows an example to adapt `extension/parser.js`. |

After changing extension files, click **Reload** on the extension in
`chrome://extensions` and refresh the Lectio tab. After changing Worker files,
run `npm run deploy`.

## Development

```powershell
npm test          # parser, Worker and extension tests (Node 20+)
npm run dev       # local Worker at http://localhost:8787
```

For `npm run dev`, put local values in a `.dev.vars` file (git-ignored):

```
SCHOOL_ID=21
CLASS_ID=12345678901
UPLOAD_TOKEN=…
FEED_TOKEN=…
```
