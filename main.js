import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// localStorage はほかのアプリと共有される（同じ t-of.github.io のため）。
// キーは必ず 'nocca-nocca.' で始める。
const STORE = 'nocca-nocca.';
function load(key, fallback) {
  try {
    const v = localStorage.getItem(STORE + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(STORE + key, JSON.stringify(value)); } catch { /* 保存できなくても遊べる */ }
}

WebAppKit.init({ title: 'NOCCA*NOCCA', text: '縦横斜めに1マス動かし、相手の奥へ駒を進めたら勝ちの2人対戦ボードゲーム。' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// 音を使うときは、鳴らす前にこれを呼ぶ（RULES.md §5「音」）。
function setAudioSession(soundOn) {
  try { if (navigator.audioSession) navigator.audioSession.type = soundOn ? 'playback' : 'auto'; } catch { /* 対応していない */ }
}
let audioCtx = null;
// 駒を置く音（短い木の音）。win なら高めの 3 音
function beep(win) {
  try {
    setAudioSession(true);
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const notes = win ? [523, 659, 784] : [300];
    notes.forEach((f, k) => {
      const t = audioCtx.currentTime + k * 0.12;
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      g.gain.setValueAtTime(0.25, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + (win ? 0.3 : 0.08));
      o.connect(g).connect(audioCtx.destination);
      o.start(t); o.stop(t + 0.35);
    });
  } catch { /* 音が出なくても遊べる */ }
}

// ---- ここからアプリ本体 ----
//
// NOCCA*NOCCA: 横 5 × 縦 6 マスの盤。各マスは駒の山（配列、下から上。最大 3 段）。
// プレイヤー 1（先手）は row0 側に並び、row が増える向きに進む。row5 のさらに奥（row6）が 1 のゴール。
// プレイヤー 2（後手）は row5 側に並び、row が減る向きに進む。row0 のさらに手前（row-1）が 2 のゴール。
// 手番では自分の色が一番上に乗っている山を 1 つ選び、8 方向のどれかへ 1 マス動かす
// （山の上に乗る＝積む。3 段の山には乗れない。自分のゴール側の外には出られない）。
// 動かせる駒が 1 つもなければその場で負け。

const COLS = 5, ROWS = 6;
const idx = (r, c) => r * COLS + c;
const rowOf = (i) => (i / COLS) | 0;
const colOf = (i) => i % COLS;
const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

function initialBoard() {
  const board = Array.from({ length: COLS * ROWS }, () => []);
  for (let c = 0; c < COLS; c++) { board[idx(0, c)] = [1]; board[idx(ROWS - 1, c)] = [2]; }
  return board;
}
function topColor(stack) { return stack.length ? stack[stack.length - 1] : 0; }

// そのプレイヤーが選べる駒ごとに、動ける先（通常のマス、またはゴール）を返す
function legalMoves(board, player) {
  const moves = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const from = idx(r, c);
      if (topColor(board[from]) !== player) continue;
      for (const [dr, dc] of DIRS) {
        const nc = c + dc;
        if (nc < 0 || nc >= COLS) continue; // 左右の外にはゴールがない
        const nr = r + dr;
        if (nr < 0) { if (player === 2) moves.push({ from, exit: true }); continue; } // player1 は自分のゴール側で出られない
        if (nr >= ROWS) { if (player === 1) moves.push({ from, exit: true }); continue; } // player2 は自分のゴール側で出られない
        const to = idx(nr, nc);
        if (board[to].length < 3) moves.push({ from, to });
      }
    }
  }
  return moves;
}
function other(p) { return p === 1 ? 2 : 1; }

// ---- CPU（ai.js を Worker で動かす） ----
const cpu = new Worker('./ai.js', { type: 'module' });
let cpuAsk = 0; // やり直したあとに前の局の答えが届いても使わない

let G = null; // 対局中の状態。null ならタイトル（モード選択）画面
let thinking = false;

function newGame(mode, strength) {
  G = { mode, strength: strength || load('strength', 'mid'), board: initialBoard(), turn: 1, winner: null, draw: false, sel: null, moveCount: 0 };
  thinking = false;
  render();
  maybeCpuTurn();
}
function playerLabel(p) {
  if (G.mode === 'cpuvcpu') return p === 1 ? 'CPU 1' : 'CPU 2';
  if (G.mode === 'cpu') return p === 1 ? 'あなた' : 'CPU';
  return p === 1 ? '1人目' : '2人目';
}
function isCpuControlled(p) { return G.mode === 'cpuvcpu' || (G.mode === 'cpu' && p === 2); }
function isCpuTurn() { return isCpuControlled(G.turn); }
function canInteract() { return !G.winner && !G.draw && !thinking && !isCpuTurn(); }

const CPUVCPU_MOVE_LIMIT = 200; // 終わらない対局を止める

function applyMove(mv) {
  const mover = G.turn;
  G.moveCount++;
  if (mv.exit) {
    G.board[mv.from] = G.board[mv.from].slice(0, -1); // 盤からは消える（ゴールへ出た）
    G.winner = mover;
  } else {
    G.board[mv.to].push(G.board[mv.from].pop());
    G.turn = other(mover);
    if (legalMoves(G.board, G.turn).length === 0) G.winner = mover; // 次の人が動けない
    else if (G.mode === 'cpuvcpu' && G.moveCount >= CPUVCPU_MOVE_LIMIT) G.draw = true;
  }
  beep(!!G.winner);
  G.sel = null;
  render();
  maybeCpuTurn();
}

function onCellTap(i) {
  if (!canInteract()) return;
  if (G.sel == null) {
    if (topColor(G.board[i]) !== G.turn) return;
    G.sel = i;
    render();
    return;
  }
  if (i === G.sel) { G.sel = null; render(); return; }
  if (topColor(G.board[i]) === G.turn) { G.sel = i; render(); return; } // 選び直し
  const moves = legalMoves(G.board, G.turn).filter((m) => m.from === G.sel && !m.exit);
  const mv = moves.find((m) => m.to === i);
  if (mv) applyMove(mv);
}
function onGoalTap(forPlayer) {
  if (!canInteract() || G.sel == null || forPlayer !== G.turn) return;
  const mv = legalMoves(G.board, G.turn).find((m) => m.from === G.sel && m.exit);
  if (mv) applyMove(mv);
}

function maybeCpuTurn() {
  if (!G || G.winner || G.draw || !isCpuTurn()) return;
  thinking = true;
  render();
  const game = G;
  const id = ++cpuAsk;
  // CPU 同士の観戦は手が追えるよう長めに間をあける（最強は考える時間そのものが間になる）
  const delay = G.mode === 'cpuvcpu' ? 500 : 200;
  cpu.onmessage = (e) => {
    if (e.data.id !== cpuAsk || G !== game) return;
    setTimeout(() => {
      if (G !== game) return;
      thinking = false;
      applyMove(e.data.mv);
    }, delay);
  };
  cpu.postMessage({ id, board: G.board, player: G.turn, strength: G.strength });
}

// ---- 3D の盤（three.js）。盤も駒も磨いた大理石 ----
const canvas = document.createElement('canvas');
canvas.className = 'board3d__canvas';
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
camera.position.set(0, 7, 6.6);
const controls = new OrbitControls(camera, canvas);
controls.enablePan = false;
controls.minDistance = 4;
controls.maxDistance = 16;
controls.maxPolarAngle = Math.PI / 2 - 0.05; // 盤の下にはもぐらない
controls.target.set(0, 0.3, 0);
controls.update();
controls.addEventListener('change', draw);

scene.add(new THREE.HemisphereLight(0xf4f6fa, 0x3a3c40, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(3, 8, 4);
scene.add(sun);

// 大理石の模様。ゆらいだ縞（fbm で曲げた sin）を筋にして、地の色に筋の色を混ぜる
function marbleTexture(base, vein, S = 256) {
  const N = 8, lat = Array.from({ length: N * N }, Math.random);
  const at = (x, y) => lat[((y % N + N) % N) * N + ((x % N + N) % N)];
  const smooth = (t) => t * t * (3 - 2 * t);
  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), u = smooth(x - xi), v = smooth(y - yi);
    const a = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * u;
    const b = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * u;
    return a + (b - a) * v;
  };
  const fbm = (x, y) => { let s = 0, amp = 0.5; for (let o = 0; o < 4; o++) { s += amp * noise(x, y); x *= 2; y *= 2; amp /= 2; } return s; };
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const B = new THREE.Color(base), V = new THREE.Color(vein);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = (x / S) * N / 2, w = (y / S) * N / 2;
      const t = Math.abs(Math.sin((x + y * 0.7) / S * Math.PI * 3 + fbm(u, w) * 9));
      const k = Math.min(1, Math.pow(1 - t, 10) * 0.9 + Math.pow(1 - t, 3) * 0.12 + (fbm(u * 4, w * 4) - 0.5) * 0.12);
      const p = (y * S + x) * 4;
      img.data[p] = 255 * (B.r + (V.r - B.r) * k);
      img.data[p + 1] = 255 * (B.g + (V.g - B.g) * k);
      img.data[p + 2] = 255 * (B.b + (V.b - B.b) * k);
      img.data[p + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
const marble = (base, vein, o = {}) => new THREE.MeshPhysicalMaterial({
  map: marbleTexture(base, vein), roughness: 0.22, clearcoat: 0.6, clearcoatRoughness: 0.15, envMapIntensity: 0.8, ...o,
});

const BOARD_W = COLS + 0.8, BOARD_D = ROWS + 0.8;
const board = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W, 0.36, BOARD_D), marble(0x3b3d40, 0x9a9da3));
board.position.y = -0.18;
scene.add(board);

// ---- 盤の下に大きな大理石の床を敷き、ふちを背景へ溶かす ----
{
  const w = Math.max(BOARD_W, BOARD_D);
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.drawImage(marbleTexture(0x2a2c30, 0x5d6067, S).image, 0, 0);
  const r = S / 2, inner = (w * 0.62) / (w * 3.2);
  const fade = g.createRadialGradient(r, r, 0, r, r, r);
  fade.addColorStop(0, '#000'); fade.addColorStop(inner, 'rgba(0, 0, 0, 0.9)'); fade.addColorStop(1, 'rgba(0, 0, 0, 0)');
  g.globalCompositeOperation = 'destination-in';
  g.fillStyle = fade; g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const table = new THREE.Mesh(new THREE.PlaneGeometry(w * 3.2, w * 3.2),
    new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 0.3, envMapIntensity: 0.5 }));
  table.rotation.x = -Math.PI / 2;
  table.position.y = -0.18 - 0.18 - 0.01;
  table.renderOrder = -1;
  scene.add(table);
}

