# Custom omp Composer Shapes — Research

Research date: 2026-10-20
omp version: 18.12.3 (pi-coding-agent@18.12.3)

## TL;DR

To add a custom composer shape to omp:

1. Create a TypeScript extension file (e.g., `my-shape.ts`)
2. Place it in `~/.omp/agent/extensions/` (user-level) or `.omp/extensions/` (project-level)
3. Implement a `ComposerStyle` object and register it via `pi.registerComposerShape()`
4. Select it in Settings → Appearance → Composer Shape (or set `composer.shape: "my-shape"` in config)

---

## 1. How Composer Shapes Work

### Architecture

```
Extension (your .ts file)
    ↓ pi.registerComposerShape(definition)
ComposerShapeDefinition { label, description?, style: ComposerStyle }
    ↓ installExtensionComposerShape()
pi-tui registry (registerComposerStyle + selector options)
    ↓ getComposerStyle(id)
Editor renders via style.renderTop/renderRow/renderBottom
```

### The ComposerStyle Interface

Source: `pi-tui/src/components/composer/types.ts`

```typescript
interface ComposerStyle {
  readonly id: string;                    // Unique identifier (kebab-case)
  readonly filledSurface?: boolean;       // Rows paint own foreground via surfaceColor
  readonly sideBorders: boolean;          // Rows have left/right border glyphs
  readonly verticalChrome: 0 | 1 | 2;     // Rows consumed by top+bottom chrome
  readonly statusAttachment: "top-border" | "top-band" | "top-rule-chip" | "none";
  readonly bottomBar: "none" | "left" | "full";
  readonly bottomBarGap: boolean;         // Spacer row between editor and bottom bar
  readonly defaultPromptGutter: string | undefined;  // e.g., "❯ ", "╰─ "
  
  defaultPaddingX(themePaddingX: number | undefined): number;
  sideChromeWidth(paddingX: number): number;
  renderTop(ctx: ComposerChromeContext): string | undefined;
  renderRow(ctx: ComposerRowContext): string[];
  renderBottom(ctx: ComposerChromeContext): string | undefined;
}
```

### Context Interfaces

```typescript
interface ComposerChromeContext {
  width: number;                          // Full terminal width
  paddingX: number;                       // Horizontal padding inside side chrome
  borderColor: (str: string) => string;   // Border/foreground color
  accentColor: (str: string) => string;   // Accent color (caps, rails)
  surfaceColor: (str: string) => string;  // Background fill
  box: ComposerBox;                       // Box-drawing glyphs (boxRound)
  topBorder?: EditorTopBorder;            // Status content for top chrome
}

interface ComposerRowContext extends ComposerChromeContext {
  text: string;                           // Decorated row text (cursor included)
  pad: string;                            // Spaces padding to content width
  gutter: string;                         // Prompt gutter ("" if none)
  isLastRow: boolean;
  cursorOverflow: number;                 // Cells cursor overflowed into right chrome
  imeSafeCursorTail: boolean;             // Emit empty right chrome for IME
  scrollbarThumb: boolean;                // Row is in scrollbar thumb range
}

interface EditorTopBorder {
  content: string;                        // Pre-styled status content
  width: number;                          // Visible width
  revision?: number;
}
```

### statusAttachment Modes

| Mode | Description | Used By |
|------|-------------|---------|
| `"top-border"` | Status embedded in top border | box |
| `"top-band"` | Status as flush filled band above input | band |
| `"top-rule-chip"` | Status docked onto a top rule (right edge) | claude, rule |
| `"none"` | Status detached to standalone bottom bar | borderless, field, pi, rail |

---

## 2. Built-in Shape Reference

All 8 built-in shapes live in `pi-tui/src/components/composer/`:

