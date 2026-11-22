# Audit Dossier Portal

The Audit Dossier as its own system: a Python (Flask) web app with its own database (SQLite).
It no longer needs Google Sheets. The old sheet's data (tasks, SOP links, TRUE/FALSE history) is imported once.

## How to run (Windows)

1. Install **Python 3.10+** from python.org, and tick ✅ *Add Python to PATH* during install.
2. Unzip this folder (for example to `D:\AuditDossier`).
3. Double-click **`run.bat`**. The first run installs what it needs (about 1 minute).
4. Open **http://localhost:5000** in the browser.
   Other computers on the office network can use **http://&lt;this-PC-IP&gt;:5000**. Run `ipconfig` to see the IP.

| Login | Username | Password |
|---|---|---|
| Admin | `admin` | `admin123` |
| Officer | `Amjad` (the name from column G of the sheet) | `1234` |

Change both passwords after the first login (the **Password** button at the top).

> The zip already includes `data/audit.db` with your sheet imported (285 task rows, 697 history records).
> On Linux or a server, use `./run.sh`.

## What the system does

- **Todays Task**: shows the tasks that were **Y** in the sheet's column B. That means Daily tasks, the matching weekday,
  and dates 1–31 (one day earlier if the date is a Friday). Quarterly and yearly tasks use the target month. Friday is off except for RCG. "Triggered" tasks never come in Today's list.
- **Department / Branch tabs**: every task of that department or branch, whatever its due date. Officers can mark these tasks too (they are saved as *Extra*, which does not count in efficiency).
- **One user per task**: each task has one assigned user, who marks it TRUE or FALSE. Admin can view one user or all users.
- **SOP link**: each task can have an SOP name and link. Both are **optional**. Clicking the check list opens a popup with all its points.
- **Database**: every tick or remark is saved date-wise. Ticking again on the same day updates the same row.
- **Missed = FALSE**: on the next day, any task that was due and not marked is saved as **FALSE** automatically (Source = *Auto-Closed*). From Settings, admin can also close a past date by hand.
- **Reporting**: filter by date range, TRUE/FALSE, user, department, branch, task type, check list and source. Export to Excel. Admin can correct a record.
- **Efficiency & Fines**: efficiency is TRUE ÷ (TRUE + FALSE). Group it by user, department, check list, branch, task type or date. Quick buttons for Yesterday, Last 7 days, This month and Last month.
- **Fines**: three kinds, all set from Settings:
  - **Per task**: Rs for each FALSE (`FINE_PER_TASK`). A department can have its own amount (`DEPT_FINES`, e.g. `Accounts:200`).
  - **Percentage**: a cut from the monthly salary, based on efficiency (`FINE_PCT_SLABS`). Set the salary under **Users**.
  - `FINE_MODE`: `NONE`, `PER_TASK`, `PERCENT` or `BOTH`.
- **Monthly Performance**: each user's scheduled, done, missed, %, grade and fine for the month. **Details** shows a department breakdown and the list of tasks not done. On the 1st of the month, the month-end snapshot is saved automatically.
- **Task Manager (Admin)**: add, edit, hide, unhide or delete tasks, and search or filter them. **＋ Point** adds another point to the same check list.
- **Users (Admin)**: add officers, set role, salary and password, or turn a user off.
- **Settings (Admin)**: fine and grade rules, closing a past day, importing again from the Google Sheet (.xlsx), and a **database backup** download.

## Importing again from the Google Sheet

In Google Sheets, go to File → Download → Microsoft Excel. Then either go to **Settings → Import** and upload the file,
or run `python import_excel.py "Audit Dossier Web.xlsx" --replace` from the command line.

## Files

| File | What it is |
|---|---|
| `app.py` | Web pages and routes |
| `core.py` | Database, today's tasks, marking, auto-FALSE, reports, fines |
| `schedule.py` | Due-date rules (a copy of the old column B formula) |
| `import_excel.py` | Import from the old sheet |
| `db.py` | Database connection (SQLite on the PC, PostgreSQL online) |
| `render.yaml` | Render deployment settings |
| `data/audit.db` | **The local database**. Back up this file regularly. |
| `tests/test_app.py` | Full test: `AUDIT_XLSX=sheet.xlsx python tests/test_app.py` |

## Live on the internet (free: GitHub Pages + Firebase)

**Live link:** https://devlopersoftware9-dev.github.io/Audit-Dossier-Report/

- The website is the `docs/` folder, served free by GitHub Pages.
- The data is stored in **Firebase Firestore** and logins use **Firebase Authentication** (project `rc-audit-dossier`). It runs on the free **Spark** plan, with no card needed.
- Security rules are in `firestore.rules` (pasted into Firebase console → Firestore → Rules).
- The first time the site opens, it shows **First-time setup** so you can create the Admin login. After that, go to **Settings → Import** and upload the Google Sheet (.xlsx).
- Officer logins are created by the import (default password `Audit@123`) or under **Users**. Everyone must set their own password at first login.
- Missed tasks become FALSE automatically the next time anyone logs in. The admin's login closes every officer's pending days.

The Python version (`app.py`, `run.bat`) is still here for running on an office PC without internet.