// ホーム画面では盤をゆっくり回して見せる。対局に入ったら最初の向きに戻す
{
  const HOME_CAM = camera.position.clone();
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  let wasHome = false;
  controls.autoRotateSpeed = 0.6;
  const spin = () => {
    const home = !!canvas.offsetParent && !!canvas.closest('.title');
    controls.autoRotate = home && !still.matches;
    if (controls.autoRotate) controls.update();
    else if (wasHome && !home) { camera.position.copy(HOME_CAM); controls.update(); }
    wasHome = home;
    requestAnimationFrame(spin);
  };
  requestAnimationFrame(spin);
}

function cellX(i) { return colOf(i) - (COLS - 1) / 2; }
function cellZ(i) { return rowOf(i) - (ROWS - 1) / 2; }
// ゴールの帯の位置（奥へ 1 マス分）
const GOAL_Z = { 1: cellZ(idx(ROWS - 1, 0)) + 1, 2: cellZ(idx(0, 0)) - 1 };

const CELL_MAT = [marble(0xb9b4ab, 0x7d7871, { clearcoat: 0.3 }), marble(0x8e8a84, 0x5f5b56, { clearcoat: 0.3 })]; // 市松に濃淡
const cellGeo = new THREE.BoxGeometry(0.94, 0.03, 0.94);
const cellMeshes = [...Array(COLS * ROWS).keys()].map((i) => {
  const shade = (rowOf(i) + colOf(i)) % 2;
  const m = new THREE.Mesh(cellGeo, CELL_MAT[shade]);
  m.position.set(cellX(i), 0.016, cellZ(i));
  m.userData.cell = i;
  scene.add(m);
  return m;
});
// ゴールの帯（手前・奥の外側）
const goalGeo = new THREE.BoxGeometry(BOARD_W - 0.1, 0.03, 0.8);
const goalMat = (color) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28 });
const GOAL_COLOR = { 1: 0xffffff, 2: 0x111111 };
const goalMeshes = {};
for (const p of [1, 2]) {
  const m = new THREE.Mesh(goalGeo, goalMat(GOAL_COLOR[p]));
  m.position.set(0, 0.016, GOAL_Z[p]);
  m.userData.goal = p;
  m.visible = false;
  scene.add(m);
  goalMeshes[p] = m;
}