| Shape | ID | sideBorders | verticalChrome | statusAttachment | bottomBar | Gutter |
|-------|-----|-------------|----------------|------------------|-----------|--------|
| Status Band | `band` | false | 1 | top-band | none | `╰─ ` |
| Rounded Box | `box` | true | 2 | top-border | none | — |
| Claude Code | `claude` | false | 2 | top-rule-chip | left | `❯ ` |
| Pi | `pi` | false | 2 | none | full | — |
| Borderless | `borderless` | false | 0 | none | full | `❯ ` |
| Top Rule Dock | `rule` | false | 1 | top-rule-chip | left | `❯ ` |
| Compact Field | `field` | true | 0 | none | full | — |
| Accent Rail | `rail` | true | 0 | none | full | — |

### Key Implementation Patterns

**Boxed shapes** (box, and any framed design):
- `renderTop`: Build top border, embed status content
- `renderRow`: Handle 3 branches:
  - `imeSafeCursorTail`: Return `[leftBorder + text, bottomBorder]` (two rows)
  - `isLastRow`: Merge bottom border into last content row
  - Normal: `[leftBorder + text + pad + rightBorder]`
- `renderBottom`: Return `undefined` (merged into last row)

**Rule-based shapes** (claude, rule):
- `renderTop`: Full-width rule with status chip docked right
- `renderRow`: Simple `gutter + text + pad`
- `renderBottom`: Optional bottom rule

**Filled shapes** (field, rail):
- `filledSurface: true`
- `renderRow`: Wrap interior in `surfaceColor()`, add accent caps/rails
- Handle `scrollbarThumb` (use `█` instead of right cap)

---

## 3. Where to Put Extension Files

### Auto-discovered locations:

| Scope | Path |
|-------|------|
| User-level | `~/.omp/agent/extensions/` |
| Project-level | `<project>/.omp/extensions/` |

Files must be `.ts` or `.js`. Directory scan picks up `index.ts`/`index.js` or all direct `.ts`/`.js` children.

### Alternative: Configure in settings

```yaml
# ~/.omp/agent/config.yml
extensions:
  - ./my-composer-shape.ts
  - /absolute/path/to/another.ts
```

Or project-level `.omp/settings.yml`.

### Alternative: CLI flag

```bash
omp --extension ./my-composer-shape.ts
```

---

## 4. Minimal Extension Example

```typescript
// ~/.omp/agent/extensions/my-shape.ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ComposerShapeDefinition } from "@oh-my-pi/pi-tui/overlays/composer-shape-registry";

export default function (pi: ExtensionAPI) {
  const myShape: ComposerShapeDefinition = {
    label: "My Shape",
    description: "A custom composer shape",
    style: {
      id: "my-shape",
      sideBorders: false,
      verticalChrome: 0,
      statusAttachment: "none",
      bottomBar: "full",
      bottomBarGap: false,
      defaultPromptGutter: "❯ ",
      
      defaultPaddingX(): number {
        return 0;
      },
      
      sideChromeWidth(): number {
        return 0;
      },
      
      renderTop(): undefined {
        return undefined;
      },
      
      renderRow(ctx): string[] {
        return [ctx.gutter + ctx.text + ctx.pad];
      },
      
      renderBottom(): undefined {
        return undefined;
      },
    },
  };
  
  pi.registerComposerShape(myShape);
}
```

Then select it: **Settings → Appearance → Composer Shape → "My Shape"**

Or set directly in `~/.omp/agent/config.yml`:
```yaml
composer:
  shape: my-shape
```

---

## 5. Creative Shape Designs (11 Ideas)

### 1. `bracket` — Mathematical Bracket Frame

```
⎡ model · path · 42% ─────────────⎤
⎢ ❯ fix the failing test           ⎥
⎢   in the parser                  ⎥
⎣──────────────────────────────────⎦
```

- **Params**: sideBorders: true, verticalChrome: 2, statusAttachment: "top-border"
- **Implementation**: Clone `box.ts`; swap glyphs to `⎡⎢⎣⎤⎥⎦` (U+23A1-23A6)
- **Inspiration**: LaTeX `\left[ … \right]`, mathematical typesetting

