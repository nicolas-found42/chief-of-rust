# macOS RAR/unRAR CLI installation research

_Researched 2026-10-17. Question: best way to install `unrar`/`rar` CLI on macOS
as of 2026-10, given the Homebrew cask `rar` is disabled (Gatekeeper), balancing
RAR5/RAR6-format support, passwords, recovery records, create vs. extract, and
security. No code changed._

Path note: this repo has no `docs/research/` convention (see
`docs/company-deep-dive-plugin.md`); this note lives beside the other research
notes at `docs/`.

---

## Bottom line

- **Need to *create* RAR archives or repair with recovery records:** install the
  official RARLAB `rar` (which also ships `unrar`) via **MacPorts**
  (`sudo port install rar`). It is the only maintained, non-bypass route to the
  official binary on macOS that both creates and extracts. Source:
  https://ports.macports.org/port/rar, https://www.rarlab.com/download.htm?Platform=macOS
- **Extract-only:** prefer **MacPorts `unrar`** (`sudo port install unrar`) or the
  **`gklein/rar` Homebrew tap** (`brew install gklein/rar/unrar`). Both build
  the official `unrar` from source, so nothing is quarantined and no Gatekeeper
  bypass is needed. Source: https://ports.macports.org/port/unrar,
  https://github.com/gklein/homebrew-rar
- **Do not use Homebrew `p7zip` for RAR** — Homebrew's formula deliberately
  removes the non-free RAR codec, so it cannot extract RAR at all. Source:
  https://raw.githubusercontent.com/Homebrew/homebrew-core/master/Formula/p/p7zip.rb
- **`unar` (The Unarchiver) is a good fallback for odd/legacy archives and
  non-UTF-8 filenames**, and it does handle RAR (including encryption and
  multi-volume) up to RAR5, but it is extract-only and cannot create or repair.
  Source: https://github.com/ashang/unar/blob/master/README.md,
  https://en.wikipedia.org/wiki/The_Unarchiver
- **Built-in `bsdtar`/libarchive can read many RAR/RAR5 archives with no
  install**, but it has no password support, no recovery-record handling, and
  known bugs on RAR5-with-recovery-record and solid archives. Source:
  https://github.com/libarchive/libarchive/issues/2711,
  https://github.com/libarchive/libarchive/issues/1374
- **Avoid the disabled official cask and unsigned third-party mirrors unless you
  accept a Gatekeeper bypass** (`xattr -dr com.apple.quarantine …` or manual
  approval in System Settings). Source:
  https://formulae.brew.sh/api/cask/rar.json,
  https://github.com/grinderz/homebrew-tap

---

## 1. What upstream actually ships for macOS

RARLAB's macOS download page lists only **"RAR for macOS ARM/x64"** (command-line
only, trial license) in both release (7.23) and beta (7.30 beta 1) builds; there
is no separate current `unrar` macOS binary. The cask's artifact list confirms
the tarball ships both `rar/rar` and `rar/unrar`.

- Source: https://www.rarlab.com/download.htm?Platform=macOS
- Source: https://formulae.brew.sh/api/cask/rar.json (artifacts: `rar/rar`,
  `rar/unrar`)

The official `unrar` source (v7.2.7) is published separately and is what
MacPorts/gklein build.

- Source: https://ports.macports.org/port/unrar

---

## 2. Homebrew status

`brew install --cask rar` is **disabled as of 2026-09-01** with reason
`fails_gatekeeper_check`: the upstream macOS binaries are not signed/notarized.

- Source: https://formulae.brew.sh/api/cask/rar.json
  (`"disabled": true`, `"disable_date": "2026-09-01"`,
  `"disable_reason": "fails_gatekeeper_check"`)