// 駒：先手は白、後手は黒の大理石の立方体
const CHIP_H = 0.56;
const CHIP_GEO = new THREE.BoxGeometry(CHIP_H, CHIP_H, CHIP_H);
const CHIP_MAT = { 1: marble(0xf4f2ee, 0x9c9ea4), 2: marble(0x17181b, 0x8a8d94) };
function chipMesh(color) { return new THREE.Mesh(CHIP_GEO, CHIP_MAT[color]); }

// 選べる・動ける・いま選んでいる、の強調は床に薄いリングを重ねて出す
const ringGeo = new THREE.RingGeometry(0.4, 0.46, 36);
function ringMat(color, opacity) { return new THREE.MeshBasicMaterial({ color, transparent: true, opacity }); }
const RING_STYLE = {
  pickable: ringMat(0xffd35c, 0.3),
  legal: ringMat(0xffd35c, 0.85),
  cur: ringMat(0xffffff, 0.8),
};
function highlightMesh(kind, i) {
  const m = new THREE.Mesh(ringGeo, RING_STYLE[kind]);
  m.rotation.x = -Math.PI / 2;
  m.position.set(cellX(i), 0.035, cellZ(i));
  m.userData.cell = i;
  return m;
}
function cellHighlight(i) {
  if (!G) return null;
  if (G.sel === i) return 'cur';
  if (G.sel != null && canInteract()) {
    const moves = legalMoves(G.board, G.turn).filter((m) => m.from === G.sel && !m.exit);
    if (moves.some((m) => m.to === i)) return 'legal';
  }
  if (G.sel == null && canInteract() && topColor(G.board[i]) === G.turn) return 'pickable';
  return null;
}

