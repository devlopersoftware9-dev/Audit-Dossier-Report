"""
Schedule logic — same rules as the old Google Sheet column B (Y/N) and column T (REVISED TARGET):

  B: Y/N =  checklist empty            -> no
            Friday and company <> RCG  -> N
            Target = "Daily"           -> Y
            Target = today's day name  -> Y   (Mon, Tue ... Sun)
            Revised target = today     -> Y   (Target 1-31 = that date of the month, moved one day back if Friday;
                                               Quarterly/Twice a Year/Yearly use Target Month)
            otherwise                  -> N   ("Triggered" tasks never come in Today's list)
"""
from datetime import date, timedelta

DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']   # date.weekday() order
BUCKET_ORDER = {'Daily': 1, 'Weekly': 2, 'Fortnightly': 3, 'Monthly': 4, 'Quarterly / Yearly': 5}


def norm(v):
    return '' if v is None else str(v).strip().lower()


def day_name(d):
    return DAY_NAMES[d.weekday()]


def sheet_date(y, m, d):
    """Google-Sheets DATE(y, m, d): month/day overflow and day 0 / negatives roll over."""
    y += (m - 1) // 12
    m = (m - 1) % 12 + 1
    return date(y, m, 1) + timedelta(days=d - 1)


def revised_target(t, d, off_day='Fri'):
    """Column T: the date a 1-31 target falls on in the month of d (or None)."""
    if not str(t.get('task') or '').strip():
        return None
    target = t.get('target')
    if target is None or str(target).strip() == '':
        day = 0
    else:
        try:
            day = int(float(str(target).strip()))
        except ValueError:
            return None
    month = d.month
    if norm(t.get('recurrence')) in ('quarterly', 'twice a year', 'yearly'):
        try:
            month = int(float(t.get('target_month') or 0))
        except ValueError:
            month = 0
    try:
        rd = sheet_date(d.year, month, day)
    except (ValueError, OverflowError):
        return None
    if day_name(rd) == off_day:
        rd -= timedelta(days=1)
    return rd


def is_scheduled(t, d, off_day='Fri', work_on_off_day=('RCG',)):
    if not str(t.get('checklist') or '').strip():
        return False
    dn = day_name(d)
    if dn == off_day and norm(t.get('company')) not in [norm(c) for c in work_on_off_day]:
        return False
    target = norm(t.get('target'))
    if target == 'daily':
        return True
    if target == norm(dn):
        return True
    return revised_target(t, d, off_day) == d


def bucket(t):
    """Group heading: Daily / Weekly / Fortnightly / Monthly / Quarterly / Yearly."""
    r, k = norm(t.get('recurrence')), norm(t.get('task'))
    if r == 'daily':
        return 'Daily'
    if r == 'weekly':
        return 'Weekly'
    if r.startswith('fort') or r.startswith('forn'):
        return 'Fortnightly'
    if r == 'monthly':
        return 'Monthly'
    if r in ('quarterly', 'yearly', 'twice a year'):
        return 'Quarterly / Yearly'
    if 'weekly' in k:
        return 'Weekly'
    if 'fort' in k or 'forn' in k or k.startswith('fn '):
        return 'Fortnightly'
    if 'monthly' in k:
        return 'Monthly'
    if 'yearly' in k or 'quarter' in k:
        return 'Quarterly / Yearly'
    return 'Daily'
