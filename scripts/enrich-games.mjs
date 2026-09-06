import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const snapshotPath = path.resolve(process.env.SCAN_OUTPUT || path.join(root, 'scan-results.json'));
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'Playerok-Roblox-game-scanner/1.0' }
      });
      if (response.ok) return response.json();
      const body = await response.text();
      lastError = new Error(`${response.status} ${body}`);
      if (![429, 500, 502, 503, 504].includes(response.status)) throw lastError;
    } catch (error) {
      lastError = error;
    }
    await sleep(Math.min(15000, 1000 * attempt * attempt));
  }
  throw lastError;
}

const universeIds = [...new Set(Object.values(snapshot.items)
  .flatMap(item => item.universeIds ?? [])
  .filter(Number.isFinite))];
const games = {};
for (let index = 0; index < universeIds.length; index += 50) {
  const chunk = universeIds.slice(index, index + 50);
  const payload = await getJson(`https://games.roblox.com/v1/games?universeIds=${chunk.join(',')}`);
  for (const game of payload.data ?? []) {
    games[String(game.id)] = {
      universeId: game.id,
      rootPlaceId: game.rootPlaceId,
      name: game.name,
      playing: game.playing,
      updated: game.updated,
      url: `https://www.roblox.com/games/${game.rootPlaceId}`
    };
  }
  if (index + 50 < universeIds.length) await sleep(1100);
}

for (const game of Object.values(games)) {
  const linked = Object.values(snapshot.items).filter(item => item.universeIds?.includes(game.universeId));
  game.itemCount = linked.length;
  game.availableItemCount = linked.filter(item => item.status === 'available').length;
  game.knownRemaining = linked.reduce((sum, item) => sum + (Number.isFinite(item.remaining) ? item.remaining : 0), 0);
}

snapshot.games = games;
const discoveredGameUrls = snapshot.discovered?.items?.map(item => item.gameUrl).filter(Boolean) ?? [];
snapshot.summary.games = new Set([
  ...Object.values(games).map(game => game.url),
  ...discoveredGameUrls
]).size;
const tempPath = `${snapshotPath}.tmp`;
fs.writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
fs.renameSync(tempPath, snapshotPath);
console.log(JSON.stringify({ games: snapshot.summary.games }, null, 2));
