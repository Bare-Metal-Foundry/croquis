# Croquis headless API — for scripts and AI agents

Croquis builds **constrained 2D sketches** (lines, arcs, circles with relations and dimensions, like a CAD sketcher) and exports them as **SVG, PDF, TikZ/LaTeX** or a Croquis `.json` file you can open, drag and edit in the [web app](https://bare-metal-foundry.github.io/croquis/).

The headless tool `croquis.mjs` runs the **same solver and renderer as the web app**, in Node.js 18+, with **no dependencies** and no browser. You describe the sketch in JSON; Croquis solves it and tells you exactly whether it is fully defined, which constraint conflicts, and the solved values. Use it instead of hand-writing SVG or TikZ when a figure must be geometrically exact: mechanisms, free-body diagrams, beams, brackets, layouts, schematics.

## Run it

```sh
# without installing anything (needs Node.js 18+ and git)
npx github:Bare-Metal-Foundry/croquis help
npx github:Bare-Metal-Foundry/croquis example > spec.json
npx github:Bare-Metal-Foundry/croquis build spec.json --svg figure.svg --pdf figure.pdf --require-full

# or from a clone
git clone https://github.com/Bare-Metal-Foundry/croquis.git
node croquis/croquis.mjs build spec.json --svg figure.svg --tikz figure.tex --json figure.croquis.json --link
```

`build` prints a JSON report on stdout:

```json
{
  "ok": true,
  "status": "fully defined",
  "dof": 0,
  "problems": [],
  "warnings": [],
  "dimensions": [{ "name": "D1", "at": "dimensions[0]", "type": "length", "value": 30 }],
  "measures": [{ "name": "slider position", "type": "horizontal", "value": 100.6224415 }],
  "files": ["figure.svg"],
  "link": "https://bare-metal-foundry.github.io/croquis/#view=…"
}
```

Exit codes: `0` ok · `1` invalid input (the report's `error` names the faulty item) · `2` conflicting or over-defined constraints (`problems` lists each one with its index in your description) · `3` not fully defined, when `--require-full` is given.

| Option | Effect |
| --- | --- |
| `--svg <file>` | Vector figure, about 160 mm across (text and arrows stay readable for any part size). |
| `--pdf <file>` | Vector PDF. With a `sheet`, the paper at its scale with frame and title block; otherwise the drawing at full size. |
| `--dxf <file>` | Solid geometry in mm for CAD/CAM (SOLIDWORKS, laser cutters); construction lines are left out. |
| `--tikz <file>` | `tikzpicture` for LaTeX (needs `\usepackage{tikz}`); `--standalone` for a complete document, `--tikz-width <cm>` (default 12). |
| `--json <file>` | Croquis file: open it in the web app (File › Import) to drag and edit. |
| `--link` / `--edit-link` | Print a link that opens the drawing in the web app, view-only or as an editable copy. The drawing is inside the link. |
| `--require-full` | Fail (exit 3) unless every entity is pinned down. |
| `--no-dims` | Leave dimensions out of the figures. |
| `--quiet` | No report. |

`node croquis.mjs render drawing.json --svg out.svg` renders a file saved from the web app.

## The description

Lengths are in `units` (`"mm"` default, or `"in"`); angles in degrees. Give **approximate** coordinates, then let relations and dimensions fix the exact geometry — exactly like sketching by hand and then constraining. Aim for `"fully defined"`.

```json
{
  "name": "Crank and slider",
  "units": "mm",
  "entities": [
    { "id": "crank", "type": "line", "from": [0, 0], "to": [25, 15] },
    { "id": "rod", "type": "line", "from": [25, 15], "to": [90, 0] },
    { "id": "rail", "type": "line", "from": [-10, 0], "to": [120, 0], "construction": true }
  ],
  "relations": [
    { "type": "coincident", "refs": ["crank.start", "origin"] },
    { "type": "coincident", "refs": ["crank.end", "rod.start"] },
    { "type": "coincident", "refs": ["rail.start", "origin"] },
    { "type": "horizontal", "refs": ["rail"] },
    { "type": "on", "refs": ["rod.end", "rail"] }
  ],
  "dimensions": [
    { "type": "length", "refs": ["crank"], "value": 30 },
    { "type": "length", "refs": ["rod"], "value": 80 },
    { "type": "angle", "refs": ["rail", "crank"], "value": 40 },
    { "type": "length", "refs": ["rail"], "value": 130, "offset": -10 }
  ],
  "notes": [
    { "type": "force", "at": "rod.end", "angle": 180, "length": 18, "push": true, "text": "F" },
    { "type": "support", "at": "origin", "kind": "pin" }
  ],
  "measure": [
    { "name": "slider position", "type": "horizontal", "refs": ["origin", "rod.end"] }
  ]
}
```

### Entities

Every entity has an `id` that the rest of the description refers to. `"construction": true` draws it as a dash-dot guide line.

| Type | Fields | Parts you can refer to |
| --- | --- | --- |
| `point` | `at: [x, y]` | `id` |
| `line` | `from`, `to` | `id`, `id.start`, `id.end` |
| `circle` | `center`, `r` (or `d`) | `id`, `id.center` |
| `arc` | `center`, `from`, `to` (counter-clockwise), or `center`, `r`, `start`, `end` (degrees) | `id`, `id.start`, `id.end`, `id.center` |
| `rect` | `from`, `to` (or `size: [w, h]`) — comes with horizontal/vertical relations | lines `id.bottom` `id.right` `id.top` `id.left`; corners `id.bl` `id.br` `id.tr` `id.tl` |
| `slot` | `from`, `to` (arc centers), `width` | `id.side1` `id.side2` `id.end1` `id.end2` `id.axis` `id.c1` `id.c2` |
| `polygon` | `center`, `vertex`, `sides`, `inscribed` | `id.edge1`…, `id.circle`, `id.center` |

`origin` is the fixed point (0, 0). Parts chain: `plate.bottom.start`.

Optional `style` on any entity: `color` (`ink grey red orange amber green teal cyan blue violet magenta brown` or `#rrggbb`), `dash` (`dash hidden dot dashdot center phantom`), `width` (px), `fill` (a color: fills a circle or a closed outline) and `fillOpacity` (0–1). A filled outline with a filled hole of the same fill shows the hole empty.

### Relations

`{ "type": …, "refs": [ … ] }`

| Type | References |
| --- | --- |
| `horizontal`, `vertical` | one line, or two points |
| `parallel`, `perpendicular`, `collinear` | two lines |
| `equal` | two lines (length) or two circles/arcs (radius) |
| `tangent` | line + circle/arc, or two circles/arcs |
| `concentric` | two circles/arcs, or circle + point |
| `coradial` | two circles/arcs |
| `coincident` | two points |
| `on` | point + line, circle or arc |
| `midpoint` | point + line |
| `symmetric` | two entities of the same kind + the axis line |
| `intersection` | point + two lines |
| `fix` | one entity |

### Dimensions

`{ "type": …, "refs": [ … ], "value": 80, "side": "below", "offset": 8 }` — omit `value` to keep the current size. `"driven": true` makes a reference dimension that measures without constraining (it does not remove a degree of freedom).

Placing the text: `"side": "above" | "below" | "left" | "right"` puts it on that side of what it measures, `offset` length units away (default 10 mm). Linear dimensions take the side across their direction (horizontal ones: above/below; vertical ones: left/right); radius and diameter leaders point that way. A side that does not apply is reported as a warning. Without `side`, `offset` is signed: positive is on the left when going from the first reference to the second, so above for a horizontal dimension and left for a vertical one.

| Type | References |
| --- | --- |
| `length` | one line |
| `distance` | two points, point + line, or two parallel lines |
| `horizontal`, `vertical` | two points, or one line |
| `radius`, `diameter` | one circle or arc |
| `angle` | two lines (`value` in degrees) |

### Notes (annotations that follow the geometry)

Anchors: a point (`"rod.end"`), a line midpoint (`"rod.mid"`), a position along a line or arc (`"rod@0.25"`, or `"wheel@90"` in degrees on a circle), or a free position `[x, y]`. Text supports `F_1` and `m^2` sub/superscripts, Greek letters and `⌀` (drawn as lines in PDF, written `Ø` in SVG so it shows with any font).

| Type | Fields |
| --- | --- |
| `text` | `at`, `text`, `offset: [dx, dy]`, `leader`, `size` (px), `frame` |
| `force` | `at`, `angle` (deg, direction of the arrow), `length`, `push` (arrowhead on the point), `text` |
| `moment` | `at`, `radius`, `ccw`, `angle`, `text` |
| `load` | `from`, `to`, `q` (or `q0`, `q1` for a linear load), `side` (1 or -1), `text` |
| `support` | `at`, `kind` (`fixed`, `pin`, `roller`), `angle` (90 = ground below) |
| `spring`, `damper` | `from`, `to`, `text` |
| `frame` | `at`, `angle`, `length`, `x`, `y` (axis names) |
| `mass` | `at`, `text` |

### Measures

`"measure": [{ "name": "stroke", "type": "distance", "refs": ["a", "b"] }]` — values computed on the solved sketch and returned in the report; nothing is drawn. Same types as dimensions. Useful to read results off a mechanism (a position, an angle, a length).

### Drawing sheet (optional)

```json
"sheet": { "size": "A4", "orient": "landscape", "scale": "auto", "projection": "first",
           "fields": { "company": "ACME", "number": "BMF-0001", "rev": "A", "drawn": "J. Doe", "material": "S235" } }
```

Sizes `A4 A3 A2 A1 A0 Letter Tabloid`; `scale` like `"1:2"` or `"2:1"`, or `"auto"` (largest standard scale that fits). Either way the drawing is centred above the title block for the scale used; if it does not fit at the scale you asked for, the report says so in `warnings`. PDF, SVG and TikZ then output the whole sheet with an ISO frame and title block.

## As a library

```js
import { build, open } from './croquis.mjs';          // or 'croquis' after npm install github:Bare-Metal-Foundry/croquis

const d = await build(spec);
if (!d.report.ok) throw new Error(d.report.problems.join('\n'));
await fs.writeFile('figure.svg', await d.svg());
await fs.writeFile('figure.pdf', await d.pdf());       // Uint8Array
await fs.writeFile('figure.tex', await d.tikz({ width: 10, standalone: false }));
await fs.writeFile('part.dxf', await d.dxf());
console.log(await d.link('view'));
```

`load()` returns `{ K, H }`: `K` is the full sketch engine (the same `SketchCore` the web app uses: `new K.Sketch()`, `K.addRelation`, `K.addDimension`, `K.solve`, `K.analyze`, `K.planOffset`…) for anything the description format does not cover.

## Examples

See [`docs/examples/`](examples): a crank and slider mechanism, a bracket plate with holes and a slot, and a simply supported beam with loads. Each `.json` builds to the `.svg` next to it, fully defined.

## License

Free for personal and other noncommercial use under the [PolyForm Noncommercial License 1.0.0](../LICENSE.md). Commercial use needs the author's approval: [message Stépane Binon on LinkedIn](https://www.linkedin.com/in/stepane-binon/).
