# Brain Points

A gamified day planner that runs on free Google tools. You give it your weekly schedule and your tasks, and it plans each day for you, writes every block to Google Calendar so your phone (and smartwatch) buzzes when it's time to switch, and tracks your **brain points**: a 100-point daily budget of mental energy.

There's no App Store app and no server to pay for. Everything runs in a Google Sheet with an attached Apps Script, plus a web page you save to your phone's home screen.

## How it works

- **100 brain points every morning.** Every class, meeting and task costs some; meals, hobbies and free time cost nothing.
- **The planner fills your free time with tasks**, most important first, until the day's budget is used up. Tasks due today always get a slot, even over budget.
- **Brain points drain through the day:** a steady 20-point baseline from wake to bed, plus each block's cost while it runs. A fully planned day ends around 10 at bedtime.
- **Unfinished work carries over.** Tomorrow starts at 100, minus half the points of task blocks you didn't tick off and minus 5 per overdue task (never below 50). A lower start means the planner gives you a lighter day.
- **Every block is a Google Calendar event with an alert**, so your phone and any watch that mirrors phone notifications buzz at each transition.
- **Optional phone-time tracking:** iPhone Shortcuts automations log when entertainment apps open and close, and the Today page shows minutes used against a daily budget. It's information only and doesn't cost brain points.

## What's in this repo

| File | What it does |
|---|---|
| `Code.gs` | Web app entry point (`doGet`), `setup()`, phone-time logging, shared helpers |
| `Scheduler.gs` | Pure planning logic: priorities, task placement, brain-point math |
| `Planner.gs` | Reads and writes the Sheet and Google Calendar; day start, ticking off blocks, completing tasks |
| `View.gs` | The mobile **Today** page (HTML dashboard) |