### 2. `double` — Double-Line Box

```
╔═ model · path · 42% ═══════════╗
║ ❯ fix the failing test          ║
║   in the parser                 ║
╚═══════════════════════════════╝
```

- **Params**: sideBorders: true, verticalChrome: 2, statusAttachment: "top-border"
- **Implementation**: Clone `box.ts`; swap to `╔╗╚╝═║`
- **Inspiration**: Norton Commander, DOS TUIs, Midnight Commander

### 3. `dotted` — Light Dotted Frame

```
┌┄ model · 42% ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┐
┆ ❯ fix the failing test          ┆
┆   in the parser                 ┆
└┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┘
```

- **Params**: sideBorders: true, verticalChrome: 2, statusAttachment: "top-border"
- **Implementation**: Clone `box.ts`; use `┄` (U+2504), `┆` (U+2506), sharp corners
- **Inspiration**: Graph paper, dotted notebook rules, blueprint aesthetics

### 4. `tab` — Editor Tab (Open Bottom)

```
╭─ model · path · 42% ──────────╮
│ ❯ fix the failing test         │
│   in the parser                │
 model · 42% · 12k/200k  ← status bar acts as the desk
```

- **Params**: sideBorders: true, verticalChrome: 1, statusAttachment: "top-border", bottomBar: "full"
- **Implementation**: box.ts renderTop + renderRow; renderBottom returns undefined (status bar closes it)
- **Inspiration**: Browser tabs, VS Code editor tabs, file-folder tabs

### 5. `quote` — Markdown Blockquote Rail

```
▎ ❯ fix the failing test
▎   in the parser
▎
 model · 42% · 12k/200k
```

- **Params**: sideBorders: true, verticalChrome: 0, statusAttachment: "none", bottomBar: "left"
- **Implementation**: renderRow prepends `▎ ` (U+258E) in borderColor to every row
- **Inspiration**: Markdown blockquotes, email reply indentation, Slack quotes

### 6. `tree` — File-Tree Rows

```
─────── model · 42% ───────────────
├─ ❯ fix the failing test
│    in the parser
╰──────────────────────────────────
```

- **Params**: sideBorders: false, verticalChrome: 2, statusAttachment: "top-rule-chip"
- **Implementation**: rule.ts renderTop; continuation rows get `│  ` prefix; renderBottom draws `╰───`
- **Inspiration**: `tree` command, `git log --graph`, file explorers, org-mode outlines

### 7. `powerline` — Starship-Style Powerline

```
────────────── model · 42% 
❯ fix the failing test
 model · 42%
```

- **Params**: sideBorders: false, verticalChrome: 1, statusAttachment: "top-rule-chip", bottomBar: "left"
- **Implementation**: Extend rule.ts; use `` (U+E0B0) and `` (U+E0B2) powerline separators
- **Inspiration**: starship, oh-my-zsh powerlevel10k, vim airline/lightline, tmux powerline

### 8. `ledger` — Accounting Ledger

```
─────── model · 42% ───────────────
❯ fix the failing test ···········
  in the parser ·················
════════════════════════════════════
```

- **Params**: sideBorders: false, verticalChrome: 2, statusAttachment: "top-rule-chip"
- **Implementation**: rule.ts renderTop; renderRow adds `· ` dot leaders; renderBottom draws `═══`
- **Inspiration**: Accounting ledgers, table-of-contents dot leaders, financial statements

### 9. `wave` — Ocean Waterline

```
─────── model · 42% ───────────────
❯ fix the failing test
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
```

- **Params**: sideBorders: false, verticalChrome: 2, statusAttachment: "top-rule-chip"
- **Implementation**: rule.ts renderTop; renderBottom draws `~~~` (pure ASCII, works everywhere)
- **Inspiration**: Ocean/wave zsh themes, waterline prompts, calm/minimal aesthetics

### 10. `ascii` — Pure ASCII Retro Frame

