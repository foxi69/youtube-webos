#!/usr/bin/env python3
"""
Fork watch: reports new work in the youtube-webos fork network as suggestions.

Run by .github/workflows/fork-watch.yml. For every fork of the watched root
repositories that was pushed to since the last run, each branch is compared
with this repository's main branch; commits that are not in main and are newer
than the last run are listed. Pull requests opened, updated or merged on the
root repositories since the last run are listed too (one closed without
merging is left out: nothing to port), and so are issues opened on
them since the last run that are still open (feature requests and bug
reports worth a look). When anything is new, one
issue (label "fork-watch") is opened with the findings, so it arrives as a
GitHub notification. Nothing is merged or pushed - porting stays a decision.

Forks of forks are followed too, to any depth: the forks API only lists
direct forks, so the tree is walked from each root.

A commit is reported once. The state - the time of the last run and the
commits already reported, with their dates - is kept as hidden markers in
one closed issue, "Fork watch state", so no branch or file has to be
committed for it. Because of that memory, a commit is reported even when it
was made days before it was pushed (anything up to LOOKBACK_DAYS old), not
only when its date falls after the last run.
Commits that NicholasBly's main already has are left out: the Sync upstream
workflow brings those in, and so are commits whose title is already one of
our main's: our own work that a fork took in again under another sha
(squash-merged pull requests, a rebase), and commits made by this
repository's owner: our own branch commits that a fork took in before we
squash-merged them under another title. Bot commits (dependabot and the
like) are skipped.

Environment: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/name), optional
ROOT_REPOS (comma separated), FIRST_RUN_DAYS, MAX_BRANCHES, DRY_RUN=1.
"""

import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = 'https://api.github.com'
TOKEN = os.environ.get('GITHUB_TOKEN', '')
REPO = os.environ.get('GITHUB_REPOSITORY', 'foxi69/youtube-webos')
ROOTS = [r.strip() for r in os.environ.get(
    'ROOT_REPOS', 'NicholasBly/youtube-webos,webosbrew/youtube-webos,FriedChickenButt/youtube-webos').split(',') if r.strip()]
FIRST_RUN_DAYS = int(os.environ.get('FIRST_RUN_DAYS', '7'))
MAX_BRANCHES = int(os.environ.get('MAX_BRANCHES', '100'))
LOOKBACK_DAYS = int(os.environ.get('LOOKBACK_DAYS', '30'))
# Reported commits are remembered this long, then forgotten to keep the
# state small; anything older than LOOKBACK_DAYS is never reported anyway.
KNOWN_KEEP_DAYS = LOOKBACK_DAYS + 15
MAX_FORK_DEPTH = 6
MAX_COMMITS_SHOWN = 15
MAX_MAIN_TITLES = 1000
# A compare lists up to 250 commits unless it is paged; past that many, the
# newest - the ones that matter - would be cut. Paged, the newest this many
# are read (a compare lists the oldest first).
MAX_COMPARE_COMMITS = 1000
# GitHub refuses an issue body over 65,536 characters: the report is cut
# below it, and the state keeps at most this many commits (about 30
# characters each).
MAX_BODY = 60000
MAX_KNOWN = 1800
RETRY_DELAY_S = 5
DRY_RUN = os.environ.get('DRY_RUN') == '1'
LABEL = 'fork-watch'
STATE_TITLE = 'Fork watch state'
MARKER_RE = re.compile(r'<!-- fork-watch-last-run: (\S+) -->')
KNOWN_RE = re.compile(r'<!-- fork-watch-known: (\{.*?\}) -->', re.S)
RETRY_RE = re.compile(r'<!-- fork-watch-retry: (\[.*?\]) -->', re.S)
# Forks with a branch GitHub could not compare in this run: read again in the
# next one, pushed since or not, as the last-run marker moves past them.
FAILED = set()


