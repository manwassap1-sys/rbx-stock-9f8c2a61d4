import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const sourcePath = path.resolve(process.env.SCAN_SOURCE || path.join(root, 'catalog-source.json'));
const discoveredPath = path.resolve(process.env.DISCOVERY_OUTPUT || path.join(root, 'catalog-discovered.json'));
const outputPath = path.resolve(process.env.SCAN_OUTPUT || path.join(root, 'scan-results.json'));
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const sourceItems = Array.isArray(source) ? source : source.items;
const discoveredData = fs.existsSync(discoveredPath)
  ? JSON.parse(fs.readFileSync(discoveredPath, 'utf8'))
  : { items: [] };
const discoveredItems = discoveredData.items ?? [];
const allItems = [...new Map([...sourceItems, ...discoveredItems].map(item => [`${item.type}:${item.id}`, item])).values()];
const limit = Number.parseInt(process.env.SCAN_LIMIT || '', 10);
const items = Number.isFinite(limit) ? allItems.slice(0, Math.max(0, limit)) : allItems;
const incremental = process.env.SCAN_INCREMENTAL === '1';
const storedResults = fs.existsSync(outputPath)
  ? JSON.parse(fs.readFileSync(outputPath, 'utf8')).items ?? {}
  : {};
const previousResults = incremental ? storedResults : {};
const scanItems = incremental ? items.filter(item => !previousResults[`${item.type}:${item.id}`]) : items;
const assetDelay = Number(process.env.SCAN_ASSET_DELAY_MS || 560);
const bundleDelay = Number(process.env.SCAN_BUNDLE_DELAY_MS || 9000);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (!Array.isArray(items) || !items.length) throw new Error('Catalog source is empty');

async function getJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'Playerok-Roblox-stock-scanner/1.0'
        }
      });
      if (response.ok) return response.json();
      const body = await response.text();
      lastError = new Error(`${response.status} ${body}`);
      lastError.status = response.status;
      if (![429, 500, 502, 503, 504].includes(response.status)) throw lastError;
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) await sleep(retryAfter * 1000);
    } catch (error) {
      lastError = error;
    }
    await sleep(Math.min(20000, 900 * attempt * attempt));
  }
  throw lastError;
}

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function classify({ method, isForSale, priceInRobux, remaining, limited }) {
  if (['code', 'quest', 'game', 'game-volatile'].includes(method)) {
    if (limited && remaining === 0) return 'soldout';
    return 'available';
  }
  if (!isForSale) return 'offsale';
  if (priceInRobux !== 0) return 'paid';
  if (limited && remaining === 0) return 'soldout';
  return 'available';
}

function changed(item, result) {
  if (result.status !== 'available') return true;
  if (Number.isFinite(item.remaining) && Number.isFinite(result.remaining)) {
    return item.remaining !== result.remaining;
  }
  return false;
}

async function scanAsset(item) {
  const data = await getJson(`https://economy.roblox.com/v2/assets/${item.id}/details`);
  const limited = Boolean(data.CollectiblesItemDetails?.IsLimited || data.IsLimitedUnique);
  const remaining = limited ? finite(data.Remaining) : null;
  const total = limited ? finite(data.CollectiblesItemDetails?.TotalQuantity) : null;
  const result = {
    id: item.id,
    type: item.type,
    status: classify({
      method: item.method,
      isForSale: Boolean(data.IsForSale),
      priceInRobux: finite(data.PriceInRobux),
      remaining,
      limited
    }),
    isForSale: Boolean(data.IsForSale),
    priceInRobux: finite(data.PriceInRobux),
    remaining,
    total,
    saleLocationType: finite(data.SaleLocation?.SaleLocationType),
    universeIds: data.SaleLocation?.UniverseIds ?? [],
    assetTypeId: finite(data.AssetTypeId),
    creatorId: finite(data.Creator?.Id),
    creatorType: data.Creator?.CreatorType || '',
    name: data.Name || item.name
  };
  result.changed = changed(item, result);
  return result;
}

async function scanBundle(item) {
  const data = await getJson(`https://catalog.roblox.com/v1/bundles/${item.id}/details`);
  const detail = data.collectibleItemDetail ?? {};
  const limited = detail.collectibleItemType === 'Limited';
  const remaining = limited ? finite(detail.unitsAvailable) : null;
  const total = limited ? finite(detail.totalQuantity) : null;
  const priceInRobux = finite(data.product?.priceInRobux ?? detail.price);
  const result = {
    id: item.id,
    type: item.type,
    status: classify({
      method: item.method,
      isForSale: Boolean(data.product?.isForSale),
      priceInRobux,
      remaining,
      limited
    }),
    isForSale: Boolean(data.product?.isForSale),
    priceInRobux,
    remaining,
    total,
    saleLocationType: finite(detail.saleLocation?.saleLocationTypeId),
    universeIds: detail.saleLocation?.universeIds ?? [],
    creatorId: finite(data.creator?.id),
    creatorType: data.creator?.type || '',
    name: data.name || item.name
  };
  result.changed = changed(item, result);
  return result;
}

async function scanQueue(queue, delay, scanItem) {
  const results = [];
  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index];
    const key = `${item.type}:${item.id}`;
    try {
      results.push([key, await scanItem(item)]);
    } catch (error) {
      const message = String(error.message || error).slice(0, 240);
      const gone = [400, 404].includes(error.status);
      const previous = storedResults[key];
      if (gone) {
        results.push([key, { id: item.id, type: item.type, status: 'offsale', changed: true, error: message }]);
      } else if (previous?.status === 'available') {
        results.push([key, { ...previous, changed: false, stale: true, error: message }]);
      } else {
        results.push([key, { id: item.id, type: item.type, status: 'unknown', changed: false, error: message }]);
      }
    }
    if ((index + 1) % 50 === 0 || index + 1 === queue.length) {
      console.log(`${item.type}: ${index + 1}/${queue.length}`);
    }
    if (index + 1 < queue.length) await sleep(delay);
  }
  return results;
}

const assets = scanItems.filter(item => item.type === 'Asset');
const bundles = scanItems.filter(item => item.type === 'Bundle');
const [assetResults, bundleResults] = await Promise.all([
  scanQueue(assets, assetDelay, scanAsset),
  scanQueue(bundles, bundleDelay, scanBundle)
]);
const entries = [...assetResults, ...bundleResults];
const activeKeys = new Set(items.map(item => `${item.type}:${item.id}`));
const results = Object.fromEntries([
  ...Object.entries(previousResults).filter(([itemKey]) => activeKeys.has(itemKey)),
  ...entries
]);
const summary = { total: Object.keys(results).length, available: 0, paid: 0, offsale: 0, soldout: 0, unknown: 0, changed: 0 };
for (const result of Object.values(results)) {
  summary[result.status] += 1;
  if (result.changed) summary.changed += 1;
}

const payload = {
  generatedAt: new Date().toISOString(),
  sourceCount: sourceItems.length,
  discoveredCount: discoveredItems.length,
  summary,
  items: results,
  discovered: {
    generatedAt: discoveredData.generatedAt ?? null,
    items: discoveredItems
  }
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const tempPath = `${outputPath}.tmp`;
fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
fs.renameSync(tempPath, outputPath);
console.log(JSON.stringify({ outputPath, summary }, null, 2));
