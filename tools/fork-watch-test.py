#!/usr/bin/env python3
"""
Tests for tools/fork-watch.py, with GitHub's API faked: no network, no token.

Usage: python3 tools/fork-watch-test.py
"""

import datetime as dt
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.pop('DRY_RUN', None)
# main() appends the whole report to the job summary. In CI that is the real
# one, and this test's 400-fork report (~1.3 MB) went past its 1 MB limit
# twice a run (Test and Coverage): it goes to a file of our own, checked below.
SUMMARY_DIR = tempfile.mkdtemp(prefix='fork-watch-test-')
SUMMARY = os.path.join(SUMMARY_DIR, 'summary.md')
os.environ['GITHUB_STEP_SUMMARY'] = SUMMARY
os.environ['GITHUB_REPOSITORY'] = 'me/youtube-webos'
os.environ['ROOT_REPOS'] = 'up/youtube-webos'
spec = importlib.util.spec_from_file_location('fork_watch', os.path.join(HERE, 'fork-watch.py'))
fw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fw)
fw.time.sleep = lambda s: None

failures = 0


def check(name, ok, detail=''):
    global failures
    print(('PASS ' if ok else 'FAIL ') + name)
    if not ok:
        failures += 1
        print('  ' + str(detail))


NOW = dt.datetime(2026, 11, 11, 12, 0, 0, tzinfo=dt.timezone.utc)


def commit(sha, title, day='2026-11-11', login='someone'):
    return {'sha': sha, 'parents': [{}], 'author': {'login': login},
            'html_url': f'https://github.com/me/youtube-webos/commit/{sha}',
            'commit': {'message': title, 'author': {'name': login},
                       'committer': {'date': f'{day}T10:00:00Z'}}}


FORK = {'full_name': 'dev/youtube-webos', 'html_url': 'https://github.com/dev/youtube-webos',
        'owner': {'login': 'dev'}, 'pushed_at': '2026-11-11T10:00:00Z'}