let pieceGroup = new THREE.Group();
scene.add(pieceGroup);
function syncScene(b = G ? G.board : DEMO) {
  scene.remove(pieceGroup);
  pieceGroup = new THREE.Group();
  b.forEach((stack, i) => {
    stack.forEach((color, h) => {
      const m = chipMesh(color);
      m.position.set(cellX(i), (h + 0.5) * CHIP_H + 0.03, cellZ(i));
      m.userData.cell = i;
      pieceGroup.add(m);
    });
    const kind = cellHighlight(i);
    if (kind) pieceGroup.add(highlightMesh(kind, i));
  });
  scene.add(pieceGroup);
  for (const p of [1, 2]) {
    const canExit = !!G && G.sel != null && canInteract() && legalMoves(G.board, G.turn).some((m) => m.from === G.sel && m.exit && G.turn === p);
    goalMeshes[p].visible = canExit;
  }
  draw();
}

function draw() { renderer.render(scene, camera); }
new ResizeObserver(() => {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = w < h ? (2 * Math.atan(Math.tan((19 * Math.PI) / 180) * (h / w)) * 180) / Math.PI : 38;
  camera.updateProjectionMatrix();
  draw();
}).observe(canvas);

// 動かさずに離したらタップ（ドラッグは回転）
let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
  downAt = null;
  if (!G) return;
  const r = canvas.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const goals = Object.values(goalMeshes).filter((m) => m.visible);
  const hit = ray.intersectObjects([...cellMeshes, ...goals, pieceGroup, board], true)[0];
  if (!hit) return;
  if (hit.object.userData.goal != null) return onGoalTap(hit.object.userData.goal);
  if (hit.object.userData.cell != null) return onCellTap(hit.object.userData.cell);
  // マスのすき間や盤のふちは、いちばん近いマスとして扱う
  const c = Math.round(hit.point.x + (COLS - 1) / 2), rw = Math.round(hit.point.z + (ROWS - 1) / 2);
  if (c >= 0 && c < COLS && rw >= 0 && rw < ROWS) onCellTap(idx(rw, c));
});

