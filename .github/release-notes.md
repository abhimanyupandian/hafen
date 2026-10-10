Hafen's desktop app, for macOS. An early preview: expect rough edges, and please report what you
find.

| System | File |
|---|---|
| macOS, Apple silicon (M1 and later) | `Hafen-<version>-mac-arm64.dmg` |
| macOS, Intel | `Hafen-<version>-mac-x64.dmg` |

**It isn't notarized by Apple yet**, so macOS won't open it the first time. Open the `.dmg`, drag
Hafen to Applications and open it: macOS says it can't verify it. Then open **System Settings →
Privacy & Security**, scroll down to Hafen, click **Open Anyway** and confirm. (Or run this once in
Terminal: `xattr -cr /Applications/Hafen.app`.)

The command-line runner for CI is installed from the repository for now: see the README's Quick start.
