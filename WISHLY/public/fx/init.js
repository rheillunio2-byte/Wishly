// Wires the React Bits effects into WISHLY.
//  · DriftWall  — drifting wall of tile art behind the login panel
//  · Crosshair  — targeting crosshair over that panel (mouse devices only)
//  · ClickSpark — star burst on every click/tap, app-wide
import { createDriftWall } from './drift-wall.js';
import { createCrosshair } from './crosshair.js';
import { createClickSpark } from './click-spark.js';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;

// Local, brand-coloured placeholder art (public/images/tiles). Swap these for real wish photos any time.
const TILES = [
  ['01-bills', 'Bills'], ['02-education', 'Education'], ['03-essentials', 'Essentials'], ['04-wishlist', 'Wishlist'],
  ['05-experiences', 'Experiences'], ['06-hobbies', 'Hobbies'], ['07-bills', 'Bills'], ['08-education', 'Education'],
  ['09-essentials', 'Essentials'], ['10-wishlist', 'Wishlist'], ['11-experiences', 'Experiences'], ['12-hobbies', 'Hobbies']
].map(([file, title]) => ({ image: `/images/tiles/tile-${file}.svg`, title }));

const wallHost = document.getElementById('authWall');
if (wallHost) {
  createDriftWall(wallHost, {
    items: TILES,
    columns: 5,
    tileWidth: 200,
    tileHeight: 132,
    gap: 18,
    tilt: 16,
    turn: -14,
    perspective: 1200,
    depth: 120,
    speed: 34,
    direction: 'up',
    variance: 0.45,
    parallax: 0.6,
    lift: 64,
    fade: 0.6,
    dim: 0.7,
    overlayColor: '#211b35',
    decorative: true // background art: hidden from screen readers, tiles not in the tab order
  });
}

const art = document.querySelector('.auth-art');
if (art && finePointer) {
  createCrosshair(art, {
    color: '#d6ccff',
    targetEffect: 'lock',
    targetSelector: '.drift-wall__tile',
    thickness: 1,
    opacity: 0.7,
    fade: 0.5,
    smoothing: 0.35,
    showCoordinates: true,
    clickPulse: true,
    style: { zIndex: '4' }
  });
}

if (!reduced) {
  createClickSpark(document.body, {
    sparkColor: ['#7659e8', '#a18bf4', '#f0a04b', '#e86aa6'],
    shape: 'star',
    sparkCount: 9,
    sparkSize: 12,
    sparkRadius: 34,
    duration: 650,
    randomness: 0.3,
    glow: 0.5,
    ring: true,
    fixed: true
  });
}