- Source: https://brew.sh/2026/06/11/homebrew-6.0.0
  ("Casks that fail macOS Gatekeeper checks, deprecated in 5.0.0, remain on
  track to be disabled in September 2026.")

Homebrew 5.x/6.x also removed `--no-quarantine`, so there is no built-in way
to skip Gatekeeper for casks.

- Source: https://github.com/Homebrew/brew/issues/20755

`brew install unar` (formula, not cask) remains fully supported and is not
affected.

- Source: https://formulae.brew.sh/formula/unar

---

## 3. Option comparison

| Option | Install | Create RAR | Extract RAR | RAR5 | Passwords | Recovery records | Gatekeeper |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MacPorts `rar` (official binary) | `sudo port install rar` | Yes | Yes (via `unrar`) | Yes (all current) | Yes (AES-256) | Yes (create + repair `rar r`) | No bypass (MacPorts downloads via curl, no quarantine) |
| MacPorts `unrar` (source build) | `sudo port install unrar` | No | Yes | Yes | Yes | Extract only; no repair | No bypass |
| gklein tap `unrar` (source build) | `brew install gklein/rar/unrar` | No | Yes | Yes | Yes | Extract only | No bypass (built locally) |
| grinderz tap `rar` cask (official binary copy) | `brew tap grinderz/homebrew-tap && brew install --cask grinderz/homebrew-tap/rar` | Yes | Yes | Yes | Yes | Yes | **Bypass required** (unsigned download quarantined) |
| Direct download from rarlab.com | manual tar.gz | Yes | Yes | Yes | Yes | Yes | **Bypass required** |
| `unar` (The Unarchiver) | `brew install unar` | No | Yes (RAR incl. encryption, multi-volume) | Yes (up to RAR5) | Yes | No | No (bottled) |
| `p7zip` (Homebrew) | `brew install p7zip` | No (not RAR) | **No RAR** (codec removed) | No | No | No | No |
| `bsdtar`/libarchive (built-in) | preinstalled | No | Limited (RAR/RAR5 read) | Partial (bugs) | No | No | No |

Sources:
- MacPorts rar/unrar: https://ports.macports.org/port/rar,
  https://ports.macports.org/port/unrar,
  https://raw.githubusercontent.com/macports/macports-ports/master/archivers/rar/Portfile,
  https://raw.githubusercontent.com/macports/macports-ports/master/archivers/unrar/Portfile
- gklein tap: https://github.com/gklein/homebrew-rar (README)
- grinderz tap: https://github.com/grinderz/homebrew-tap (README)
- unar: https://formulae.brew.sh/formula/unar,
  https://github.com/ashang/unar/blob/master/README.md
- p7zip: https://formulae.brew.sh/formula/p7zip,
  https://raw.githubusercontent.com/Homebrew/homebrew-core/master/Formula/p/p7zip.rb
- bsdtar/libarchive: https://github.com/libarchive/libarchive/issues/2711,
  https://github.com/libarchive/libarchive/issues/1374

---

## 4. RAR format versions ("RAR5/RAR6")

There is **no separate "RAR6" container format**. The only two extraction-relevant
generations are legacy RAR 4.x (RAR 1.5–4.x) and **RAR5** (introduced with
WinRAR 5.0, April 2013). WinRAR 7.0 (Feb 2024) dropped *creating* RAR 4.x
archives but still writes RAR5, now with dictionaries up to 64 GB.

- Source: https://www.win-rar.com/singlenewsview.html?&L=5&cHash=6226baefb34ecb5581e6425b90442725&tx_ttnews%5Btt_news%5D=251
  (WinRAR 7.00 final release notes)
- Source: https://www.loc.gov/preservation/digital/formats//fdd/fdd000460.shtml
  (RAR Archive File Format, Version 5)
- Source: https://en.wikipedia.org/wiki/Winrar

Practical consequence: "RAR5 vs RAR6" in tooling discussions really means
"RAR5 with modern/large dictionaries vs. older RAR5/4.x." Official RAR/unRAR
7.2.x handles all of them. `unar` 1.10.x handles RAR up to RAR5. libarchive
3.7.x reads RAR/RAR5 but has open bugs on recovery-record and solid archives.

- Source: https://github.com/libarchive/libarchive/issues/2711
  ("RAR5 archive with recovery record produces error in bsdtar")

---

## 5. Passwords, recovery records, create vs. extract

- **Passwords:** official RAR/unRAR use AES-256 for RAR5. Source:
  https://www.win-rar.com/encryption-faq.html?L=0
  `unar` supports RAR encryption (README: "Including encryption"). Source:
  https://github.com/ashang/unar/blob/master/README.md
  libarchive does not reliably detect or use RAR5 passwords. Source:
  https://github.com/libarchive/libarchive/issues/1374
- **Recovery records / repair:** only the official `rar` can *create* recovery
  records (`rr[N]`) and *repair* (`rar r`) using them; `unrar` can test/extract
  but not repair; `unar` and libarchive cannot. Source:
  https://manpages.ubuntu.com/manpages/focal/man1/rar.1.html (rr/rv commands),
  https://www.rarlab.com/download.htm?Platform=macOS
- **Create archives:** only the official `rar` (and WinRAR on Windows/Android).
  UnRAR's license forbids recreating the compression algorithm. Source:
  https://github.com/gklein/homebrew-rar (README, "UnRAR license")

---

## 6. Security: Gatekeeper and notarization

- Homebrew's policy requires casks that Gatekeeper can assess to pass its
  checks; unsigned/unnotarized casks are disabled/removed. Source:
  https://docs.brew.sh/Acceptable-Casks,
  https://docs.brew.sh/Deprecating-Disabling-and-Removing
- The disabled `rar` cask's binaries are not signed/notarized, so macOS
  quarantines them on download; running requires either approving in
  System Settings → Privacy & Security or `xattr -dr com.apple.quarantine …`.
  Source: https://github.com/grinderz/homebrew-tap (README)
- **Risk of bypassing Gatekeeper:** you run a binary macOS has not vouched for.
  Mitigations: pin by SHA-256 (Homebrew casks do), download only from
  rarlab.com, and prefer source builds (MacPorts `unrar`, gklein tap) or
  MacPorts' `rar` port, which do not set the quarantine attribute. Source:
  https://github.com/grinderz/homebrew-tap (README: "What that costs")

---

## 7. Recommendation

1. **If you need create + extract + recovery repair:** use MacPorts.
   ```
   sudo port install rar
   ```
   Rationale: official binary, all formats/passwords/recovery, no Gatekeeper
   bypass. Source: https://ports.macports.org/port/rar
2. **If you only need extraction and want a clean, updatable install without
   MacPorts:** use the gklein tap.
   ```
   brew install gklein/rar/unrar
   ```
   Rationale: builds official unrar from source, auto-updated daily, no
   quarantine. Source: https://github.com/gklein/homebrew-rar
3. **If you already use MacPorts and want only extraction:** `sudo port install unrar`.
4. **Use `brew install unar`** as a fallback for legacy/odd formats and
   non-UTF-8 filenames, not as your primary RAR tool. Source:
   https://theunarchiver.com/command-line
5. **Use built-in `bsdtar -xf archive.rar`** only for quick, unencrypted
   extraction when you cannot install anything. Source:
   https://github.com/libarchive/libarchive/issues/2711
6. **Avoid** the disabled official cask, grinderz tap, and raw rarlab.com
   downloads unless you deliberately accept a Gatekeeper bypass; and **do not
   use Homebrew `p7zip` expecting RAR support**.

---

## Sources

- RARLAB macOS downloads: https://www.rarlab.com/download.htm?Platform=macOS
- Homebrew cask `rar` (disabled): https://formulae.brew.sh/cask/rar,
  https://formulae.brew.sh/api/cask/rar.json
- Homebrew 6.0.0 Gatekeeper track: https://brew.sh/2026/06/11/homebrew-6.0.0
- Homebrew `--no-quarantine` removal: https://github.com/Homebrew/brew/issues/20755
- Homebrew `unar` formula: https://formulae.brew.sh/formula/unar,
  https://formulae.brew.sh/api/formula/unar.json
- Homebrew `p7zip` formula: https://formulae.brew.sh/formula/p7zip,
  https://raw.githubusercontent.com/Homebrew/homebrew-core/master/Formula/p/p7zip.rb
- MacPorts `rar`: https://ports.macports.org/port/rar
- MacPorts `unrar`: https://ports.macports.org/port/unrar
- MacPorts rar Portfile:
  https://raw.githubusercontent.com/macports/macports-ports/master/archivers/rar/Portfile
- MacPorts unrar Portfile:
  https://raw.githubusercontent.com/macports/macports-ports/master/archivers/unrar/Portfile
- gklein homebrew-rar tap: https://github.com/gklein/homebrew-rar
- grinderz homebrew-tap: https://github.com/grinderz/homebrew-tap
- The Unarchiver / unar: https://theunarchiver.com/command-line,
  https://github.com/ashang/unar/blob/master/README.md,
  https://en.wikipedia.org/wiki/The_Unarchiver
- libarchive/bsdtar RAR issues:
  https://github.com/libarchive/libarchive/issues/2711,
  https://github.com/libarchive/libarchive/issues/1374
- WinRAR 7.00 release notes:
  https://www.win-rar.com/singlenewsview.html?&L=5&cHash=6226baefb34ecb5581e6425b90442725&tx_ttnews%5Btt_news%5D=251
- RAR format (LoC): https://www.loc.gov/preservation/digital/formats//fdd/fdd000460.shtml
- Homebrew Acceptable Casks: https://docs.brew.sh/Acceptable-Casks
- Homebrew deprecation/disabling: https://docs.brew.sh/Deprecating-Disabling-and-Removing