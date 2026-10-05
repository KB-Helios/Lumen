# EinUI glass command palette provenance

- Retrieved: 2026-08-07
- Registry source: https://ui.eindev.ir/r/glass-command-palette.json
- Registry SHA-256: `A09EE167C2C263DB4CC897EB2272193233771B49D799DABA168FF0DB104EFB79`
- Upstream repository: https://github.com/einui/einui
- Upstream `main` revision: `57cccbc4155ab1b54797dd07329b8097ee066029`
- License: MIT (https://github.com/einui/einui/blob/main/LICENCE)

## Retained recipe

The owned visual shell retains the upstream rounded glass surface, ordered
exterior/surface/specular layers, blur material, and vertical
composer/workspace/footer composition. Topology and caller-owned slot behavior
remain covered by the component contract tests.

Lumen deliberately adapts color and luminosity through `--einui-command-*`
variables. The user-approved 2026-10-05 design refinement binds both light and
dark palettes to Lumen's semantic surface, border, text, and neutral interaction
roles. It reduces additive white highlights and the existing semantic-accent
glow. The shortcut fill follows the quiet neutral row role; the owned shell no
longer claims color-identical output to the original registry recipe.

## Deliberate boundary

Removed upstream demo behavior: default command groups, query state and
filtering, keyboard listeners and browser shortcut, focus effects, selection,
action callbacks, navigation URLs, positioning variants, fullscreen backdrop,
trigger, and portal-like page ownership. Lumen's native transparent host owns
positioning and its feature layer owns every interactive region.

The upstream Lucide icons are not copied. This visual-only primitive renders
no icons; callers supply any needed Apps SDK UI icon in their own slot.

Opaque and high-contrast modes intentionally replace the liquid material with
Lumen semantic/system colours and retain the global visible-focus contract.

## Upstream MIT notice

```text
MIT License

Copyright (c) 2025 Ehsan Ghaffar

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
