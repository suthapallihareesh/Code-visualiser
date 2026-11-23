# Code Studio

A local IDE with the same look as JDK 21 Studio, now for **Java, C, C++ and Python**.
Every language runs on the **real compiler or interpreter installed on your computer**. Nothing is
emulated, nothing goes to the cloud, and there is no API quota.

## Start it

| System | How |
|---|---|
| Windows | Double-click `run.bat` and keep the black window open |
| macOS / Linux | Run `./run.sh` in a terminal and keep it open |

The browser opens at `http://127.0.0.1:32121/`. Do **not** double-click `index.html`; a file opened
directly cannot talk to your compilers.

The launcher itself (not a language tab) needs **Node.js 18+**: `winget install OpenJS.NodeJS.LTS`.

## What each language uses

| Language | Real tool | Versions offered | Install on Windows (PowerShell) |
|---|---|---|---|
| Java | `javac` + `java` from a full JDK | JDK 21 (17+ also works) | `winget install EclipseAdoptium.Temurin.21.JDK` |
| C | GCC or Clang | C11, C17 (default), C23 | `winget install BrechtSanders.WinLibs.POSIX.UCRT` |
| C++ | G++ or Clang++ | C++17, C++20 (default), C++23, C++26 | same as C |
| Python | CPython 3.8+ | whatever `python` is on your PATH (3.12 / 3.11 typical) | `winget install Python.Python.3.12` |

macOS / Linux: `sudo apt install build-essential openjdk-21-jdk python3` (Ubuntu) or
`xcode-select --install` and `brew install openjdk@21 python node` (macOS; Node is only for the launcher).

The top bar shows a green dot for every language that was found and a red dot for the ones that are
missing. After installing something, click the status badge (top right) to re-check without restarting.
Only standards your compiler really supports appear in the **Standard** menu.

## Features

- Multi-file projects per language, with rename (double-click) and delete.
- Real **Compiler walkthrough**: javac TaskListener events for Java; preprocess → assembly → assemble → link
  for C/C++ (with real line counts, instruction counts and file sizes); tokenize → AST → symbol table →
  bytecode for Python. Assembly, `dis` and `javap` listings are shown.
- Diagnostics with the quoted source line; click one to jump to it. Error lines are marked in the gutter.
- Interactive console: type input while the program runs, EOF button (Ctrl+D), Stop button, stderr in red.
  Prompts such as `printf("Name: ")` appear immediately (Code Studio unbuffers C/C++ stdio for you).
- Clean messages: you only see your own code's output and the compiler's own diagnostics. Temporary folders and the app's internal details are never shown; internal problems appear only in the launcher window.
- C/C++ **Memory checks** option (AddressSanitizer + UBSan) where the compiler supports it.
- Syntax highlighting, auto-indent, Tab / Shift+Tab, Ctrl+/ comment, Ctrl+Enter run, Ctrl+S save.
- Projects are saved automatically in the browser; **Export project / Import** make a `.json` backup.
  A project saved by the old JDK 21 Studio is imported into the Java tab automatically.

## Safety

The bridge listens on `127.0.0.1` only and every request needs a secret token that exists only in the
page it serves, plus host and origin checks. Programs you run have **your account's permissions**: the
IDE limits run time (10 minutes), memory for Java and output size (2 MB), but it is **not an
operating-system sandbox**. Only run code you trust.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Wrong launch method" message in the console | Close the tab and start `run.bat` / `run.sh` instead |
| Language shows a red dot | Install the tool from the table above, then click the status badge |
| `gcc` installed but not found (Windows) | Reopen `run.bat` after install; Code Studio also checks MSYS2, MinGW, LLVM and WinLibs folders |
| Want to verify your install? | Run `node tests/accuracy.js` (42 checks) and `node tests/compare-native.js` (compares every result with the plain `javac`/`gcc`/`g++`/`python` command line). Both work offline; exit code 0 = all passed |
| Port 32121 is busy | The launcher automatically tries the next ports and prints the address |

## Files

```
run.bat / run.sh     launchers
server.js            local bridge (no dependencies)
lib/                 tool detection, compile pipelines, explanations
helpers/             CompileHelper.java (javac API), pycheck.py (CPython phases)
tests/accuracy.js    offline self-check: 42 compile/run checks across the 4 languages
tests/compare-native.js  side-by-side check against the plain command-line tools (22 comparisons)
tests/fetch-logic.js     offline unit test of the compiler downloader
electron/main.js     desktop window (Electron) that starts the launcher
scripts/             fetch-toolchains.js (downloads the real compilers), verify-bundle.js (checks them)
.github/workflows/   build.yml: builds the Windows, macOS and Linux installers
ui/                  the interface (HTML, CSS, JavaScript)
site/                public landing page (deployed with Cloudflare Pages)
```

## Publishing (GitHub + Cloudflare Pages)

1. Create a GitHub repository and push this folder. Search the project for `suthapallihareesh/Code-visualiser` and replace it with
   your GitHub user and repository name (it appears in `site/index.html`).
2. In Cloudflare Pages, connect the repository with **no build command** and the output directory set to `site`.
3. Upload installers to **GitHub Releases** (not to the repository, and not to Pages: Pages files are limited to 25 MiB,
   a release file must be under 2 GiB). The Download buttons point at `releases/latest`.

The compilers and installers are never committed; `.gitignore` keeps them out.

## Building the installers

The installer is an Electron app (`electron/main.js`) that starts the launcher and shows it in its own window. The real
compilers are downloaded into `toolchains/` by `scripts/fetch-toolchains.js` and packaged next to the app.

| Platform | Bundled inside the installer | Not bundled |
|---|---|---|
| Windows x64 | Temurin JDK 21, GCC + G++ (WinLibs, UCRT), CPython 3.12 | nothing |
| macOS (Apple silicon, Intel) | Temurin JDK 21, CPython 3.12 | C/C++ use Apple's Command Line Tools (`xcode-select --install`): Apple's licence does not allow redistributing its SDK |
| Linux x64 | Temurin JDK 21, CPython 3.12 | C/C++ use the system GCC/Clang (`build-essential`): a GCC build needs the system C library headers |

Build with GitHub Actions: open **Actions, Build installers, Run workflow** for test installers, or push a tag such as
`v1.0.0` to publish them on GitHub Releases. The workflow downloads each compiler, verifies its SHA-256, checks that Code
Studio really uses the bundled compilers and that they run a real program correctly, then builds the installer.

To build on your own computer: `npm ci`, `npm run toolchains`, `npm run verify:bundle`, `npm run dist`.
To try the desktop app without packaging: `npm run toolchains` then `npm run app`.

Installers are **not signed**. Windows shows a SmartScreen warning and macOS asks the user to right-click, Open. Signing
needs a paid certificate (Windows) or an Apple Developer ID (macOS); add them as GitHub secrets when you have them.

Third-party licences and sources for the bundled compilers are written to `toolchains/THIRD-PARTY-NOTICES.txt` and
shipped inside every installer.

## Status

The app itself, the desktop shell and the build pipeline are in this repository. The installers are produced by the
GitHub Actions workflow, which has not been run yet: do a manual run first and fix anything it reports before you
publish the Download buttons.