// ---- ルール画面（本物の盤の図つき。overlay の <dialog> で対局・タイトルの上に重ねる） ----
// 図は 5×6 マスを上から見た SVG。駒は var(--p1)/var(--p2) で chip--a/b と同じ色にする
function arrowSvg(x1, y1, x2, y2) {
  const ang = Math.atan2(y2 - y1, x2 - x1), shrink = 10, ah = 5;
  const ex = x2 - Math.cos(ang) * shrink, ey = y2 - Math.sin(ang) * shrink;
  const p1 = [ex - ah * Math.cos(ang - 0.5), ey - ah * Math.sin(ang - 0.5)];
  const p2 = [ex - ah * Math.cos(ang + 0.5), ey - ah * Math.sin(ang + 0.5)];
  return `<line x1="${x1}" y1="${y1}" x2="${ex}" y2="${ey}" stroke="var(--accent)" stroke-width="2"/>
    <polygon points="${ex},${ey} ${p1[0]},${p1[1]} ${p2[0]},${p2[1]}" fill="var(--accent)"/>`;
}
function xMarkSvg(x, y) {
  return `<line x1="${x - 8}" y1="${y - 8}" x2="${x + 8}" y2="${y + 8}" stroke="#e06464" stroke-width="3"/>
    <line x1="${x - 8}" y1="${y + 8}" x2="${x + 8}" y2="${y - 8}" stroke="#e06464" stroke-width="3"/>`;
}
function ruleSvg({ pieces = [], arrows = [], marks = [], goalBottom = false }) {
  const CS = 28, GB = 22, w = COLS * CS, h = ROWS * CS;
  const totalH = h + (goalBottom ? GB : 0);
  const cx = (c) => c * CS + CS / 2;
  const cy = (r) => (r >= ROWS ? h + GB / 2 : r * CS + CS / 2); // r===ROWS はゴールの帯
  let s = `<svg viewBox="0 0 ${w} ${totalH}">`;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    s += `<rect x="${c * CS}" y="${r * CS}" width="${CS}" height="${CS}" fill="${(r + c) % 2 ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.02)'}" stroke="rgba(255,255,255,0.15)"/>`;
  }
  if (goalBottom) s += `<rect x="0" y="${h}" width="${w}" height="${GB}" fill="var(--p1)" opacity="0.18"/>`;
  for (const { r, c, stack } of pieces) {
    stack.forEach((color, k) => {
      s += `<circle cx="${cx(c)}" cy="${cy(r) - k * 4}" r="9" fill="var(--p${color})" stroke="rgba(0,0,0,0.4)"/>`;
    });
    if (stack.length > 1) s += `<text x="${cx(c) + 9}" y="${cy(r) - stack.length * 4 + 5}" font-size="10" fill="var(--accent)">${stack.length}</text>`;
  }
  for (const [[r1, c1], [r2, c2]] of arrows) s += arrowSvg(cx(c1), cy(r1), cx(c2), cy(r2));
  for (const [r, c] of marks) s += xMarkSvg(cx(c), cy(r));
  return s + '</svg>';
}
function ruleItemHTML(title, svgOpts, text) {
  return `<section class="rules__item"><h3>${title}</h3>${ruleSvg(svgOpts)}<p>${text}</p></section>`;
}
const rulesDialog = document.createElement('dialog');
rulesDialog.className = 'rules';
rulesDialog.innerHTML = `
  <div class="rules__body">
    <h2>あそびかた</h2>
    ${ruleItemHTML('1. はじめの並び',
      { pieces: [...Array(COLS).keys()].flatMap((c) => [{ r: 0, c, stack: [1] }, { r: ROWS - 1, c, stack: [2] }]) },
      '白（先手）は奥の列に、黒（後手）は手前の列に5個ずつ並べて始めます。')}
    ${ruleItemHTML('2. 動かし方',
      { pieces: [{ r: 2, c: 2, stack: [1] }], arrows: DIRS.map(([dr, dc]) => [[2, 2], [2 + dr, 2 + dc]]) },
      '自分の色が一番上の駒を1つ選び、縦横斜め8方向のどれかへ1マス動かします。')}
    ${ruleItemHTML('3. 積む',
      { pieces: [{ r: 3, c: 1, stack: [1, 2] }, { r: 2, c: 3, stack: [2] }, { r: 3, c: 3, stack: [1, 2, 1] }],
        arrows: [[[2, 3], [3, 3]]], marks: [[3, 3]] },
      '駒の上には、相手の駒にも自分の駒にも乗れます（3段まで）。3段の山には乗れず、山の一番上の色の人だけがその山を動かせます。')}
    ${ruleItemHTML('4. 勝ち方',
      { pieces: [{ r: 5, c: 2, stack: [1] }, { r: 5, c: 4, stack: [1] }],
        arrows: [[[5, 2], [ROWS, 2]], [[5, 4], [ROWS, 3]]], goalBottom: true },
      '相手側の一番奥の列から、さらに奥（ゴール）へ1マス進めたら勝ちです（斜めでもかまいません）。自分側の外へは出られません。')}
    ${ruleItemHTML('5. 動けなくなったら負け',
      { pieces: [[1, 1], [1, 3], [3, 0], [3, 2], [4, 4]].map(([r, c]) => ({ r, c, stack: [1, 2] })),
        marks: [[1, 1], [1, 3], [3, 0], [3, 2], [4, 4]] },
      '自分の駒が全部相手に乗られるなどして、動かせる駒が1つもなくなったら、その場で負けです（図は白の負け）。')}
    <button class="pill pill--big" data-rules-close>戻る</button>
  </div>`;
