import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const sourcePath = path.resolve(process.env.SCAN_SOURCE || path.join(root, 'catalog-source.json'));
const discoveredPath = path.resolve(process.env.DISCOVERY_OUTPUT || path.join(root, 'catalog-discovered.json'));
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const sourceItems = Array.isArray(source) ? source : source.items;
const previousData = fs.existsSync(discoveredPath)
  ? JSON.parse(fs.readFileSync(discoveredPath, 'utf8'))
  : { items: [], reviewItems: [] };
const previous = [...(previousData.items ?? []), ...(previousData.reviewItems ?? [])];
const scanPath = path.resolve(process.env.SCAN_OUTPUT || path.join(root, 'scan-results.json'));
const previousScan = fs.existsSync(scanPath) ? JSON.parse(fs.readFileSync(scanPath, 'utf8')) : { items: {} };
const basePages = Number(process.env.DISCOVERY_BASE_PAGES || process.env.DISCOVERY_PAGES_PER_CATEGORY || 10);
const keywordPages = Number(process.env.DISCOVERY_KEYWORD_PAGES || 4);
const creatorPages = Number(process.env.DISCOVERY_CREATOR_PAGES || 1);
const creatorLimit = Number(process.env.DISCOVERY_CREATOR_LIMIT || 40);
const detailDelay = Number(process.env.DISCOVERY_DETAIL_DELAY_MS || 600);
const searchDelay = Number(process.env.DISCOVERY_SEARCH_DELAY_MS || 900);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const key = item => `${item.type}:${item.id}`;
const known = new Set(sourceItems.map(key));

const assetCategories = new Map([
  [2, 'Одежда'], [8, 'Аксессуары'], [11, 'Одежда'], [12, 'Одежда'],
  [17, 'Головы'], [18, 'Лица'], [19, 'Аксессуары'], [25, 'Наборы'],
  [26, 'Наборы'], [27, 'Наборы'], [28, 'Наборы'], [29, 'Наборы'],
  [30, 'Наборы'], [31, 'Наборы'], [41, 'Волосы'], [42, 'Аксессуары'],
  [43, 'Аксессуары'], [44, 'Аксессуары'], [45, 'Аксессуары'], [46, 'Аксессуары'],
  [47, 'Аксессуары'], [48, 'Эмоции'], [49, 'Эмоции'], [50, 'Эмоции'],
  [51, 'Эмоции'], [52, 'Эмоции'], [53, 'Эмоции'], [54, 'Эмоции'],
  [55, 'Эмоции'], [56, 'Эмоции'], [61, 'Эмоции']
]);

async function getJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'Playerok-Roblox-discovery/1.0' }
      });
      if (response.ok) return response.json();
      const body = await response.text();
      lastError = new Error(`${response.status} ${body}`);
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

