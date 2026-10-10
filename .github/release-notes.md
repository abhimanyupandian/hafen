Hafen's desktop app, for macOS, Windows and Linux. An early preview: expect rough edges, and please
report what you find. Tested on macOS; the Windows and Linux builds are experimental.

| System | File |
|---|---|
| macOS, Apple silicon (M1 and later) | `Hafen-<version>-mac-arm64.dmg` |
| macOS, Intel | `Hafen-<version>-mac-x64.dmg` |
| Windows | `Hafen-<version>-win-x64.exe` |
| Linux | `Hafen-<version>-linux-x86_64.AppImage` |

**These builds aren't signed yet**, so your system warns before the first start:

- **macOS:** open the `.dmg` and drag Hafen to Applications. If macOS says it's damaged or can't be
  checked, run this once in Terminal, then open it again:
  `xattr -cr /Applications/Hafen.app`
- **Windows:** if "Windows protected your PC" appears, click **More info**, then **Run anyway**.
- **Linux:** make the file runnable, then run it: `chmod +x Hafen-*.AppImage && ./Hafen-*.AppImage`

The command-line runner for CI is installed from the repository for now: see the README's Quick start.
