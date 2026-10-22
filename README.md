# KSCW H2 Team Hub

Team website for KSC Wiedikon Herren 2: home page, schedule and results, standings, roster with player pages, stats, awards, and the full league schedule.

## Where the data comes from

| What | Source | Who updates it |
|---|---|---|
| Games, times, venues, scores, quarter scores, referees (our team and the whole league) | basketplan.ch, the system behind probasket.ch | Automatic, every 2 hours |
| Standings | Worked out from those results | Automatic |
| Last season's results and record | basketplan.ch | Automatic |
| Players (number, position, height, nationality, bio, photo) | Google Sheet, tab `Players` | You |
| Game stats (points, 3PM, FTM, fouls, starts) | Google Sheet, one tab per season: `Stats 2026/27`, `Stats 2025/26` | You (last season is already filled in) |
| Awards | Google Sheet, tab `Awards` | You |
| Scouting videos | Google Sheet, tab `Scouting` (each post shows 7 days before the game) | You |
| Other clubs' logos and websites | `data/teams.json` and `assets/teams/` | Already filled in for every team this season |

## One-time setup

### 1. Put the site on GitHub (free)

1. Create a free account at https://github.com if you don't have one.
2. Click **New repository**. Name it, for example, `kscw-h2`. Make it **Public**.
3. On the new repository page, click **uploading an existing file** and drag in *everything* from this folder, including the hidden `.github` folder. (On a Mac, press Cmd+Shift+. in Finder to show hidden folders.) Then click **Commit changes**.
4. Go to **Settings → Pages**. Under *Build and deployment*, set Source to **Deploy from a branch**, branch **main**, folder **/ (root)**. Save.
5. After a minute, the site is live at `https://<your-username>.github.io/kscw-h2/`. That's the link to send the team.

### 2. Turn on automatic updates

1. Go to **Settings → Actions → General**. Under *Workflow permissions*, choose **Read and write permissions**. Save.
2. Go to the **Actions** tab. If asked, click to enable workflows.
3. Open **Update league data** and click **Run workflow** once to test it. After that it runs by itself every 2 hours.

New results show up on the hub once ProBasket enters them in basketplan (usually after the game is confirmed, sometimes a day or two later).

### 3. Make the Google Sheet

1. Create a new Google Sheet with tabs named exactly `Players`, `Stats 2026/27`, `Stats 2025/26`, `Awards`, `Scouting`, `Playbook`.
2. Copy the header row for each tab from the matching file in the `data/` folder (for example `data/Players.csv`), one column name per cell in row 1.
3. In the `Players` tab, format the `number` column as **Plain text** (Format → Number → Plain text), so jersey numbers like `00` stay as they are.
4. Click **Share → General access → Anyone with the link → Viewer**. Only you keep edit rights.
5. Copy the ID from the sheet's address: `docs.google.com/spreadsheets/d/`**`THIS-LONG-PART`**`/edit`
6. On GitHub, open `config.js`, click the pencil icon, paste the ID between the quotes in `googleSheetId: ""`, and commit.

From then on, changes in the sheet show up on the hub the next time someone opens or refreshes the page. No GitHub step is needed.

## Filling in the sheet

**Players**: one row per player.

| Column | Example | Notes |
|---|---|---|
| name | Max Muster | Full name shown on the hub |
| alias | Max | Other spellings used in the Stats or Awards tabs, comma-separated (e.g. the first name). Links last season's stats to the player |
| number | 7 | |
| position | PG | PG, SG, SF, PF or C (e.g. `SG/SF` also works) |
| secondary_position | SG | Optional, shown next to the main position |
| role | Player | `Player`, or e.g. `Coach` to list someone under coaching staff |
| height_cm | 188 | |
| nationality | Switzerland | Shown with a flag |
| born, nickname, since | 1998, "Flash", 2021 | All optional |
| bio | A few sentences | Optional |
| photo | Link to an image | Optional. Leave empty to show the jersey number instead |
| active | yes | Set to `no` to hide someone from the roster |