document.body.appendChild(rulesDialog);
rulesDialog.querySelector('[data-rules-close]').addEventListener('click', () => rulesDialog.close());
function bindRulesButtons() {
  document.querySelectorAll('[data-rules]').forEach((b) => b.addEventListener('click', () => rulesDialog.showModal()));
}

// ---- 画面 ----
function render() {
  const stage = document.getElementById('stage');
  if (!G) {
    stage.innerHTML = titleHTML();
    document.getElementById('board3d').appendChild(canvas);
    syncScene(DEMO);
    bindTitle();
    return;
  }
  stage.innerHTML = gameHTML();
  document.getElementById('board3d').appendChild(canvas);
  syncScene();
  bindGame();
}

// タイトル画面に出す見本の局面（中盤）
const DEMO = (() => {
  const b = initialBoard();
  b[idx(1, 1)] = [1]; b[idx(0, 1)] = [];
  b[idx(2, 3)] = [1, 2]; b[idx(5, 3)] = [];
  b[idx(4, 2)] = [2]; b[idx(5, 2)] = [];
  return b;
})();

function titleHTML() {
  const strength = load('strength', 'mid');
  return `
    <div class="title">
      <h2>NOCCA*NOCCA</h2>
      <p class="hint">自分の駒を縦横斜めに1マス動かす。駒の上に乗ってもよい（3段まで）。相手側の奥の列からさらに奥（ゴール）へ進めたら勝ち。</p>
      <div class="board3d" id="board3d"></div>
      <div class="opts">
        <label>CPU の強さ
          <select id="strength">
            <option value="weak"${strength === 'weak' ? ' selected' : ''}>よわい</option>
            <option value="mid"${strength === 'mid' ? ' selected' : ''}>ふつう</option>
            <option value="strong"${strength === 'strong' ? ' selected' : ''}>最強</option>
          </select>
        </label>
      </div>
      <button class="pill pill--big" data-start="cpu">CPU と対戦</button>
      <button class="pill pill--big" data-start="2p">2人で対戦（1台で交互）</button>
      <button class="pill pill--big" data-start="cpuvcpu">CPU 同士の対戦を見る</button>
      <button class="pill" data-rules>ルール</button>
    </div>`;
}
function bindTitle() {
  const strengthSelect = document.getElementById('strength');
  strengthSelect.addEventListener('change', () => save('strength', strengthSelect.value));
  document.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', () => newGame(b.dataset.start, strengthSelect.value)));
  bindRulesButtons();
}

