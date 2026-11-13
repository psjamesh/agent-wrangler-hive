import { hexTile, MARK_R, MARK_STROKE } from './hex-grid.js';

// The overview draws each hive as the regular hexagon tile seen as a box from
// above: the hexagon's centre is the box's front top corner, so the upper
// rhombus is a lit top and the lower right rhombus a shaded side. The faces
// are tones only behind the label; the seams between them show just as short
// stubs at the outer corners and below the status mark, so no line crosses
// the text.
const STUB = 0.14;

const fmt = ([x, y]) => `${(x + 0).toFixed(1)},${(y + 0).toFixed(1)}`;
const shape = (pts) => `M${pts.map(fmt).join('L')}Z`;
const stub = ([x0, y0], [x1, y1], t) => `M${fmt([x0, y0])}L${fmt([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t])}`;

// A bee seen from above, pressed into the middle of the top face like an
// engraving. Its outline spans 16.4 by 12.6 units, drawn about a point 1.1
// units below its middle.
const BEE_WIDTH = 24;
const BEE_GAP = 5;

function bee(cy, width) {
  const k = width / 16.4;
  const oy = cy + 1.1 * k;
  const pt = (x, y) => [x * k, oy + y * k];
  const ell = (x, y, rx, ry, deg) => {
    const t = (deg * Math.PI) / 180;
    const dx = Math.cos(t) * rx;
    const dy = Math.sin(t) * rx;
    const r = `${(rx * k).toFixed(2)} ${(ry * k).toFixed(2)} ${deg}`;
    return `M${fmt(pt(x - dx, y - dy))}A${r} 1 0 ${fmt(pt(x + dx, y + dy))}A${r} 1 0 ${fmt(pt(x - dx, y - dy))}Z`;
  };
  const seg = (x0, y0, x1, y1) => `M${fmt(pt(x0, y0))}L${fmt(pt(x1, y1))}`;
  return {
    wings: ell(-5.4, -0.6, 3, 1.8, -20) + ell(5.4, -0.6, 3, 1.8, 20),
    body: ell(0, 1, 4.2, 2.6, 90) + ell(0, -4.4, 1.6, 1.6, 0)
      + seg(-2.5, 0.2, 2.5, 0.2) + seg(-2.35, 2.6, 2.35, 2.6)
      + seg(-0.6, -5.8, -1.9, -7.4) + seg(0.6, -5.8, 1.9, -7.4),
    bottom: oy + 5.2 * k,
  };
}

// The label sits in one band from just below the bee to just above the status
// mark, the same on every hive whether or not it shows a mark.
export function hiveTile(size) {
  const radius = size * 0.92;
  const tile = hexTile(radius);
  const a = (radius * Math.sqrt(3)) / 2;
  const b = radius / 2;
  const scale = Math.max(1, size / 60);
  const markAt = tile.markY(scale);
  const markR = (MARK_R + MARK_STROKE / 2) * scale;
  const markEnd = markAt + markR + 2;
  const front = [0, 0];
  const mark = bee(-b, BEE_WIDTH);
  return {
    ...tile,
    top: mark.bottom + BEE_GAP,
    bottom: Math.min(tile.bottom, markAt - markR - 1.5),
    faces: [
      { d: shape([[0, -radius], [a, -b], front, [-a, -b]]), className: 'hive-face-top' },
      { d: shape([front, [a, -b], [a, b], [0, radius]]), className: 'hive-face-shade' },
      {
        d: `${stub([-a, -b], front, STUB)}${stub([a, -b], front, STUB)}${markEnd < radius ? `M${fmt([0, markEnd])}L${fmt([0, radius])}` : ''}`,
        className: 'hive-face-seam',
      },
      { d: mark.wings, className: 'hive-face-bee' },
      { d: mark.body, className: 'hive-face-bee' },
    ],
  };
}