async function searchCatalog({ category = 1, keyword = '', pages = basePages, creatorId = null, creatorType = '', sortType = 6 }) {
  const found = [];
  let cursor = '';
  for (let page = 0; page < pages; page += 1) {
    const params = new URLSearchParams({
      Category: String(category),
      MinPrice: '0',
      MaxPrice: '0',
      SortType: String(sortType),
      Limit: '120'
    });
    if (keyword) params.set('Keyword', keyword);
    if (Number.isFinite(creatorId)) {
      params.set('CreatorTargetId', String(creatorId));
      params.set('CreatorType', creatorType === 'Group' ? '2' : '1');
    }
    if (cursor) params.set('Cursor', cursor);
    const payload = await getJson(`https://catalog.roblox.com/v2/search/items/details?${params}`);
    found.push(...(payload.data ?? []));
    cursor = payload.nextPageCursor || '';
    if (!cursor) break;
    await sleep(searchDelay);
  }
  return found;
}

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function parseCode(text) {
  const value = String(text || '');
  const patterns = [
    /(?:code|код)\s*[:;=\->]+\s*[\[(]?\s*([a-z0-9][a-z0-9_\-]{2,31})\s*[\])]?/i,
    /(?:code|код)\s*["'`]\s*([a-z0-9][a-z0-9_\-]{2,31})\s*["'`]/i,
    /(?:code|код)\s*[\[(]\s*([a-z0-9][a-z0-9 _\-]{2,31}?)\s*[\])]/i,
    /(?:redeem|use|enter)\s+(?:the\s+)?(?:code\s+)?["'`\[(]?([a-z0-9][a-z0-9_\-]{2,31})["'`\])]?\s+(?:in|at)\s+(?:the\s+)?(?:game|codes?)/i
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    const candidate = match?.[1]?.trim().replace(/-+$/, '');
    if (candidate && !/^(?:the|this|your|here|codes?|redeem|free|ugc|item|reward)$/i.test(candidate)) return candidate;
  }
  const plain = (value.match(/(?:code|код)\s+([a-z0-9][a-z0-9_\-]{2,31})\b/i)?.[1] || '').replace(/-+$/, '');
  if (plain && (/\d/.test(plain) || plain === plain.toUpperCase()) && !/^(?:CODE|FREE|UGC|ITEM|REWARD)$/i.test(plain)) return plain;
  return '';
}

function paidRequirement(text) {
  return /(?:\b(?:buy|purchas(?:e|es|ed|ing)|robux|game\s*pass|gamepass|premium|paid|gift\s*card|toy\s*code|merch|trade|giveaway|commission|reserved|staff)\b|\d+\s*r\b|kick\s+channel\s+points|stream\s+reward|linked\s+server|communications?\s+server|codes?\s+during\s+lives?)/i.test(text || '');
}

function explicitGameUrl(text) {
  const match = String(text || '').match(/https?:\/\/(?:www\.)?roblox\.com\/(?:[a-z]{2}\/)?games\/(\d+)(?:\/[^\s]*)?/i);
  return match ? { placeId: Number(match[1]), url: `https://www.roblox.com/games/${match[1]}` } : null;
}

function positiveAcquisition(item, code) {
  if (!item.universeIds.length) return true;
  if (code) return true;
  const text = item.description || '';
  const action = /(?:claim\s+here|get\s+here|click\s+(?:claim|get)|complete(?:d|s|ing)?\s+(?:the\s+)?(?:quest|quests|obby|part)|after\s+completing|\bobby\b|\bafk\b|(?:play|stay)[^.!?\n]{0,45}?\d+\s*(?:minutes?|mins?)|(?:get|earn|reach|win)\s+\d+\s*(?:wins?|victories|rounds?|levels?)|play\s+(?:the\s+)?(?:game|rounds?)|collect|coins?|tokens?|points?|currency|spin|wheel|random|chance)/i.test(text);
  return action;
}

function codeHub(gameName) {
  return /(?:ugc[^\n]{0,24}codes?|codes?[^\n]{0,24}ugc|flex\s+ugc\s+codes?|limited\s+codes?)/i.test(gameName || '');
}

function groupRequirement(item) {
  const text = String(item.description || '');
  const match = text.match(/roblox\.com\/(?:communities|groups)\/(\d+)/i);
  if (!match) return null;
  return {
    id: Number(match[1]),
    name: item.creator || `Roblox группа ${match[1]}`,
    url: `https://www.roblox.com/communities/${match[1]}`
  };
}

function taskInstructions(text, group = null) {
  const steps = [];
  const add = step => { if (!steps.includes(step)) steps.push(step); };
  const part = String(text || '').match(/after\s+completing\s+part\s+(\d+)/i);
  const minutes = String(text || '').match(/(?:play|stay|afk)[^.!?\n]{0,45}?(\d+)\s*(?:minutes?|mins?)/i);
  const wins = String(text || '').match(/(?:get|earn|reach|win)\s+(\d+)\s*(?:wins?|victories|rounds?)/i);
  const level = String(text || '').match(/(?:reach|get\s+to)\s+level\s+(\d+)/i);
  if (/join\s+(?:(?:the|our|my)\s+)?(?:roblox\s+)?group|group\s+(?:member|membership|required)/i.test(text)) {
    if (group) add(`Вступи в группу «${group.name}».`);
    else add('Вступи в группу, указанную автором вещи.');
  }
  if (part) add(`Пройди Part ${part[1]}.`);
  if (/\bobby\b/i.test(text)) add('Пройди obby.');
  if (/\bquests?\b|complete\s+(?:the\s+)?tasks?/i.test(text)) add('Выполни задания, показанные в игре.');
  if (/\bafk\b/i.test(text)) add('Оставайся в разрешённой AFK-зоне и накопи нужное время или очки.');
  if (minutes) add(`Проведи в игре не меньше ${minutes[1]} минут.`);
  if (wins) add(`Получи ${wins[1]} побед или заверши столько же раундов.`);
  if (/play\s+(?:the\s+)?(?:game|rounds?)|complete\s+(?:a\s+)?round/i.test(text)) add('Играй в раунды и забирай зачтённые награды.');
  if (/collect|coins?|tokens?|points?|currency/i.test(text)) add('Собери требуемые игрой монеты, жетоны или очки.');
  if (/\bbadge\b/i.test(text)) add('Получи указанный значок в игре.');
  if (level) add(`Достигни ${level[1]} уровня.`);
  if (/spin|wheel|random|chance/i.test(text)) add('Используй бесплатные попытки, выпадение может быть случайным.');
  if (/follow\s+(?:the\s+)?(?:creator|user|group)/i.test(text)) add('Подпишись на указанного автора, если игра это проверяет.');
  if (/like\s+(?:the\s+)?game|favorite\s+(?:the\s+)?game/i.test(text)) add('Поставь игре лайк или добавь её в избранное, если это указано в условиях.');
  if (/(?:claim\s+here|get\s+here|click\s+(?:claim|get))/i.test(text)) add('Нажми Claim или Get рядом с вещью.');
  return steps;
}

function concreteTask(steps) {
  return steps.some(step => /(?:Part\s+\d+|Пройди obby|AFK-зоне|не меньше \d+ минут|\d+ побед|Играй в раунды|Собери требуемые|\d+ уровня|бесплатные попытки|Claim или Get)/i.test(step));
}

function instruction(item, gameName, code, group = null) {
  if (!item.universeIds.length) {
    return 'Открой карточку Roblox и нажми Get. Перед подтверждением проверь цену 0 Robux.';
  }
  if (code) {
    const groupStep = group ? ` Если окно Requirements просит группу, вступи в «${group.name}».` : '';
    return `Открой игру «${gameName}», найди раздел Codes и введи код «${code}».${groupStep} Игра может показать дополнительные условия: покупку Game Pass или предмета, Premium, перевод Robux либо другое действие. Бесплатное получение не гарантировано. Перед любым подтверждением внимательно проверь требования и сумму.`;
  }
  const task = taskInstructions(item.description || '', group).join(' ');
  return `Открой игру «${gameName}». ${task} Перед получением проверь, что итоговая цена равна 0 Robux.`;
}

async function details(candidate) {
  if (candidate.itemType === 'Bundle' || candidate.type === 'Bundle') {
    const data = await getJson(`https://catalog.roblox.com/v1/bundles/${candidate.id}/details`);
    const collectible = data.collectibleItemDetail ?? {};
    const limited = collectible.collectibleItemType === 'Limited';
    return {
      id: candidate.id,
      type: 'Bundle',
      name: data.name || candidate.name,
      creator: data.creator?.name || candidate.creator || candidate.creatorName || 'Roblox',
      creatorId: finite(data.creator?.id ?? candidate.creatorId ?? candidate.creatorTargetId),
      creatorType: data.creator?.type || candidate.creatorType || '',
      description: candidate.description || candidate.catalogDescription || '',
      assetType: null,
      isForSale: Boolean(data.product?.isForSale),
      priceInRobux: finite(data.product?.priceInRobux ?? collectible.price),
      remaining: limited ? finite(collectible.unitsAvailable) : null,
      total: limited ? finite(collectible.totalQuantity) : null,
      universeIds: collectible.saleLocation?.universeIds ?? []
    };
  }
  const data = await getJson(`https://economy.roblox.com/v2/assets/${candidate.id}/details`);
  const limited = Boolean(data.CollectiblesItemDetails?.IsLimited || data.IsLimitedUnique);
  return {
    id: candidate.id,
    type: 'Asset',
    name: data.Name || candidate.name,
    creator: data.Creator?.Name || candidate.creator || candidate.creatorName || 'Roblox',
    creatorId: finite(data.Creator?.Id ?? candidate.creatorId ?? candidate.creatorTargetId),
    creatorType: data.Creator?.CreatorType || candidate.creatorType || '',
    description: candidate.description || candidate.catalogDescription || '',
    assetType: candidate.assetType ?? data.AssetTypeId,
    isForSale: Boolean(data.IsForSale),
    priceInRobux: finite(data.PriceInRobux),
    remaining: limited ? finite(data.Remaining) : null,
    total: limited ? finite(data.CollectiblesItemDetails?.TotalQuantity) : null,
    universeIds: data.SaleLocation?.UniverseIds ?? []
  };
}

const categoryPlans = [1, 3, 4, 11, 12, 13].map(category => ({ category, pages: basePages }));
const discoveryKeywords = [
  'free ugc',
  'ugc code',
  'free limited',
  'free item',
  'ugc obby',
  'ugc afk',
  'ugc quest',
  'redeem code',
  'play for ugc',
  'earn ugc',
  'claim ugc',
  'free ugc codes'
];
const keywordPlans = discoveryKeywords.flatMap(keyword => [
  { category: 1, keyword, pages: keywordPages, sortType: 6 },
  { category: 1, keyword, pages: keywordPages, sortType: 1 }
]);
const previousItemsByKey = new Map([...sourceItems, ...previous].map(item => [key(item), item]));
const trackedCreators = new Map();
for (const [itemKey, item] of previousItemsByKey) {
  if (!['code', 'quest', 'game', 'game-volatile'].includes(item.method)) continue;
  const scan = previousScan.items?.[itemKey] ?? {};
  const creatorId = finite(item.creatorId ?? scan.creatorId);
  const creatorType = item.creatorType || scan.creatorType || '';
  if (Number.isFinite(creatorId)) trackedCreators.set(`${creatorType}:${creatorId}`, { creatorId, creatorType });
}
const creatorPlans = [...trackedCreators.values()].slice(0, creatorLimit)
  .map(({ creatorId, creatorType }) => ({ category: 1, pages: creatorPages, creatorId, creatorType }));
const searchPlans = [...categoryPlans, ...keywordPlans, ...creatorPlans];
const searchRows = [];
for (let planIndex = 0; planIndex < searchPlans.length; planIndex += 1) {
  const plan = searchPlans[planIndex];
  try {
    searchRows.push(...await searchCatalog(plan));
  } catch (error) {
    console.warn(`Search plan ${planIndex + 1}/${searchPlans.length}: ${String(error.message || error).slice(0, 160)}`);
  }
  console.log(`Discovery search: ${planIndex + 1}/${searchPlans.length}, rows: ${searchRows.length}`);
  if (planIndex + 1 < searchPlans.length) await sleep(searchDelay);
}
const candidates = new Map();
for (const item of previous) candidates.set(key(item), { ...item, itemType: item.type });
for (const item of searchRows) {
  const itemKey = key({ type: item.itemType, id: item.id });
  if (!known.has(itemKey)) candidates.set(itemKey, item);
}

const checked = [];
let index = 0;
for (const candidate of candidates.values()) {
  try {
    const item = await details(candidate);
    const hasStock = !Number.isFinite(item.remaining) || item.remaining > 0;
    const freeNow = item.isForSale && item.priceInRobux === 0 && hasStock;
    const code = parseCode(`${item.name}\n${item.description}`);
    const blockedByPurchase = item.universeIds.length > 0 && !code && paidRequirement(item.description);
    if (freeNow && !blockedByPurchase && positiveAcquisition(item, code)) checked.push(item);
  } catch (error) {
    console.warn(`Skip ${candidate.id}: ${String(error.message || error).slice(0, 160)}`);
  }
  index += 1;
  if (index % 50 === 0 || index === candidates.size) console.log(`Discovery details: ${index}/${candidates.size}`);
  if (index < candidates.size) await sleep(detailDelay);
}

const universeIds = [...new Set(checked.flatMap(item => item.universeIds).filter(Number.isFinite))];
const games = {};
for (let offset = 0; offset < universeIds.length; offset += 50) {
  const chunk = universeIds.slice(offset, offset + 50);
  const payload = await getJson(`https://games.roblox.com/v1/games?universeIds=${chunk.join(',')}`);
  for (const game of payload.data ?? []) games[String(game.id)] = game;
  if (offset + 50 < universeIds.length) await sleep(1100);
}

const explicitPlaces = [...new Set(checked.map(item => explicitGameUrl(item.description)?.placeId).filter(Number.isFinite))];
const explicitGames = {};
for (const placeId of explicitPlaces) {
  try {
    const universe = await getJson(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
    const game = (await getJson(`https://games.roblox.com/v1/games?universeIds=${universe.universeId}`)).data?.[0];
    if (game) explicitGames[String(placeId)] = game;
  } catch (error) {
    console.warn(`Game route ${placeId}: ${String(error.message || error).slice(0, 120)}`);
  }
  await sleep(450);
}

async function thumbnails(type, ids) {
  const result = {};
  for (let offset = 0; offset < ids.length; offset += 100) {
    const chunk = ids.slice(offset, offset + 100);
    const endpoint = type === 'Bundle'
      ? `https://thumbnails.roblox.com/v1/bundles/thumbnails?bundleIds=${chunk.join(',')}&size=420x420&format=Png&isCircular=false`
      : `https://thumbnails.roblox.com/v1/assets?assetIds=${chunk.join(',')}&returnPolicy=PlaceHolder&size=420x420&format=Png&isCircular=false`;
    const payload = await getJson(endpoint);
    for (const image of payload.data ?? []) if (image.imageUrl) result[String(image.targetId)] = image.imageUrl;
    if (offset + 100 < ids.length) await sleep(650);
  }
  return result;
}

const assetThumbs = await thumbnails('Asset', checked.filter(item => item.type === 'Asset').map(item => item.id));
const bundleThumbs = await thumbnails('Bundle', checked.filter(item => item.type === 'Bundle').map(item => item.id));
const previousByKey = new Map(previous.map(item => [key(item), item]));
const now = new Date().toISOString();
const items = checked.flatMap(item => {
  const route = explicitGameUrl(item.description);
  const game = (route && explicitGames[String(route.placeId)]) || item.universeIds.map(id => games[String(id)]).find(Boolean);
  if (item.universeIds.length && !game) return [];
  if (/\[(?:title unavailable|content deleted)\]/i.test(game?.name || '')) return [];
  const code = parseCode(`${item.name}\n${item.description}`);
  if (!code && paidRequirement(item.description)) return [];
  const group = groupRequirement(item);
  const itemSteps = taskInstructions(item.description || '', group);
  if (item.universeIds.length && !code && (codeHub(game?.name || '') || !concreteTask(itemSteps))) return [];
  const method = item.universeIds.length ? (code ? 'code' : 'game-volatile') : 'direct';
  const old = previousByKey.get(key(item));
  return [{
    number: null,
    id: item.id,
    type: item.type,
    name: item.name,
    creator: item.creator,
    creatorId: item.creatorId,
    creatorType: item.creatorType,
    thumbnailUrl: (item.type === 'Bundle' ? bundleThumbs : assetThumbs)[String(item.id)] || old?.thumbnailUrl || '',
    method,
    methodLabel: method === 'direct' ? 'Marketplace' : method === 'code' ? 'Код в игре' : 'Стоковая раздача',
    howToGet: instruction(item, game?.name || 'Roblox', code, group),
    url: item.type === 'Bundle' ? `https://www.roblox.com/bundles/${item.id}` : `https://www.roblox.com/catalog/${item.id}`,
    game: game?.name || '',
    gameUrl: route?.url || (game ? `https://www.roblox.com/games/${game.rootPlaceId}` : ''),
    groupName: group?.name || '',
    groupUrl: group?.url || '',
    assetTypeId: item.assetType,
    code,
    remaining: item.remaining,
    total: item.total,
    tier: 'discovered',
    riskFlags: ['auto-discovered', ...(method === 'code' ? ['hidden-code-requirements'] : []), ...(Number.isFinite(item.remaining) && item.remaining <= 50 ? ['low-stock'] : [])],
    category: item.type === 'Bundle' ? 'Наборы' : item.assetType === 2 ? 'Футболки с принтом' : assetCategories.get(item.assetType) || 'Аксессуары',
    universeIds: item.universeIds,
    catalogDescription: item.description.slice(0, 500),
    discoveredAt: old?.discoveredAt || now,
    updatedAt: now
  }];
});

const payload = {
  generatedAt: now,
  searchPagesPerCategory: basePages,
  keywordPages,
  searchPlanCount: searchPlans.length,
  searchRowCount: searchRows.length,
  candidateCount: candidates.size,
  items: items.sort((a, b) => String(b.discoveredAt).localeCompare(String(a.discoveredAt))),
  reviewItems: []
};
const tempPath = `${discoveredPath}.tmp`;
fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
fs.renameSync(tempPath, discoveredPath);
console.log(JSON.stringify({
  outputPath: discoveredPath,
  candidates: candidates.size,
  accepted: payload.items.length,
  codeWarnings: payload.items.filter(item => item.method === 'code').length
}, null, 2));
