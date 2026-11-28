# Third-party code

Code written outside this project, kept as its authors wrote it so it can be
compared with (and updated from) the original. Changes made here are marked
`[ytaf]` in the files.

| Folder | What | From | License |
| --- | --- | --- | --- |
| `dearrow/` | DeArrow's title formatter (Title Case, Sentence case, emoji and fancy-text cleanup) | [ajayyy/DeArrow](https://github.com/ajayyy/DeArrow) `src/titles/titleFormatter.ts` @ 482cf997, types stripped; vendored by @magicsk in NicholasBly/youtube-webos#200 | GPL-3.0 |
| `bolli/` | DeArrow's Title Case and emoji and fancy-text cleanup without `\p{...}` regular expressions (plain ES5), a port of the formatter above | [aktiwers/bolli-youtube](https://github.com/aktiwers/bolli-youtube) `src/youtube/api/title-format.ts` @ 27445b1 (0.1.382), with an export added | GPL-3.0-only |

`dearrow/` is used by `src/dearrow/formatter.js`, in the webOS 22+ build only;
`webpack.config.js` swaps in `src/dearrow/formatter-legacy.js` for the legacy
one, which uses `bolli/`: `dearrow/` needs Chrome 64 and is 48 KiB there.