```
+-- model · path · 42% ----------+
| > fix the failing test         |
|   in the parser                 |
+---------------------------------+
```

- **Params**: sideBorders: true, verticalChrome: 2, statusAttachment: "top-border"
- **Implementation**: Clone box.ts with `+`, `|`, `-` glyphs
- **Inspiration**: DOS, BBS, Norton Commander, serial consoles, CI log capture

### 11. `shade` — Inset Field with Level Meter

```
▌❯ fix the failing test░░░░░░░░▐
▌  in the parser░░░░░░░░░░░░░░▐
 model · 42% · 12k/200k
```

- **Params**: filledSurface: true, sideBorders: true, verticalChrome: 0, statusAttachment: "none", bottomBar: "full"
- **Implementation**: Hybrid of rail.ts + field.ts; fill empty pad with `░` (U+2591) shade
- **Inspiration**: Inset text fields (Material, iOS), progress bars, volume meters

---

## 6. Implementation Checklist

When implementing a new shape:

- [ ] Choose the closest built-in as a starting point (box/rule/field/rail)
- [ ] Set `id` to a unique kebab-case string (not a built-in id)
- [ ] Configure `sideBorders`, `verticalChrome`, `statusAttachment`, `bottomBar`, `bottomBarGap`
- [ ] Implement `renderTop` (or return `undefined`)
- [ ] Implement `renderRow` with all 3 branches:
  - [ ] `imeSafeCursorTail` → early return, no right chrome
  - [ ] `isLastRow` → boxed shapes return `[row, bottomBorder]`
  - [ ] `scrollbarThumb` → use `█` for scrollbar indicator
- [ ] Implement `renderBottom` (or return `undefined`)
- [ ] Handle `defaultPromptGutter` (continuation rows get spaces)
- [ ] Test with the settings preview (Settings → Appearance → Composer Shape)
- [ ] Test with long input (scrollbar), IME input, and narrow terminals

---

## 7. Key Source Files

| File | Purpose |
|------|---------|
| `pi-tui/src/components/composer/types.ts` | ComposerStyle, context interfaces |
| `pi-tui/src/components/composer/registry.ts` | Built-in registry, registerComposerStyle |
| `pi-tui/src/components/composer/{band,box,claude,pi,borderless,rule,field,rail}.ts` | Built-in implementations |
| `pi-tui/src/overlays/composer-shape-registry.ts` | ComposerShapeDefinition, installExtensionComposerShape |
| `pi-coding-agent/src/extensibility/extensions/loader.ts` | Extension loading, registerComposerShape API |
| `pi-coding-agent/src/extensibility/extensions/types.ts` | ExtensionAPI interface |
| `pi-coding-agent/src/modes/settings.ts` | composer.shape setting (line 124) |
| `pi-coding-agent/src/modes/controllers/extension-ui-controller.ts` | Installs extension shapes at runtime |
| `pi-coding-agent/examples/extensions/hello.ts` | Minimal extension example |

---

## 8. Available Glyphs

The symbol preset system provides these glyph sets (via `ctx.box` and theme):

- **boxRound**: `╭ ╮ ╰ ╯ ─ │` (default)
- **boxSharp**: `┌ ┐ └ ┘ ─ │`
- **boxDotted**: `┄ ┆` (horizontal/vertical dotted)
- **double**: `╔ ╗ ╚ ╝ ═ ║`
- **heavy**: `┏ ┓ ┗ ┛ ━ ┃`
- **blocks**: `█ ▓ ▒ ░` (full to light shade)
- **fractional blocks**: `▏ ▎ ▍ ▌ ▊ ▉`
- **tall brackets**: `⎡ ⎢ ⎣ ⎤ ⎥ ⎦` (U+23A1-23A6)
- **powerline**: `` `` `` `` (U+E0B0-E0B3)
- **tree**: `├ └ │ ─`

All glyphs have ASCII fallbacks for `TERM=dumb` / serial consoles.