function statusText() {
  if (thinking) return `${playerLabel(G.turn)} が考え中…`;
  if (G.draw) return '引き分け';
  if (G.winner) return `${playerLabel(G.winner)} の勝ち！`;
  return `${playerLabel(G.turn)} の番：${G.sel == null ? '動かす駒をえらぶ' : '行き先をえらぶ'}`;
}
function gameHTML() {
  const handsRow = `
    <div class="hands">
      <span class="hands__p${G.turn === 1 && !G.winner ? ' hands__p--on' : ''}"><span class="chip chip--a"></span>${playerLabel(1)}</span>
      <span class="hands__p${G.turn === 2 && !G.winner ? ' hands__p--on' : ''}"><span class="chip chip--b"></span>${playerLabel(2)}</span>
    </div>`;
  const result = (G.winner || G.draw) ? `
    <div class="result">
      <button class="pill pill--big" data-again>もう一度</button>
      <button class="pill" data-title>モードを選び直す</button>
    </div>` : '';
  return `
    <div class="game">
      <div class="topbar">
        <button class="pill pill--home" data-title>ホーム</button>
        <button class="pill pill--home" data-rules>ルール</button>
        <p class="status">${statusText()}</p>
      </div>
      ${handsRow}
      <div class="board3d${thinking ? ' board3d--busy' : ''}" id="board3d"></div>
      <p class="hint">ドラッグで回す・ピンチで寄る</p>
      ${result}
    </div>`;
}
function bindGame() {
  const again = document.querySelector('[data-again]');
  if (again) again.addEventListener('click', () => newGame(G.mode, G.strength));
  document.querySelectorAll('[data-title]').forEach((b) => b.addEventListener('click', goHome));
  bindRulesButtons();
}
// 対局・観戦画面の「ホーム」。決着済み（勝ち負け・引き分け）や観戦中は確認なしで戻る
function goHome() {
  const settled = !!G.winner || !!G.draw;
  if (!settled && G.mode !== 'cpuvcpu' && confirm('対局をやめてホームに戻りますか？') === false) return;
  G = null;
  thinking = false;
  render();
}

render();