def request(method, path, body=None, params=None):
    url = path if path.startswith('http') else API + path
    if params:
        url += ('&' if '?' in url else '?') + urllib.parse.urlencode(params)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Accept', 'application/vnd.github+json')
    req.add_header('X-GitHub-Api-Version', '2022-11-28')
    if TOKEN:
        req.add_header('Authorization', 'Bearer ' + TOKEN)
    if data is not None:
        req.add_header('Content-Type', 'application/json')
    # A read that meets a server or network error (a compare that took too
    # long, a hiccup) is asked again twice before it fails. Writes are not: a
    # write that failed may still have been made.
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                text = res.read().decode()
                link = res.headers.get('Link', '')
                return (json.loads(text) if text else None), link
        except urllib.error.HTTPError as err:
            # 404 (deleted fork/branch), 409 (empty repo), 410 (issues turned
            # off) and 422 (unrelated histories) are normal in a fork network:
            # skip, don't fail the run. Reads only: a write that fails (the
            # report issue, the state) must stop the run, or the state moves on
            # and the findings are never reported.
            if method == 'GET' and err.code in (404, 409, 410, 422):
                return None, ''
            if method != 'GET' or err.code < 500 or attempt == 2:
                raise
        except (urllib.error.URLError, TimeoutError):
            if method != 'GET' or attempt == 2:
                raise
        time.sleep(RETRY_DELAY_S * (attempt + 1))


def get(path, params=None):
    return request('GET', path, params=params)[0]


def get_all(path, params=None, limit=1000, until=None):
    """Follows Link: rel="next" pagination; stops after a page whose last item `until` accepts."""
    out = []
    params = dict(params or {}, per_page=100)
    data, link = request('GET', path, params=params)
    while True:
        if not data:
            break
        out.extend(data)
        if len(out) >= limit or (until and until(data[-1])):
            break
        m = re.search(r'<([^>]+)>;\s*rel="next"', link or '')
        if not m:
            break
        data, link = request('GET', m.group(1))
    return out[:limit]


def parse_time(value):
    return dt.datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc)


def fmt_time(value):
    return value.strftime('%Y-%m-%dT%H:%M:%SZ')


def state_issue():
    # Oldest first, page by page until it turns up: the state issue is
    # opened on the first run, but one opened again (the first deleted) comes
    # after every report so far.
    data, link = request('GET', f'/repos/{REPO}/issues',
                         params={'labels': LABEL, 'state': 'all', 'sort': 'created', 'direction': 'asc', 'per_page': 100})
    while data:
        for issue in data:
            if issue.get('title') == STATE_TITLE and 'pull_request' not in issue:
                return issue
        m = re.search(r'<([^>]+)>;\s*rel="next"', link or '')
        if not m:
            break
        data, link = request('GET', m.group(1))
    return None


def last_run_time(state):
    m = MARKER_RE.search((state or {}).get('body') or '')
    return parse_time(m.group(1)) if m else None


def known_commits(state):
    """{sha prefix: 'YYYY-MM-DD'} of commits already reported, or None before the first save."""
    m = KNOWN_RE.search((state or {}).get('body') or '')
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except ValueError:
        return None


