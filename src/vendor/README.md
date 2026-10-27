# Third-party code

Code written outside this project, kept as its authors wrote it so it can be
compared with (and updated from) the original. Changes made here are marked
`[ytaf]` in the files.

| Folder | What | From | License |
| --- | --- | --- | --- |
| `dearrow/` | DeArrow's title formatter (Title Case, Sentence case, emoji and fancy-text cleanup) | [ajayyy/DeArrow](https://github.com/ajayyy/DeArrow) `src/titles/titleFormatter.ts` @ 482cf997, types stripped; vendored by @magicsk in NicholasBly/youtube-webos#200 | GPL-3.0 |

Used by `src/dearrow/formatter.js`, in the webOS 22+ build only
(`webpack.config.js` swaps in `src/dearrow/formatter-absent.js` for the
legacy one).
