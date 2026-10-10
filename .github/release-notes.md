Hafen's desktop app, for macOS. An early preview: expect rough edges, and please report what you
find.

| System | File |
|---|---|
| macOS, Apple silicon (M1 and later) | `Hafen-<version>-mac-arm64.dmg` |
| macOS, Intel | `Hafen-<version>-mac-x64.dmg` |

**It isn't signed yet**, so macOS warns before the first start. Open the `.dmg` and drag Hafen to
Applications. If macOS says it's damaged or can't be checked, run this once in Terminal, then open it
again: `xattr -cr /Applications/Hafen.app`

The command-line runner for CI is installed from the repository for now: see the README's Quick start.