def compare(head):
    """Our main compared with `head` (owner:branch): the compare, with the
    newest MAX_COMPARE_COMMITS commits ahead (oldest first) in 'commits'."""
    path = f'/repos/{REPO}/compare/main...{head}'
    cmp = get(path, {'per_page': 100})
    if not cmp:
        return cmp
    last = -(-(cmp.get('total_commits') or 0) // 100)
    # Past the cap, the first pages hold the oldest: they are left out. One
    # page more than the cap holds, as the last one is seldom full.
    first = max(1, last - MAX_COMPARE_COMMITS // 100)
    commits = list(cmp.get('commits') or []) if first == 1 else []
    for page in range(max(first, 2), last + 1):
        more = get(path, {'per_page': 100, 'page': page})
        if not more or not more.get('commits'):
            break
        commits.extend(more['commits'])
    cmp['commits'] = commits[-MAX_COMPARE_COMMITS:]
    return cmp


def upstream_shas():
    """Commits upstream main has and we don't: the sync workflow's job, not news."""
    cmp = compare(f"{ROOTS[0].split('/')[0]}:main")
    return {c['sha'] for c in (cmp or {}).get('commits', [])}, (cmp or {}).get('ahead_by', 0)


def main_titles():
    """First lines of our main's latest commits, to know our own work again in a fork."""
    commits = get_all(f'/repos/{REPO}/commits', {'sha': 'main'}, limit=MAX_MAIN_TITLES)
    return {c['commit']['message'].splitlines()[0] for c in commits if c['commit']['message']}


def retry_forks(state):
    """The forks the last run could not read in full."""
    m = RETRY_RE.search((state or {}).get('body') or '')
    try:
        return set(json.loads(m.group(1))) if m else set()
    except ValueError:
        return set()


def watched_forks(since, retry=frozenset()):
    """Every repository in the roots' fork trees (roots included) pushed after
    `since`, and the ones in `retry` whenever they were pushed."""
    seen = {}
    queue = []
    for root in ROOTS:
        info = get(f'/repos/{root}')
        if info and info['full_name'] not in seen:
            seen[info['full_name']] = info
            queue.append((info, 0))
    # Breadth-first through forks of forks; forks_count says whether a
    # repository has any, so leaves cost no request.
    while queue:
        repo, depth = queue.pop(0)
        if depth >= MAX_FORK_DEPTH or not repo.get('forks_count'):
            continue
        for fork in get_all(f"/repos/{repo['full_name']}/forks", {'sort': 'newest'}, limit=3000):
            if fork['full_name'] in seen:
                continue
            seen[fork['full_name']] = fork
            queue.append((fork, depth + 1))
    me = REPO.lower()
    out = []
    for name, info in seen.items():
        if name.lower() == me or not info.get('pushed_at'):
            continue
        if parse_time(info['pushed_at']) > since or name in retry:
            out.append(info)
    out.sort(key=lambda f: f['pushed_at'], reverse=True)
    return out


OWNER = REPO.split('/')[0].lower()


def is_ours(commit):
    """Made by this repository's owner, so already known here."""
    login = ((commit.get('author') or {}).get('login') or '').lower()
    return login == OWNER


def is_bot(commit):
    login = (commit.get('author') or {}).get('login') or ''
    return login.endswith('[bot]') or commit['commit']['author']['name'].endswith('[bot]')


def new_commits(fork, cutoff, seen, known, today, ours):
    """Commits on the fork's branches that are not in our main, newer than `cutoff`
    and not reported before. `seen` holds shas handled in this run (upstream's
    included), shared across forks; `known` holds earlier runs' reports; `ours`
    holds our main's commit titles."""
    owner = fork['owner']['login']
    branches = get_all(f"/repos/{fork['full_name']}/branches", limit=MAX_BRANCHES)
    found = {}
    for branch in branches or []:
        head = f"{owner}:{urllib.parse.quote(branch['name'], safe='')}"
        try:
            cmp = compare(head)
        except urllib.error.HTTPError as err:
            if err.code < 500:
                raise
            # One branch GitHub cannot compare must not stop the whole watch
            # (every later run would fail on it too).
            print(f"{fork['full_name']} {branch['name']}: compare failed ({err.code}), skipped")
            FAILED.add(fork['full_name'])
            continue
        if not cmp or not cmp.get('ahead_by'):
            continue
        for c in cmp.get('commits', []):
            if len(c.get('parents', [])) > 1:
                continue  # merge commits carry no change of their own
            when = parse_time(c['commit']['committer']['date'])
            if when <= cutoff or c['sha'] in seen or c['sha'][:12] in known or is_bot(c) or is_ours(c):
                continue
            seen.add(c['sha'])
            title = c['commit']['message'].splitlines()[0] if c['commit']['message'] else ''
            if title in ours:
                continue
            known[c['sha'][:12]] = today
            found[c['sha']] = {
                'sha': c['sha'],
                'branch': branch['name'],
                'title': title[:120],
                'author': (c.get('author') or {}).get('login') or c['commit']['author']['name'],
                'date': c['commit']['committer']['date'][:10],
                # The fork's page of the commit: ours would say it belongs to
                # no branch of this repository.
                'url': f"{fork['html_url']}/commit/{c['sha']}",
            }
    return sorted(found.values(), key=lambda c: c['date'], reverse=True)


def new_pull_requests(since):
    out = []
    for root in ROOTS:
        # Paged back to `since`, not cut at 100: closed ones skipped below must
        # not hide an older update behind them.
        pulls = get_all(f'/repos/{root}/pulls', {'state': 'all', 'sort': 'updated', 'direction': 'desc'},
                        until=lambda pr: parse_time(pr['updated_at']) <= since)
        for pr in pulls or []:
            if parse_time(pr['updated_at']) <= since:
                break  # sorted by update time
            if pr['state'] == 'closed' and not pr.get('merged_at'):
                continue  # closed without merging: nothing to port
            state = 'merged' if pr.get('merged_at') else pr['state']
            out.append({'repo': root, 'number': pr['number'], 'title': pr['title'],
                        'user': pr['user']['login'], 'state': state, 'url': pr['html_url'],
                        'updated': pr['updated_at'][:10]})
    return out


def new_issues(since):
    """Issues opened on the roots after `since` that are still open."""
    out = []
    for root in ROOTS:
        issues = get_all(f'/repos/{root}/issues', {'state': 'open', 'sort': 'created', 'direction': 'desc'},
                         until=lambda issue: parse_time(issue['created_at']) <= since)
        for issue in issues or []:
            if parse_time(issue['created_at']) <= since:
                break  # sorted by creation time
            if 'pull_request' in issue:
                continue  # the issues API lists pull requests too
            out.append({'repo': root, 'number': issue['number'], 'title': issue['title'],
                        'user': issue['user']['login'], 'url': issue['html_url'],
                        'labels': ', '.join(l['name'] for l in issue.get('labels', [])),
                        'created': issue['created_at'][:10]})
    return out


def esc(text):
    """Text from other people's repositories, made safe for the report: no
    table cell break, no HTML, no link brackets or code spans broken, and no
    @mention (it would notify that user) or #123 reference (it would link to
    our own issue of that number, and put the report on its timeline)."""
    text = text.replace('\\', '\\\\')
    for ch in '|[]`':
        text = text.replace(ch, '\\' + ch)
    text = text.replace('<', '&lt;')
    # GH-123 is a reference too, and so is an issue's github.com address.
    text = re.sub(r'\b(GH)-(?=\d)', r'\1&#8203;-', text, flags=re.I)
    text = re.sub(r'https?://github\.com/', 'https://redirect.github.com/', text, flags=re.I)
    return re.sub(r'([@#])(?=\w)', r'\1&#8203;', text)


def code(text):
    """`text` as a code span, whatever backticks it holds."""
    fence = '`' * (max((len(m) for m in re.findall('`+', text)), default=0) + 1)
    pad = ' ' if text.startswith('`') or text.endswith('`') else ''
    return f'{fence}{pad}{text}{pad}{fence}'


def quiet(url):
    """A link to a pull request or an issue elsewhere that leaves no "mentioned
    this" entry on its timeline, as Dependabot's do: through redirect.github.com."""
    return re.sub(r'^https://github\.com/', 'https://redirect.github.com/', url)


def cut(body, limit=MAX_BODY):
    """`body` cut at a line under `limit` characters, saying so."""
    if len(body) <= limit:
        return body
    note = '\n\n... cut here: the report is too long for one issue. The run\'s summary has all of it.\n'
    end = body.rfind('\n', 0, limit - len(note))
    return body[:max(end, 0)] + note


def build_report(since, forks, pulls, issues, upstream_ahead):
    lines = [f'New work in the youtube-webos fork network since {fmt_time(since)}.',
             '', 'These are suggestions only - nothing has been merged. '
             'Pick what is worth porting and ask for it (or cherry-pick it).', '']
    if upstream_ahead:
        lines += [f'**Upstream ({ROOTS[0]})** is {upstream_ahead} commit(s) ahead of main - '
                  'the Sync upstream workflow opens a pull request for those.', '']
    if pulls:
        lines += ['## Pull requests on the upstream repositories', '',
                  '| Repo | PR | Author | State | Updated |', '|---|---|---|---|---|']
        for p in pulls:
            lines.append(f"| {p['repo']} | [#{p['number']} {esc(p['title'])}]({quiet(p['url'])}) "
                         f"| {esc(p['user'])} | {p['state']} | {p['updated']} |")
        lines.append('')
    if issues:
        lines += ['## New issues on the upstream repositories', '',
                  '| Repo | Issue | Author | Labels | Opened |', '|---|---|---|---|---|']
        for i in issues:
            lines.append(f"| {i['repo']} | [#{i['number']} {esc(i['title'])}]({quiet(i['url'])}) "
                         f"| {esc(i['user'])} | {esc(i['labels'])} | {i['created']} |")
        lines.append('')
    if forks:
        lines += ['## New commits on forks', '']
        for fork, commits in forks:
            lines.append(f"### [{fork['full_name']}]({fork['html_url']}) - {len(commits)} new commit(s)")
            lines.append('')
            for c in commits[:MAX_COMMITS_SHOWN]:
                lines.append(f"- [`{c['sha'][:7]}`]({c['url']}) {esc(c['title'])} "
                             f"- {esc(c['author'])}, {c['date']}, branch {code(c['branch'])}")
            if len(commits) > MAX_COMMITS_SHOWN:
                lines.append(f'- ... and {len(commits) - MAX_COMMITS_SHOWN} more')
            lines.append('')
    return '\n'.join(lines)


def ensure_label():
    if DRY_RUN or get(f'/repos/{REPO}/labels/{LABEL}'):
        return
    request('POST', f'/repos/{REPO}/labels',
            {'name': LABEL, 'color': '0e8a16', 'description': 'New work in the fork network'})


def save_state(now, state, known, retry=()):
    """Moves the last-run marker forward and stores the reported commits in the (closed) state issue."""
    oldest = (now - dt.timedelta(days=KNOWN_KEEP_DAYS)).strftime('%Y-%m-%d')
    kept = {sha: day for sha, day in known.items() if day >= oldest}
    if len(kept) > MAX_KNOWN:
        # The newest are kept: an older one forgotten can come back only
        # while it is still under LOOKBACK_DAYS.
        kept = dict(sorted(kept.items(), key=lambda kv: kv[1], reverse=True)[:MAX_KNOWN])
    body = ('Bookkeeping for the fork watch workflow - safe to ignore.\n\n'
            f'<!-- fork-watch-last-run: {fmt_time(now)} -->\n'
            f'<!-- fork-watch-known: {json.dumps(kept, separators=(",", ":"), sort_keys=True)} -->\n'
            f'<!-- fork-watch-retry: {json.dumps(sorted(retry))} -->')
    if DRY_RUN:
        print('[dry run] state ->', fmt_time(now))
        return
    if state:
        request('PATCH', f"/repos/{REPO}/issues/{state['number']}", {'body': body})
        return
    created, _ = request('POST', f'/repos/{REPO}/issues',
                         {'title': STATE_TITLE, 'body': body, 'labels': [LABEL]})
    if created:
        request('PATCH', f"/repos/{REPO}/issues/{created['number']}", {'state': 'closed'})


def main():
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    state = state_issue()
    since = last_run_time(state)
    if since is None:
        since = now - dt.timedelta(days=FIRST_RUN_DAYS)
    known = known_commits(state)
    if known is None:
        # No memory yet (first run, or a state written before it existed):
        # fall back to "newer than the last run" so nothing already reported
        # comes back; the memory starts with this run.
        known = {}
        cutoff = since
    else:
        cutoff = now - dt.timedelta(days=LOOKBACK_DAYS)
    today = now.strftime('%Y-%m-%d')
    print(f'Looking for work pushed since {fmt_time(since)} in the fork trees of {", ".join(ROOTS)}')

    ensure_label()
    seen, upstream_ahead = upstream_shas()
    ours = main_titles()
    forks = []
    for fork in watched_forks(since, retry_forks(state)):
        commits = new_commits(fork, cutoff, seen, known, today, ours)
        print(f"{fork['full_name']}: {len(commits)} new commit(s)")
        if commits:
            forks.append((fork, commits))
    pulls = new_pull_requests(since)
    print(f'{len(pulls)} pull request(s) updated')
    issues = new_issues(since)
    print(f'{len(issues)} new open issue(s)')

    if not forks and not pulls and not issues:
        print('Nothing new.')
        save_state(now, state, known, FAILED)
        return

    title = f"Fork watch {now.strftime('%Y-%m-%d')}: {sum(len(c) for _, c in forks)} commit(s) on {len(forks)} fork(s), {len(pulls)} PR(s), {len(issues)} issue(s)"
    body = build_report(since, forks, pulls, issues, upstream_ahead)
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as f:
            f.write(f'# {title}\n\n{body}\n')
    if DRY_RUN:
        print(title)
        print(body)
        return
    request('POST', f'/repos/{REPO}/issues', {'title': title, 'body': cut(body), 'labels': [LABEL]})
    print('Opened issue:', title)
    save_state(now, state, known, FAILED)


if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as err:
        print(f'GitHub API error {err.code}: {err.read().decode()[:500]}', file=sys.stderr)
        sys.exit(1)
