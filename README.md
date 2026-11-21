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

## Live on the internet (free: Render + Neon, both with "Sign in with GitHub")

The website runs on **Render**. The data is kept in a free **Neon** PostgreSQL database, so it stays safe through restarts.
On the office PC (`run.bat`) the same code uses the local SQLite file instead.

1. **Neon** (database): go to https://neon.tech → *Sign in with GitHub* → create a project (region: Singapore).
   Copy the **connection string** (`postgresql://...neon.tech/neondb?sslmode=require...`).
2. **Render** (website): go to https://render.com → *Sign in with GitHub* → **New + → Blueprint** →
   select this repository. `render.yaml` sets everything up. When it asks, paste the Neon string into **DATABASE_URL**.
3. After the deploy finishes, open the link (`https://audit-dossier-xxxx.onrender.com`). Log in as `admin / admin123`.
   You are asked to set a new password straight away.
4. Go to **Settings → Import**, upload the Google Sheet (.xlsx), then set passwords and salaries under **Users**.

On the free plan the site sleeps after 15 minutes without visitors. The first page after that takes about 30–50 seconds to open.
To update the site, push to the `audit-portal-system` branch and Render deploys it again automatically.