**Stats 2026/27** (and `Stats 2025/26` for last season): one row per player per game, one tab per season. Enter this season's games only in this season's tab. Players who didn't play get no row (or `dnp` = yes). Leave a column empty if you didn't track it (fouls, for example): the hub hides a column that has no numbers in that season.

| date | player | pts | 3pm | ftm | fouls | dnp | gs |
|---|---|---|---|---|---|---|---|
| 2026-10-23 | Max Muster | 14 | 2 | 4 | 3 | | 1 |

The date must match the game date on basketplan (format `YYYY-MM-DD`). `gs` is 1 if the player started, 0 if not. A row whose date doesn't match one of that season's games is ignored. Averages, leaders, box scores and game logs are worked out from these tabs. Last season's 155 rows are also kept in `data/Stats-2025-26.csv` as a backup.

**Awards**: `season, award, player, note`, for example `2025/26, Loudmouth Award, Max Muster, Never stopped talking`.

**Scouting**: `date, until, title, text, link`. Shown in the Scouting box on Home. A row shows from its `date` (a future date stays hidden until then). If `until` is set, the row is hidden from the day after. Scouting posts use this: `date` is 7 days before the game, `until` is the game date.

## Attendance and trainings

- **Attendance page:** players pick their name once (the phone remembers it) and tap In or Out for each training and game, up to the start time. Saying In counts as attending. "Away for a while?" sets a player Out for a date range.
- **Where answers go:** the private sheet *KSCW H2 Attendance (private)* in Drive › KSCW H2 › Private (Philipp & Paul only). Its script (copy in `scripts/attendance.gs`) saves the taps. The **Tracker** tab shows each player's training and game rate; **Sessions** shows who said what per session. Both refresh every night and whenever the sheet is opened (or use the H2 menu → Refresh tracker). Share this sheet only with the coach.
- **Trainings tab** (in the hub sheet), one row per rule. Keep the columns as plain text:
  - `weekly`: day (Tue, Fri), start, end, place, address. `date` / `until` limit when the pattern applies, e.g. a new time from January.
  - `cancelled`: date, plus `until` for a range such as school holidays. `note` is shown in the hub, e.g. "Gym closed".
  - `moved`: date plus the new start / end / place.
  - `extra`: date, start, end, place: a one-off training.
  - No training is planned on a day with a game.
- **Calendar:** `data/team.ics` lists games and trainings. It is rebuilt every 2 hours with the league data, so cancellations disappear from phones by themselves.
- **If the script is changed:** in Apps Script, Deploy → Manage deployments → edit (pencil) → Version: New version → Deploy. The web app URL stays the same.

## Next season

Add the new season at the top of `data/seasons.json`, with the basketplan season id, the league code and our team's name as basketplan writes it. For example:

```json
{ "id": 32, "label": "2027/28", "league": "H2LR", "team": "KSC Wiedikon Herren 2 H2" }
```

Then add a new tab `Stats 2027/28` in the sheet with the same header row (`date, player, pts, 3pm, ftm, fouls, dnp, gs`) and an empty `data/Stats-2027-28.csv`. Older seasons' tabs stay as they are.

## Good to know

- Club logos come from each club's own website and are only used to show which team is which. If a club changes its logo, replace the file in `assets/teams/`. Teams with no logo get coloured initials.
- After changing `app.js` or `styles.css`, raise the `?v=` number on those files in `index.html` so everyone's browser loads the new version.

- Standings on the hub are unofficial: win = 2 points, ties are split by head-to-head results, then point difference. The official table is on basketplan.
- GitHub pauses scheduled jobs in a repository with no activity for 60 days, which can happen in the off-season. If the hub stops updating, open **Actions → Update league data** and click **Enable workflow**.
- To try the site on your own computer, run `python3 -m http.server` in this folder and open http://localhost:8000.