A custom Garmin watch face that reads the `face` endpoint isn't included. You don't need it: calendar alerts already reach most smartwatches. See [Building your own watch face](#building-your-own-watch-face).

## Setup (about 20 minutes)

You'll need a Google account and, for notifications, a phone with Google Calendar synced. A computer makes the Apps Script steps much easier.

### 1. Create the Sheet and script

1. Create a new, empty Google Sheet (for example "Brain Points").
2. Open **Extensions → Apps Script**. Creating the script from inside the Sheet matters, because the code expects to be attached to it.
3. Delete the starter code in `Code.gs`, then paste in this repo's `Code.gs`.
4. Click **+ next to Files → Script** three times to add `Scheduler`, `Planner` and `View`, and paste in the matching file each time. Apps Script adds the `.gs` extension itself.
5. Save with **Ctrl/Cmd+S**.

### 2. Set your timezone

Go to **Project Settings** (the gear icon) → **Time zone** and pick yours. All block times, the midnight job and the daily totals use this timezone.

### 3. Run `setup` once

1. In the editor toolbar, choose **`setup`** in the function dropdown (next to Run and Debug), then click **Run**.
2. Approve the permissions: **Review permissions → your account → Advanced → Go to (project name) (unsafe) → Allow**. The warning is normal for a script you made yourself. The script needs access to the Sheet, to create a "Brain Points" calendar, and to run a nightly job.
3. The **Execution log** shows `Your secret key: …`. You can also find it later under **Project Settings → Script Properties → KEY**.

`setup` creates these tabs in your Sheet:

| Tab | You edit it? | Contents |
|---|---|---|
| `settings` | Yes | Wake time, bedtime and the game rules (see [Settings](#settings)) |
| `fixed` | Yes | Your weekly schedule: classes, work, meals, workouts, hobbies |
| `tasks` | Yes | Tasks with deadline, impact, hours and difficulty |
| `plan` | Only the `done` checkboxes | Every planned block, written by the script |
| `checkins` | No | One row per day: starting brain points and carry-over |
| `events`, `daily` | No | Phone-time log and daily totals |

It also adds a daily trigger (around 00:05) that sets up each new day, and creates a **Brain Points** Google Calendar.

> **The `fixed` tab is pre-filled with the author's own schedule as an example.** Replace it with yours (step 5), or edit the seed rows in `setup()` in `Code.gs` before running it.

### 4. Deploy the web app

1. Click **Deploy → New deployment**, then click the gear next to "Select type" and choose **Web app**.
2. Set **Execute as: Me** and **Who has access: Anyone**. "Anyone" lets your phone open the page without a Google sign-in; the secret key is what keeps everyone else out.
3. Click **Deploy** and copy the **Web app URL**. It ends in `/exec`.

If the URL contains `/u/1/` (or another number) after `/macros`, delete that part. It comes from being signed in to several Google accounts and stops the link from working.

**Every time you change the code,** go to **Deploy → Manage deployments → pencil icon → Version: New version → Deploy**. The URL stays the same, but it keeps running the old code until you do this.

### 5. Fill in your schedule and tasks

**`settings`:** set `wake_time` and `bed_time` first, as `HH:MM`. Bedtime must be before midnight.

**`fixed`:** one row per recurring block.

| name | days | start | end | type | bp |
|---|---|---|---|---|---|
| Biology Lecture | Mon,Wed,Fri | 10:00 | 10:50 | class | 15 |
| Lunch | Daily | 12:00 | 12:45 | meal | 0 |
| Gym | Tue,Thu | 17:30 | 18:30 | workout | 0 |

- `days`: `Daily`, `Weekdays`, `Weekends`, or a list like `Mon,Wed,Fri`.
- `start` / `end`: `HH:MM` in 24-hour time; `5:30 PM` also works.
- `type`: anything descriptive (`class`, `meeting`, `work`, `meal`, `workout`, `hobby`). `hobby` and `workout` blocks get a tick-off circle on the Today page.
- `bp`: how draining the block is. Rough guide: a 1-hour lecture is 10–15, a full workday is 30 or more, meals 0.

**`tasks`:** fill in only these five columns. `id`, `hours_left` and `status` fill in automatically.

| task | deadline | impact (1-5) | hours | difficulty (1-3) |
|---|---|---|---|---|
| Problem set 4 | 2026-11-20 | 4 | 3 | 3 |

- **impact:** 5 means it really matters (an exam, a big deadline); 1 means nice to have.
- **difficulty:** 3 is deep focus, 1 is easy and mindless. A task block costs `hours × difficulty × 10` brain points.
- **hours:** estimate a little high.
- To drop a task without deleting it, set its `status` to `dropped`.

Delete the `EXAMPLE - delete me` row.

Changes to `tasks` are picked up the next time the day is planned or replanned. Changes to `fixed` and `settings` apply from the next day. To apply them today, reload the Sheet on a computer and use the **Brain Points** menu: **Rebuild today's fixed blocks**, then **Replan rest of today**.

### 6. Open the Today page on your phone

Open this in Safari (or any mobile browser), using your URL and key:

```
https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec?key=YOUR_KEY&action=view
```

The first visit sets up today. Then use **Share → Add to Home Screen** so it opens like an app. The page shows:

- brain points now, this morning's start, and a projection for bedtime
- phone entertainment minutes against your budget
- today's timeline with NOW and NEXT tags. Tap the circle on a block to tick it off, which also reduces the task's `hours_left`.
- open tasks, most important first. Tap ✓ twice to complete a whole task early, which removes its later blocks.
- **Replan rest of today**, after plans change

A thin grey "created by a Google Apps Script user" bar at the top is added by Google and can't be removed.

### 7. Get the alerts on your phone (and watch)

1. **Sync the calendar to your phone.** On iPhone: **Settings → Calendar → Accounts**, add your Google account and turn Calendars on. Then, in the Calendar app, make sure **Brain Points** is ticked. If it doesn't appear, open `calendar.google.com/calendar/syncselect` in a browser, tick it there, and wait a minute.
2. **Check that alerts come through.** Open an upcoming Brain Points event; it should say **Alert: At time of event**. If it says None, open Google Calendar on the web and go to the **Brain Points calendar's settings → Event notifications**. Add "0 minutes before", then use **Replan** so the events are recreated.
3. **Allow Calendar notifications** on the phone, with Lock Screen and Notification Center on.
4. **For a smartwatch,** turn on phone notifications in the watch's companion app. For Garmin on iPhone, also go to **Settings → Bluetooth → ⓘ next to the watch** and turn on **Share System Notifications**. If that's off, the watch never receives notifications. Don't force-quit the watch's companion app.

To test, create a Brain Points event 3 minutes from now with an alert at the start time, lock your phone and wait.

## Optional extras

All the endpoints below take your web app URL plus `?key=YOUR_KEY&action=…`.

### Add Task shortcut (iPhone)

Build this in the **Shortcuts** app:

1. **Ask for Input** (Text) "Task?" → **Set Variable** `Name`
2. **Ask for Input** (Date) "Due?" → **Format Date** (Custom: `yyyy-MM-dd`) → **Set Variable** `Due`
3. **Ask for Input** (Number) three times → **Set Variable** `Impact`, `Hours`, `Diff`
4. **URL Encode** `Name` → **Set Variable** `NameEnc`
5. **Text:** `https://…/exec?key=YOUR_KEY&action=addtask&name=` then insert the variables in order: [NameEnc] `&deadline=` [Due] `&impact=` [Impact] `&hours=` [Hours] `&difficulty=` [Diff]
6. **Get Contents of URL** with the Text from step 5
7. **Show Result**

Insert variables as variable chips from the bar above the keyboard; typing a variable's name sends that text literally. Building the URL in a **Text** action is easier than editing the URL field directly. Adding a task replans the rest of today right away.

### Phone-time tracking (iPhone)

For each entertainment app, create two **Personal Automations** in Shortcuts (**Automation → + → App**):

- **Is Opened** → Run Immediately, Notify When Run off → **Get Contents of URL**:
  `…/exec?key=YOUR_KEY&action=log&app=youtube&event=open`
- **Is Closed** → same, with `event=close`

Use a short lowercase name per app; it's the label in the per-app breakdown. Alternatively, make one pair covering several apps with `app=entertainment` (the total is still correct, but there's no per-app split). The budget and other options are in `CONFIG` at the top of `Code.gs`.

How time is counted: a session ends at that app's close, or at the next app opening. If neither arrives (for example, you lock the phone mid-video), it counts at most `SESSION_CAP_MIN` minutes (45 by default).

### Endpoint reference

| `action=` | Returns | Purpose |
|---|---|---|
| `view` | HTML | The Today page |
| `tasks` | text | Open tasks, most important first |
| `addtask` | text | Add a task: `name`, `deadline` (YYYY-MM-DD), `impact`, `hours`, `difficulty` |
| `replan` | text | Re-plan the rest of today from now |
| `complete` | JSON | Finish a whole task: `id=T3` |
| `done` | JSON | Tick off a block: `n=` (block number), optional `date=` |
| `plan` | JSON | A day's blocks, optional `date=` |
| `face` | JSON | A compact payload for a watch face (see below) |
| `log` | JSON | Log app use: `app=`, `event=open\|close` |
| `today` / `day` | JSON | Phone-time totals for today / `date=` |

## Settings

These are in the `settings` tab. If a row is missing, its default is used.

| key | default | meaning |
|---|---|---|
| `wake_time` / `bed_time` | 07:30 / 23:30 | Day window (bedtime before midnight) |
| `wind_down_min` | 30 | No tasks in this buffer before bed |
| `min_block_min` / `max_block_min` | 25 / 90 | Shortest and longest task block |
| `break_min` | 10 | Break after each task block |
| `max_task_min_per_day` | 180 | Most time one task gets per day (unless it's due) |
| `bp_per_hour_per_difficulty` | 10 | Task cost = hours × difficulty × this |
| `base_bp` | 100 | Morning starting points |
| `baseline_bp` | 20 | Steady drain from wake to bed |
| `reserve_bp` | 10 | Points the planner leaves unscheduled |
| `bp_floor` | 50 | Morning start never goes below this |
| `stress_factor` | 0.5 | Share of yesterday's unfinished task points carried over |
| `overdue_bp` | 5 | Extra carry-over per overdue task |
| `calendar_name` | Brain Points | Calendar the plan is written to |
| `water_every_min` | 0 | Water reminder interval in minutes (0 = off) |

## Building your own watch face

`action=face` returns about 200 bytes of JSON, small enough for a watch with very little memory:

```json
{"d":"2026-11-14","bp":90,"bs":100,"c0":450,"c":[100,99,97],"pm":56,"pb":60,
 "b":[[1125,1170,"Dinner","f"],[1170,1200,"Guitar","f"]]}
```

| field | meaning |
|---|---|
| `d` | Date (ignore cached data from another day) |
| `bp` | Brain points right now |
| `bs` | This morning's start |
| `c0`, `c` | Brain points every 30 minutes starting at minute `c0` (wake time). Interpolate for a live value between fetches. |
| `pm`, `pb` | Phone minutes used and budget |
| `b` | Up to 6 remaining blocks: `[startMin, endMin, name, kind]`, where kind `t` = task, `f` = fixed, `m` = marker |

Times are minutes since midnight. On Garmin Connect IQ, a background temporal event (every 15 minutes at most, 5 minimum) can call `makeWebRequest` with the full URL, including `key` and `action` in the query string, then store the result for the watch face to draw.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Sorry, unable to open the file at this time" | You're signed in to several Google accounts. Use a private window, or remove `/u/1/` from the URL. |
| `{"ok":false,"error":"bad key"}` | The URL works but the key is wrong. Copy it from Project Settings → Script Properties → `KEY`. |
| A sign-in page or "You need access" | Set the deployment's access to **Anyone**. School and work accounts may not allow this, so use a personal Gmail. |
| Changes don't show up | Deploy a **New version** (see step 4). |
| An error mentioning `null` / `getSheetByName` | The script was created on its own at script.google.com. Create it from the Sheet with **Extensions → Apps Script**. |
| No buzz on the watch | See step 7, especially Share System Notifications for Garmin on iPhone. |
| Times show as odd dates in the Sheet | Keep times as plain text `HH:MM`. `setup` formats those columns as text, so recreate a tab by deleting it and running `setup` again. |

## Privacy and security

- Your secret key lives in Script Properties, not in the code, so these files are safe to commit. **Never commit or share your key or a URL that contains it.**
- To rotate the key, delete `KEY` under Script Properties and run `setup` again. Then update your bookmarks and shortcuts.
- All data stays in your own Google Sheet and Calendar.
