const RTP_CONFIG = {
  AO_SCALE: 0.9453,
  DH_SCALE: 1.3466,
  SB_SCALE: 2.3452,
  AO_SCATTER_BASE: 0.016,
  AO_SCATTER_ANTE: 0.0198,
  AO_SCATTER_FS: 0.011,
  SB_SCATTER_BASE: 0.016,
  SB_SCATTER_ANTE: 0.022,
  SB_SCATTER_FS: 0.011,
  AO_BUY_COST_X: 75.8,
  SB_BUY_COST_X: 31.6,
  MAX_WIN_MULT: 5000
};

function round2(n) {
  return Math.round(n * 100) / 100;
}

function capWin(win, bet, alreadyWon = 0) {
  if (!Number.isFinite(win) || win <= 0) return 0;
  const maxLeft = Math.max(0, bet * RTP_CONFIG.MAX_WIN_MULT - alreadyWon);
  return round2(Math.min(win, maxLeft));
}

function pickWeighted(items, weightFn) {
  const total = items.reduce((s, it) => s + weightFn(it), 0);
  let r = Math.random() * total;
  for (const it of items) {
    r -= weightFn(it);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

// ================= GATES OF OLYMPUS =================
const AO_SYMBOLS = [
  { id: 'crown', p8: 6.5, p10: 15.0, p12: 32.0, weight: 7 },
  { id: 'hourglass', p8: 1.8, p10: 6.5, p12: 16.0, weight: 10 },
  { id: 'ring', p8: 1.2, p10: 3.2, p12: 10.0, weight: 14 },
  { id: 'cup', p8: 0.95, p10: 1.5, p12: 8.0, weight: 18 },
  { id: 'red_gem', p8: 0.60, p10: 1.0, p12: 6.0, weight: 26 },
  { id: 'purple', p8: 0.45, p10: 0.80, p12: 4.5, weight: 32 },
  { id: 'yellow', p8: 0.30, p10: 0.60, p12: 3.0, weight: 38 },
  { id: 'green', p8: 0.22, p10: 0.45, p12: 2.0, weight: 44 },
  { id: 'blue', p8: 0.15, p10: 0.35, p12: 1.2, weight: 50 }
];
const AO_MULTS = [
  { val: 2, weight: 62 }, { val: 3, weight: 28 }, { val: 4, weight: 12 },
  { val: 5, weight: 6 }, { val: 6, weight: 3 }, { val: 8, weight: 1.5 },
  { val: 10, weight: 0.8 }, { val: 15, weight: 0.25 }, { val: 25, weight: 0.08 },
  { val: 50, weight: 0.02 }, { val: 100, weight: 0.006 }, { val: 500, weight: 0.0003 }
];

function genAoCell(inFS, ante) {
  const scChance = inFS ? RTP_CONFIG.AO_SCATTER_FS : (ante ? RTP_CONFIG.AO_SCATTER_ANTE : RTP_CONFIG.AO_SCATTER_BASE);
  if (Math.random() < scChance) return { id: 'scatter' };
  const multChance = inFS ? 0.038 : 0.015;
  if (Math.random() < multChance) {
    return { id: 'multiplier', val: pickWeighted(AO_MULTS, m => m.weight).val };
  }
  return { id: pickWeighted(AO_SYMBOLS, s => s.weight).id };
}

function playOlympusSpin({ baseBet, ante, inFS, totalMultiplier, fsTotalWin }) {
  const grid = Array.from({ length: 6 }, () => Array.from({ length: 5 }, () => genAoCell(inFS, ante)));
  const initialGrid = grid.map(col => col.map(c => ({ ...c })));
  const cascades = [];
  let spinRawWin = 0;

  while (true) {
    const counts = {};
    const positions = {};
    for (let c = 0; c < 6; c++) {
      for (let r = 0; r < 5; r++) {
        const cell = grid[c][r];
        if (!cell || cell.id === 'scatter' || cell.id === 'multiplier') continue;
        counts[cell.id] = (counts[cell.id] || 0) + 1;
        if (!positions[cell.id]) positions[cell.id] = [];
        positions[cell.id].push({ c, r });
      }
    }

    let stepWin = 0;
    const winningCoords = [];
    for (const id of Object.keys(counts)) {
      const cnt = counts[id];
      if (cnt >= 8) {
        const sym = AO_SYMBOLS.find(s => s.id === id);
        const mult = cnt >= 12 ? sym.p12 : (cnt >= 10 ? sym.p10 : sym.p8);
        stepWin += baseBet * mult * RTP_CONFIG.AO_SCALE;
        winningCoords.push(...positions[id]);
      }
    }
    if (winningCoords.length === 0) break;

    spinRawWin += stepWin;
    winningCoords.forEach(({ c, r }) => { grid[c][r] = null; });

    for (let c = 0; c < 6; c++) {
      const surviving = [];
      for (let r = 4; r >= 0; r--) if (grid[c][r] !== null) surviving.push(grid[c][r]);
      const missing = 5 - surviving.length;
      const newTop = Array.from({ length: missing }, () => genAoCell(inFS, ante));
      const rebuilt = [...surviving, ...newTop].reverse();
      for (let r = 0; r < 5; r++) grid[c][r] = rebuilt[r];
    }

    cascades.push({
      winningCoords,
      stepWin: round2(stepWin),
      nextGrid: grid.map(col => col.map(c => ({ ...c })))
    });
  }

  let spinMultSum = 0;
  if (spinRawWin > 0) {
    for (let c = 0; c < 6; c++) {
      for (let r = 0; r < 5; r++) {
        if (grid[c][r] && grid[c][r].id === 'multiplier') spinMultSum += grid[c][r].val;
      }
    }
  }

  let newTotalMultiplier = totalMultiplier || 0;
  if (inFS && spinRawWin > 0 && spinMultSum > 0) newTotalMultiplier += spinMultSum;

  let appliedMult = 1;
  if (spinRawWin > 0) {
    appliedMult = inFS ? Math.max(1, newTotalMultiplier) : (spinMultSum > 0 ? spinMultSum : 1);
  }

  let scatterCount = 0;
  for (let c = 0; c < 6; c++) {
    for (let r = 0; r < 5; r++) if (grid[c][r] && grid[c][r].id === 'scatter') scatterCount++;
  }

  let scatterPayout = 0;
  if (scatterCount >= 4) {
    const scMult = scatterCount >= 6 ? 100 : (scatterCount === 5 ? 5 : 3);
    scatterPayout = baseBet * scMult * RTP_CONFIG.AO_SCALE;
  }

  const finalWin = capWin(spinRawWin * appliedMult + scatterPayout, baseBet, inFS ? fsTotalWin : 0);
  const triggeredFS = !inFS && scatterCount >= 4 ? 15 : 0;
  const retriggerFS = inFS && scatterCount >= 3 ? 5 : 0;

  return {
    initialGrid,
    cascades,
    finalGrid: grid,
    spinMultSum,
    newTotalMultiplier,
    finalWin,
    scatterCount,
    triggeredFS,
    retriggerFS
  };
}

// ================= THE DOG HOUSE =================
const DH_PAYLINES = [
  [{c:0,r:1},{c:1,r:1},{c:2,r:1},{c:3,r:1},{c:4,r:1}],
  [{c:0,r:0},{c:1,r:0},{c:2,r:0},{c:3,r:0},{c:4,r:0}],
  [{c:0,r:2},{c:1,r:2},{c:2,r:2},{c:3,r:2},{c:4,r:2}],
  [{c:0,r:0},{c:1,r:1},{c:2,r:2},{c:3,r:1},{c:4,r:0}],
  [{c:0,r:2},{c:1,r:1},{c:2,r:0},{c:3,r:1},{c:4,r:2}],
  [{c:0,r:0},{c:1,r:0},{c:2,r:1},{c:3,r:2},{c:4,r:2}],
  [{c:0,r:2},{c:1,r:2},{c:2,r:1},{c:3,r:0},{c:4,r:0}],
  [{c:0,r:1},{c:1,r:0},{c:2,r:0},{c:3,r:0},{c:4,r:1}],
  [{c:0,r:1},{c:1,r:2},{c:2,r:2},{c:3,r:2},{c:4,r:1}],
  [{c:0,r:0},{c:1,r:1},{c:2,r:1},{c:3,r:1},{c:4,r:0}],
  [{c:0,r:2},{c:1,r:1},{c:2,r:1},{c:3,r:1},{c:4,r:2}],
  [{c:0,r:0},{c:1,r:0},{c:2,r:1},{c:3,r:0},{c:4,r:0}],
  [{c:0,r:2},{c:1,r:2},{c:2,r:1},{c:3,r:2},{c:4,r:2}],
  [{c:0,r:1},{c:1,r:0},{c:2,r:1},{c:3,r:0},{c:4,r:1}],
  [{c:0,r:1},{c:1,r:2},{c:2,r:1},{c:3,r:2},{c:4,r:1}],
  [{c:0,r:0},{c:1,r:1},{c:2,r:0},{c:3,r:1},{c:4,r:0}],
  [{c:0,r:2},{c:1,r:1},{c:2,r:2},{c:3,r:1},{c:4,r:2}],
  [{c:0,r:0},{c:1,r:2},{c:2,r:0},{c:3,r:2},{c:4,r:0}],
  [{c:0,r:2},{c:1,r:0},{c:2,r:2},{c:3,r:0},{c:4,r:2}],
  [{c:0,r:1},{c:1,r:1},{c:2,r:0},{c:3,r:1},{c:4,r:1}]
];
const DH_SYMBOLS = [
  { id: 'rottweiler', p3: 2.1, p4: 6.2, p5: 30.0 },
  { id: 'shitzu', p3: 1.5, p4: 4.1, p5: 20.5 },
  { id: 'pug', p3: 1.05, p4: 2.5, p5: 12.5 },
  { id: 'dachshund', p3: 0.85, p4: 1.55, p5: 8.2 },
  { id: 'collar', p3: 0.5, p4: 1.05, p5: 6.2 },
  { id: 'bone', p3: 0.32, p4: 0.78, p5: 4.2 },
  { id: 'ace', p3: 0.25, p4: 0.5, p5: 2.5 },
  { id: 'king', p3: 0.25, p4: 0.5, p5: 2.5 },
  { id: 'queen', p3: 0.1, p4: 0.25, p5: 1.25 },
  { id: 'jack', p3: 0.1, p4: 0.25, p5: 1.25 },
  { id: 'ten', p3: 0.1, p4: 0.25, p5: 1.25 }
];
const DH_W1 = { ten: 165, jack: 160, queen: 155, king: 140, ace: 135, bone: 85, collar: 68, dachshund: 44, pug: 29, shitzu: 17, rottweiler: 8 };
const DH_W_OTHER = { ten: 170, jack: 165, queen: 160, king: 145, ace: 140, bone: 91, collar: 73, dachshund: 47, pug: 31, shitzu: 18, rottweiler: 9 };

function genDhSym(col) {
  const wm = col === 0 ? DH_W1 : DH_W_OTHER;
  return { id: pickWeighted(DH_SYMBOLS, s => wm[s.id]).id };
}

function playDogHouseSpin({ baseBet, inFS, stickyWilds, fsTotalWin }) {
  const sticky = stickyWilds || Array.from({ length: 5 }, () => Array(3).fill(null));
  const grid = Array.from({ length: 5 }, () => Array(3).fill(null));

  for (let c = 0; c < 5; c++) {
    let hasScatterInCol = false;
    for (let r = 0; r < 3; r++) {
      if (inFS && sticky[c][r]) {
        grid[c][r] = sticky[c][r];
        continue;
      }
      const wildChance = inFS ? 0.025 : 0.085;
      if (c >= 1 && c <= 3 && Math.random() < wildChance) {
        const mult = Math.random() < 0.80 ? 2 : 3;
        const w = { id: 'wild', mult };
        grid[c][r] = w;
        if (inFS) sticky[c][r] = w;
      } else if (!inFS && !hasScatterInCol && (c === 0 || c === 2 || c === 4) && Math.random() < 0.06) {
        hasScatterInCol = true;
        grid[c][r] = { id: 'scatter' };
      } else {
        grid[c][r] = genDhSym(c);
      }
    }
  }

  let totalWin = 0;
  const winCells = new Set();
  for (const line of DH_PAYLINES) {
    const syms = line.map(pt => grid[pt.c][pt.r]);
    if (syms[0].id === 'scatter') continue;
    let targetId = null;
    for (let i = 0; i < 5; i++) {
      if (syms[i].id === 'scatter') break;
      if (syms[i].id !== 'wild') { targetId = syms[i].id; break; }
    }
    const target = DH_SYMBOLS.find(s => s.id === (targetId || 'rottweiler'));
    let matchCount = 0;
    let wildMultSum = 0;
    for (let i = 0; i < 5; i++) {
      if (syms[i].id === target.id || syms[i].id === 'wild') {
        matchCount++;
        if (syms[i].id === 'wild') wildMultSum += syms[i].mult;
      } else break;
    }
    if (matchCount >= 3) {
      const m = matchCount === 5 ? target.p5 : (matchCount === 4 ? target.p4 : target.p3);
      totalWin += baseBet * m * (wildMultSum > 0 ? wildMultSum : 1) * RTP_CONFIG.DH_SCALE;
      for (let i = 0; i < matchCount; i++) winCells.add(`${line[i].c}-${line[i].r}`);
    }
  }

  let scatterCount = 0;
  for (let c = 0; c < 5; c++) for (let r = 0; r < 3; r++) if (grid[c][r].id === 'scatter') scatterCount++;

  const scatterWin = (!inFS && scatterCount >= 3) ? baseBet * 5 * RTP_CONFIG.DH_SCALE : 0;
  const finalWin = capWin(totalWin + scatterWin, baseBet, inFS ? fsTotalWin : 0);

  let triggeredFS = 0;
  let introGrid = null;
  if (!inFS && scatterCount >= 3) {
    triggeredFS = 9 + Math.floor(Math.random() * 5);
    introGrid = Array(9).fill(1);
    let extra = triggeredFS - 9;
    while (extra > 0) {
      const idx = Math.floor(Math.random() * 9);
      if (introGrid[idx] < 3) { introGrid[idx]++; extra--; }
    }
  }

  return { grid, stickyWilds: sticky, winCells: Array.from(winCells), finalWin, scatterCount, triggeredFS, introGrid };
}

// ================= SWEET BONANZA =================
const SB_SYMBOLS = [
  { id: 'heart', p8: 6.5, p10: 15.0, p12: 32.0, weight: 7 },
  { id: 'purple', p8: 1.8, p10: 6.5, p12: 16.0, weight: 10 },
  { id: 'green', p8: 1.2, p10: 3.2, p12: 10.0, weight: 14 },
  { id: 'blue', p8: 0.95, p10: 1.5, p12: 8.0, weight: 18 },
  { id: 'apple', p8: 0.60, p10: 1.0, p12: 6.0, weight: 26 },
  { id: 'plum', p8: 0.45, p10: 0.80, p12: 4.5, weight: 32 },
  { id: 'melon', p8: 0.30, p10: 0.60, p12: 3.0, weight: 38 },
  { id: 'grape', p8: 0.22, p10: 0.45, p12: 2.0, weight: 44 },
  { id: 'banana', p8: 0.15, p10: 0.35, p12: 1.2, weight: 50 }
];
const SB_BOMBS = [
  { mult: 2, weight: 60 }, { mult: 3, weight: 28 }, { mult: 4, weight: 12 },
  { mult: 5, weight: 6 }, { mult: 8, weight: 3 }, { mult: 10, weight: 1.5 },
  { mult: 20, weight: 0.25 }, { mult: 50, weight: 0.04 }, { mult: 100, weight: 0.01 }
];

function genSbCell(inFS, ante) {
  const scChance = inFS ? RTP_CONFIG.SB_SCATTER_FS : (ante ? RTP_CONFIG.SB_SCATTER_ANTE : RTP_CONFIG.SB_SCATTER_BASE);
  if (Math.random() < scChance) return { id: 'scatter' };
  if (inFS && Math.random() < 0.038) return { id: 'bomb', mult: pickWeighted(SB_BOMBS, b => b.weight).mult };
  return { id: pickWeighted(SB_SYMBOLS, s => s.weight).id };
}

function playBonanzaSpin({ baseBet, ante, inFS, fsTotalWin, forceBonusScatter = false }) {
  const grid = Array.from({ length: 6 }, () => Array.from({ length: 5 }, () => genSbCell(inFS, ante)));
  if (forceBonusScatter) {
    grid[0][1] = { id: 'scatter' };
    grid[2][3] = { id: 'scatter' };
    grid[3][1] = { id: 'scatter' };
    grid[5][2] = { id: 'scatter' };
  }

  const initialGrid = grid.map(col => col.map(c => ({ ...c })));
  const cascades = [];
  let spinRawWin = 0;

  while (true) {
    const counts = {};
    const positions = {};
    for (let c = 0; c < 6; c++) {
      for (let r = 0; r < 5; r++) {
        const cell = grid[c][r];
        if (!cell || cell.id === 'scatter' || cell.id === 'bomb') continue;
        counts[cell.id] = (counts[cell.id] || 0) + 1;
        if (!positions[cell.id]) positions[cell.id] = [];
        positions[cell.id].push({ c, r });
      }
    }

    let stepWin = 0;
    const winningCoords = [];
    for (const id of Object.keys(counts)) {
      const cnt = counts[id];
      if (cnt >= 8) {
        const sym = SB_SYMBOLS.find(s => s.id === id);
        const mult = cnt >= 12 ? sym.p12 : (cnt >= 10 ? sym.p10 : sym.p8);
        stepWin += baseBet * mult * RTP_CONFIG.SB_SCALE;
        winningCoords.push(...positions[id]);
      }
    }
    if (winningCoords.length === 0) break;

    spinRawWin += stepWin;
    winningCoords.forEach(({ c, r }) => { grid[c][r] = null; });

    for (let c = 0; c < 6; c++) {
      const surviving = [];
      for (let r = 4; r >= 0; r--) if (grid[c][r] !== null) surviving.push(grid[c][r]);
      const missing = 5 - surviving.length;
      const newTop = Array.from({ length: missing }, () => genSbCell(inFS, ante));
      const rebuilt = [...surviving, ...newTop].reverse();
      for (let r = 0; r < 5; r++) grid[c][r] = rebuilt[r];
    }

    cascades.push({
      winningCoords,
      stepWin: round2(stepWin),
      nextGrid: grid.map(col => col.map(c => ({ ...c })))
    });
  }

  let bombMultSum = 0;
  if (spinRawWin > 0 && inFS) {
    for (let c = 0; c < 6; c++) {
      for (let r = 0; r < 5; r++) {
        if (grid[c][r] && grid[c][r].id === 'bomb') bombMultSum += grid[c][r].mult;
      }
    }
  }

  let scatterCount = 0;
  for (let c = 0; c < 6; c++) for (let r = 0; r < 5; r++) if (grid[c][r] && grid[c][r].id === 'scatter') scatterCount++;

  let scatterPayout = 0;
  if (!forceBonusScatter && scatterCount >= 4) {
    const scMult = scatterCount >= 6 ? 100 : (scatterCount === 5 ? 5 : 3);
    scatterPayout = baseBet * scMult * RTP_CONFIG.SB_SCALE;
  }

  const appliedMult = (spinRawWin > 0 && bombMultSum > 0) ? bombMultSum : 1;
  const finalWin = capWin(spinRawWin * appliedMult + scatterPayout, baseBet, inFS ? fsTotalWin : 0);
  const triggeredFS = !inFS && !forceBonusScatter && scatterCount >= 4 ? 10 : 0;
  const retriggerFS = inFS && scatterCount >= 3 ? 5 : 0;

  return { initialGrid, cascades, finalGrid: grid, bombMultSum, finalWin, scatterCount, triggeredFS, retriggerFS };
}

module.exports = { RTP_CONFIG, round2, playOlympusSpin, playDogHouseSpin, playBonanzaSpin };