class Api:
    """Answers request() from a table of path -> answer (or a function of params)."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, method, path, body=None, params=None):
        self.calls.append((method, path, body, params))
        key = path.split('?')[0]
        answer = self.routes.get((method, key), self.routes.get(key))
        if callable(answer):
            answer = answer(params or {})
        if isinstance(answer, Exception):
            raise answer
        return answer, ''


def http_error(code):
    return urllib.error.HTTPError('https://api.github.com/x', code, 'error', {}, io.BytesIO(b'{}'))


# --- esc(): nothing in a fork's text pings anyone or links to our issues ---
out = fw.esc('Fix #12 for @someone | see [docs] `code` <b>')
check('esc: no @mention left', '@someone' not in out, out)
check('esc: no #12 reference left', '#12' not in out, out)
check('esc: table cell, brackets, backticks and HTML escaped',
      '\\|' in out and '\\[docs\\]' in out and '\\`code\\`' in out and '&lt;b>' in out, out)
check('esc: a lone # is left as it is', fw.esc('a # b') == 'a # b', fw.esc('a # b'))
out = fw.esc('Fix GH-123 and gh-7, see https://github.com/up/youtube-webos/issues/9')
check('esc: no GH-123 reference left', 'GH-123' not in out and 'gh-7' not in out, out)
check('esc: GH-123 gets one invisible separator, nothing else',
      fw.esc('Fix GH-123') == 'Fix GH&#8203;-123', fw.esc('Fix GH-123'))
check('esc: #12 and @bob get one separator each',
      fw.esc('#12 @bob') == '#&#8203;12 @&#8203;bob', fw.esc('#12 @bob'))
check('esc: an issue address in a title goes through redirect.github.com',
      'https://github.com/' not in out and 'https://redirect.github.com/up/youtube-webos/issues/9' in out, out)
check('code: a branch with a backtick stays one code span', fw.code('a`b') == '``a`b``', fw.code('a`b'))

# --- the report: upstream pull requests and issues linked without a backlink ---
pulls = [{'repo': 'up/youtube-webos', 'number': 5, 'title': 'Thanks @bob, fixes #3', 'user': 'bob',
          'state': 'open', 'url': 'https://github.com/up/youtube-webos/pull/5', 'updated': '2026-11-11'}]
issues = [{'repo': 'up/youtube-webos', 'number': 6, 'title': 'Bug', 'user': 'eve', 'labels': '',
           'url': 'https://github.com/up/youtube-webos/issues/6', 'created': '2026-11-11'}]
report = fw.build_report(NOW, [], pulls, issues, 0)
check('report: pull request linked through redirect.github.com',
      '(https://redirect.github.com/up/youtube-webos/pull/5)' in report, report)
check('report: issue linked through redirect.github.com',
      '(https://redirect.github.com/up/youtube-webos/issues/6)' in report, report)
check('report: no github.com issue or pull request link left',
      'https://github.com/up/youtube-webos/pull' not in report and
      'https://github.com/up/youtube-webos/issues' not in report, report)
check('report: a title\'s @mention and #3 are neutralised', '@bob' not in report and '#3' not in report, report)

# --- compare(): a branch over 100 commits ahead is read to its newest commit ---
def paged(n):
    many = [commit(f'{i:040x}', f'Commit {i}') for i in range(n)]

    def answer(params):
        page = params.get('page', 1)
        per = params.get('per_page', 250)
        return {'ahead_by': n, 'total_commits': n, 'commits': many[(page - 1) * per:page * per]}
    return many, answer


many, answer = paged(260)
fw.request = Api({'/repos/me/youtube-webos/compare/main...dev:long': answer})
cmp = fw.compare('dev:long')
check('compare: every commit of a 260-commit branch', len(cmp['commits']) == 260, len(cmp['commits']))
check('compare: the newest commit is there', cmp['commits'][-1]['sha'] == many[-1]['sha'])

# Over the cap: the newest are read, not the oldest (a compare lists the oldest first).
many, answer = paged(1150)
fw.request = Api({'/repos/me/youtube-webos/compare/main...dev:huge': answer})
cmp = fw.compare('dev:huge')
got = [c['commit']['message'] for c in cmp['commits']]
check('compare: over the cap, exactly the newest MAX_COMPARE_COMMITS, in order',
      got == [c['commit']['message'] for c in many[-fw.MAX_COMPARE_COMMITS:]],
      f'{len(got)} commits: {got[:1]} .. {got[-1:]}')
# Two pages short of whole: still all of the newest.
many, answer = paged(1201)
fw.request = Api({'/repos/me/youtube-webos/compare/main...dev:huge': answer})
got = [c['commit']['message'] for c in fw.compare('dev:huge')['commits']]
check('compare: 1,201 commits, the newest 1,000', got == [c['commit']['message'] for c in many[-1000:]],
      f'{len(got)} commits: {got[:1]} .. {got[-1:]}')

# --- new_commits(): one branch GitHub cannot compare does not stop the others ---
api = Api({
    '/repos/dev/youtube-webos/branches': [{'name': 'broken'}, {'name': 'good'}],
    '/repos/me/youtube-webos/compare/main...dev:broken': http_error(502),
    '/repos/me/youtube-webos/compare/main...dev:good':
        {'ahead_by': 1, 'total_commits': 1, 'commits': [commit('a' * 40, 'New feature')]},
})
fw.request = api
try:
    found = fw.new_commits(FORK, NOW - dt.timedelta(days=30), set(), {}, '2026-11-11', set())
    check('new_commits: a 502 on one branch skips it', [c['title'] for c in found] == ['New feature'], found)
    check('new_commits: the commit links to the fork',
          found and found[0]['url'] == 'https://github.com/dev/youtube-webos/commit/' + 'a' * 40, found)
except urllib.error.HTTPError as err:
    check('new_commits: a 502 on one branch skips it', False, f'raised {err.code}')

# --- a fork that could not be read in full is read again in the next run ---
check('new_commits: the fork with the failed compare is kept for a retry', fw.FAILED == {'dev/youtube-webos'}, fw.FAILED)
api = Api({('PATCH', '/repos/me/youtube-webos/issues/1'): {}})
fw.request = api
fw.save_state(NOW, {'number': 1}, {}, fw.FAILED)
retry = fw.retry_forks({'body': api.calls[-1][2]['body']})
check('save_state: the retry list is stored and read back', retry == {'dev/youtube-webos'}, retry)
check('retry_forks: none before the first save', fw.retry_forks({'body': 'old state'}) == set())
fw.request = Api({
    '/repos/up/youtube-webos': {'full_name': 'up/youtube-webos', 'forks_count': 2, 'pushed_at': None},
    '/repos/up/youtube-webos/forks': [FORK, dict(FORK, full_name='new/youtube-webos', owner={'login': 'new'},
                                                 pushed_at='2026-11-11T11:30:00Z')],
})
names = [f['full_name'] for f in fw.watched_forks(NOW - dt.timedelta(hours=1), retry)]
check('watched_forks: a fork to retry is watched though not pushed since',
      sorted(names) == ['dev/youtube-webos', 'new/youtube-webos'], names)
names = [f['full_name'] for f in fw.watched_forks(NOW - dt.timedelta(hours=1))]
check('watched_forks: without a retry, only the forks pushed since', names == ['new/youtube-webos'], names)

# --- request(): reads are asked again on a server error, writes are not ---
real_urlopen = fw.urllib.request.urlopen


class Res:
    def __init__(self, body):
        self.body = body
        self.headers = {}

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def urlopen_failing(times, code=503):
    state = {'n': 0}

    def urlopen(req, timeout=None):
        state['n'] += 1
        if state['n'] <= times:
            raise http_error(code)
        return Res(b'{"ok": true}')
    return urlopen, state


del fw.request  # back to the module's own
spec.loader.exec_module(fw)
fw.time.sleep = lambda s: None
opener, st = urlopen_failing(2)
fw.urllib.request.urlopen = opener
check('request: a GET answered 503 twice, then 200, succeeds', fw.get('/x') == {'ok': True} and st['n'] == 3, st)
opener, st = urlopen_failing(5)
fw.urllib.request.urlopen = opener
try:
    fw.get('/x')
    check('request: a GET that keeps failing raises after 3 tries', False, 'no error')
except urllib.error.HTTPError:
    check('request: a GET that keeps failing raises after 3 tries', st['n'] == 3, st)
opener, st = urlopen_failing(1, 502)
fw.urllib.request.urlopen = opener
try:
    fw.request('POST', '/repos/me/youtube-webos/issues', {'title': 't'})
    check('request: a failed POST is not sent again', False, 'no error')
except urllib.error.HTTPError:
    check('request: a failed POST is not sent again', st['n'] == 1, st)
opener, st = urlopen_failing(1, 404)
fw.urllib.request.urlopen = opener
check('request: a GET 404 is skipped at once', fw.get('/x') is None and st['n'] == 1, st)
fw.urllib.request.urlopen = real_urlopen

# --- cut(): a report over GitHub's body limit is cut, and says so ---
long_body = '\n'.join('- line %05d %s' % (i, 'x' * 80) for i in range(1500))
short = fw.cut(long_body)
check('cut: under the limit', len(short) <= fw.MAX_BODY, len(short))
check('cut: at a line, with a note', short.rstrip().endswith('summary has all of it.') and
      '\n- line' in short, short[-200:])
check('cut: a short body is left alone', fw.cut('abc') == 'abc')

# --- save_state(): the memory stays under the body limit, newest kept ---
api = Api({('PATCH', '/repos/me/youtube-webos/issues/1'): {}})
fw.request = api
known = {f'{i:012x}': (NOW - dt.timedelta(days=i % 40)).strftime('%Y-%m-%d') for i in range(5000)}
fw.save_state(NOW, {'number': 1}, known)
body = api.calls[-1][2]['body']
kept = fw.known_commits({'body': body})
check('save_state: at most MAX_KNOWN commits kept', kept is not None and len(kept) <= fw.MAX_KNOWN,
      kept and len(kept))
check('save_state: the body fits an issue', len(body) < 65536, len(body))
check('save_state: the newest are the ones kept',
      kept and min(kept.values()) >= max(sorted(known.values(), reverse=True)[fw.MAX_KNOWN - 1:][:1]),
      kept and min(kept.values()))

# --- main(): the report issue gets the cut body ---
spec.loader.exec_module(fw)
fw.time.sleep = lambda s: None
lots = [commit(f'{i:040x}', 'Feature %d %s' % (i, 'y' * 60)) for i in range(15)]
forks = [dict(FORK, full_name=f'dev{i}/youtube-webos', html_url=f'https://github.com/dev{i}/youtube-webos',
              owner={'login': f'dev{i}'}) for i in range(400)]
routes = {
    '/repos/me/youtube-webos/issues': lambda p: [],
    '/repos/me/youtube-webos/labels/fork-watch': {'name': 'fork-watch'},
    '/repos/me/youtube-webos/compare/main...up:main': {'ahead_by': 0, 'total_commits': 0, 'commits': []},
    '/repos/me/youtube-webos/commits': [],
    '/repos/up/youtube-webos': {'full_name': 'up/youtube-webos', 'forks_count': 400, 'pushed_at': None},
    '/repos/up/youtube-webos/forks': forks,
    '/repos/up/youtube-webos/pulls': [],
    '/repos/up/youtube-webos/issues': [],
}
for i in range(400):
    routes[f'/repos/dev{i}/youtube-webos/branches'] = [{'name': 'main'}]
    routes[f'/repos/me/youtube-webos/compare/main...dev{i}:main'] = {
        'ahead_by': 15, 'total_commits': 15,
        'commits': [dict(c, sha=f'{i:04x}{j:04x}'.ljust(40, '0')) for j, c in enumerate(lots)]}
api = Api(routes)


def issues_route(method, path, body=None, params=None):
    if method == 'POST' and path == '/repos/me/youtube-webos/issues':
        api.calls.append((method, path, body, params))
        return {'number': 7}, ''
    return api(method, path, body, params)


fw.request = issues_route
fw.get = lambda path, params=None: issues_route('GET', path, params=params)[0]


class FixedNow(dt.datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW


fw.dt = type('dtmod', (), {'datetime': FixedNow, 'timedelta': dt.timedelta, 'timezone': dt.timezone})
fw.main()
# The state issue is a POST to the same address: only the report counts here.
posts = [c for c in api.calls if c[0] == 'POST' and c[1] == '/repos/me/youtube-webos/issues'
         and c[2]['title'].startswith('Fork watch 2026-11-11:')]
check('main: one report from 400 forks is opened', len(posts) == 1, [c[2].get('title') for c in api.calls if c[2]])
if posts:
    report = posts[0][2]['body']
    check('main: its body fits an issue, cut and saying so',
          len(report) < 65536 and '### [dev0/youtube-webos]' in report and report.rstrip().endswith('summary has all of it.'),
          (len(report), report[-120:]))
    with open(SUMMARY, encoding='utf-8') as f:
        summary = f.read()
    check('main: the run summary has the whole report, past where the issue is cut',
          summary.startswith('# Fork watch 2026-11-11:') and len(summary) > 65536 and
          '### [dev399/youtube-webos]' in summary and '### [dev399/youtube-webos]' not in report and
          'cut here' not in summary,
          (len(summary), summary[:80]))
shutil.rmtree(SUMMARY_DIR, ignore_errors=True)

print(f'\n{failures} failed' if failures else '\nAll passed')
sys.exit(1 if failures else 0)
