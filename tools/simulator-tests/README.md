# Testing the app in the webOS TV Simulators

The `bench/` tests run our code in JSDOM against sample data. These scripts run
the built app in LG's webOS TV Simulators, one for each webOS version, on
today's real YouTube. They check:

- the app starts;
- the settings panel works;
- a video plays;
- the features reach their services;
- each setting does what it should, on YouTube's real responses too.

They do not run in CI: they need the simulators, a signed-in YouTube account
and about 6 minutes per version. Run them by hand when a change could behave
differently on older webOS versions.

Windows only, as written (`.exe` simulators, `taskkill`). Node 22+ (its
built-in `WebSocket`). The commands below are for Git Bash or another POSIX
shell: `LOGO=premium node ...` sets the variable for that one command. In
PowerShell, set it first (`$env:LOGO = 'premium'`), then run `node ...`.

## Setup, once

1. **webOS TV CLI** (`ares-*`): <https://webostv.developer.lge.com/develop/tools/cli-installation>.
   It is needed only for the real TV scripts.
2. **The simulators.** Download them from
   <https://webostv.developer.lge.com/develop/tools/simulator-installation>.
   Accept LG's SDK license there yourself; it is why there is no download
   script here.
   - Unzip each one into `<SDK>\Simulator\`, for example
     `D:\webOS_TV_SDK\Simulator\webOS_TV_23_Simulator_1.4.1\webOS_TV_23_Simulator_1.4.1.exe`.
   - `run-all.cjs` finds them by their folder name `webOS_TV_<version>_Simulator*`.
3. **Sign in to YouTube in each simulator.** After a few automated starts,
   YouTube takes a signed-out simulator for a robot and stops playing videos
   for the guest. Use a secondary Google account: it stays signed in inside
   the simulator's profile.
   1. Start the simulator: `STOP_AFTER_WATCH=1 node tools/simulator-tests/run-app-test.cjs <simulator .exe> dist`.
   2. Run `node tools/simulator-tests/sign-in.cjs`. It goes to the sign-in
      screen and prints its text with the code. The QR code in the window
      does the same thing. It finds "Add account" in an English or Hungarian
      UI; in another language it says what to press.
   3. Enter the code at <https://yt.be/activate>.
   4. Pick the account in the simulator. The tests then take the first
      account tile on "Who's watching".

## Running

Build the variant you want to test into its own folder: each test gets an app
folder (`appinfo.json` + `webOSUserScripts/userScript.js`).

```sh
npm run build          && cp -r dist dist-legacy   # legacy build (webOS 3 and newer)
npm run build:modern   && cp -r dist dist-modern   # webOS 22+ build
```

All versions, both builds, with every check. The webOS 22+ build is skipped on
webOS 6.0: it keeps `?.` and `??`, which Chromium 79 cannot run.

```sh
LOGO=premium FEATURES=1 EFFECTS=1 node tools/simulator-tests/run-all.cjs --sdk D:/webOS_TV_SDK dist-legacy dist-modern
```

One simulator:

```sh
LOGO=premium FEATURES=1 EFFECTS=1 node tools/simulator-tests/run-app-test.cjs D:/webOS_TV_SDK/Simulator/webOS_TV_23_Simulator_1.4.1/webOS_TV_23_Simulator_1.4.1.exe dist-modern
```

Each run writes its screenshots and JSON results to `simulator-results/`
(git-ignored): `<label>-results.json`, `-effects.json`, `-sweep.json`. Lines
read `PASS`/`FAIL <check> (detail)`, and the run ends with `<label>: n/m passed`.
`run-all.cjs` prints a summary table at the end.

### What the switches do

The switches are environment variables, all optional:

| Variable | What it does |
| --- | --- |
| `LOGO=premium` | Sets the YouTube Logo setting. The run checks that the wordmark shows, and that it holds when YouTube repaints the header (#214). |
| `FEATURES=1` | Turns on the optional watch-page features: Return YouTube Dislike, DeArrow, Most Replayed, time remaining, clock, quality tag. The run checks that they reach their services and draw. |
| `EFFECTS=1` | Checks that each setting does what it should (see below). |
| `SWEEP=1` | Presses every control in the panel through all its values. Each must change the stored setting, come back and throw nothing. |
| `TV_LIKE=0` | Keeps the simulator's own user agent. By default the run looks like a TV: the TV's agent, 1920×1080 and a slower CPU. |
| `TV_CPU=<n>` | Uses another CPU slow-down than the year's (4–6×). |
| `BLOCK_VIDEO=1` | Loads no video data, so only the UI checks run. |
| `STOP_AFTER_WATCH=1` | Leaves the simulator open on the playing video. Use it for `sign-in.cjs`, `watched-check.cjs` or `cdp.cjs`. |
| `PORT`, `OUT`, `LABEL` | DevTools port (9229), results folder, run name. |

### What `EFFECTS=1` checks

1. **Sample cases** (`effects-page.js`). Each setting is switched off, then on,
   through the panel's own control, the way a user does it. A sample response
   then goes through YouTube's `JSON.parse`. The effect must be there when the
   setting is on and absent when it is off. The cases cover:
   - ads;
   - end screens;
   - tracking;
   - the Shorts tab;
   - live, watched and short videos;
   - blocked channels and words;
   - the search filter.
2. **Real data.** During the run, a counter keeps up to 60 of YouTube's real
   responses. Each feed filter is replayed on them off, then on:
   - ads, tracking and end cards;
   - Shorts, live, upcoming and members-only videos;
   - watched videos and videos under 5 minutes;
   - AI videos (the ones the AI check learned);
   - the feed's most frequent channel and title word, as Blocked Channels
     and Keywords.

   The verdict is `works`, or that this kind of item was not in the data at
   all.
3. **Every other setting.** One press each. The log shows what changed on
   the page: classes, our elements, styles, the playback rate.
4. **Watch-page overlays.** With the panel closed and the player controls up,
   the overlays must show when on and not when off. This covers time
   remaining, Most Replayed, the clock, watch time and the quality tag.

## What the simulator can and cannot tell

These points were learned the hard way. They are why the scripts look the
way they do.

### Things that work around the simulator

- **Injection.** The simulator does not inject `webOSUserScripts` as a TV's
  WAM does. The test registers the bundle with
  `Page.addScriptToEvaluateOnNewDocument`, guarded to run once per YouTube
  document at `DOMContentLoaded`.
  - Earlier than that, YouTube rewrites `<html>`, and our classes and
    stylesheets are lost.
  - `Page.reload` closes the app in the simulator, so the document that is
    already open gets the bundle directly.
- **webOS 22+ (site isolation).** When the start page goes to YouTube, a new
  DevTools target appears. Always look for the target with the youtube.com
  URL (`cdp.cjs youtubePage`).
- **The webOS version.** The simulators' user agent has no
  `webOS.TV-<year>`, only the Chromium of their version. `webos-utils.js`
  then takes every Chromium 54–119 for webOS 6.
  - The test gives the page a TV's agent (`TV_LIKE`, the default), or with
    `TV_LIKE=0` adds the year to the simulator's own agent.
  - This is a test-side fix only: real TVs send the year.
- **Keys.**
  - YouTube's welcome and account screens take in-page `KeyboardEvent`s with
    `keyCode` set (`PAGE_KEY`), as `utils.js` `sendKey` does.
  - The player controls only come up for real DevTools key presses
    (`Input.dispatchKeyEvent`).
  - Pointer clicks do nothing in the TV UI.
- **The settings are written 200 ms after a change** (`config.js`
  `scheduleWrite`). `effects-page.js` `set()` waits before reading back.
- **The on-screen keyboard.** It comes up when a text box in the panel gets
  the focus, and stays up. `set()` skips that focus. If the keyboard is still
  up, Back closes it.
- **Leftovers from earlier runs.** Settings persist in the simulator's
  profile, so every run starts from the defaults (`ytaf-configuration*`
  removed, no update check, no What's New).

### Known limits

- **webOS 6.0 crashes on its own.** Its renderer (Chromium 79) crashes on
  today's YouTube now and then, without our code too (`crash-check.cjs`
  shows it).
  - With the TV-like agent and CPU slow-down it crashes nearly every time,
    so `run-all.cjs` runs 6.0 with `TV_LIKE=0` and starts again on a crash
    (exit 3, up to 5 attempts).
  - Several restarts in a short time can also bring up YouTube's own
    "Something went wrong, try again" page.
- **webOS 25 and 26** (simulators 1.4.4 / 1.5.0) do not bring the app to the
  front when started this way. They are left out of the default
  `--versions`. Test those on a TV.
- **No hardware video layer.** Things that depend on the TV's video plane,
  such as black previews (#67), do not show in the simulator.
- **Real data depends on the account.** A filter whose kind of item is not
  in this run's responses reports so; it is not a failure.

## On a real TV

`ares-inspect -d <device> youtube.leanback.v4` opens the app's inspector and
prints a localhost port that speaks the same DevTools protocol. These scripts
work with that port:

- `node cdp.cjs <port> eval <expression>` looks at the page;
- `node cdp.cjs <port> key <Key>` presses a key;
- `node tv-logo.cjs <port>` checks that the Premium wordmark holds after a
  header repaint and after switching apps and back (#214).

## Files

| File | What it is |
| --- | --- |
| `run-app-test.cjs` | The full test on one simulator. |
| `run-all.cjs` | Every simulator × every build, retries on crashes, a summary. |
| `effects-page.js` | The in-page part: settings through the panel, sample cases, real-data replay, overlays. |
| `cdp.cjs` | DevTools client, shared helpers, and a small CLI (`list`, `eval`, `key`). |
| `sign-in.cjs` | Takes a simulator to YouTube's sign-in screen. |
| `watched-check.cjs` | Hide Watched Videos on the real History. Run it with `STOP_AFTER_WATCH=1` and a signed-in account. |
| `crash-check.cjs` | Tells whether a crash is ours: the app with and without our bundle. |
| `tv-logo.cjs` | The YouTube Logo check on a real TV. |
