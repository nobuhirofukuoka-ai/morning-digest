#!/usr/bin/env node
/**
 * Morning Digest — daily content generator
 * Fetches RSS feeds → Gemini API → writes data/digest.json + digest.js
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const DATA_DIR  = join(ROOT, 'data');
const DIGEST_PATH  = join(DATA_DIR, 'digest.json');
const DIGEST_JS    = join(DATA_DIR, 'digest.js');
const ARCHIVE_DIR  = join(DATA_DIR, 'archive');

// ── RSS feeds (カテゴリ別) ──────────────────────────────────────────────────
const RSS_FEEDS = {
  japan: [
    { url: 'https://news.google.com/rss?hl=ja&gl=JP&ceid=JP:ja', source: 'Google News JP' },
  ],
  global: [
    { url: 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en', source: 'Google News' },
  ],
  research: [
    { url: 'https://news.google.com/rss/search?q=ACL+injury+prevention+athletic+training+neuromuscular&hl=en-US&gl=US&ceid=US:en',        source: 'Athletic Training' },
    { url: 'https://news.google.com/rss/search?q=biomechanics+running+gait+exercise+physiology&hl=en-US&gl=US&ceid=US:en',                source: 'Biomechanics' },
    { url: 'https://news.google.com/rss/search?q=sports+medicine+orthopedics+tendon+ligament&hl=en-US&gl=US&ceid=US:en',                  source: 'Sports Medicine' },
    { url: 'https://news.google.com/rss/search?q=physical+therapy+rehabilitation+return+to+sport&hl=en-US&gl=US&ceid=US:en',              source: 'Rehabilitation' },
    { url: 'https://news.google.com/rss/search?q=acupuncture+sports+pain+musculoskeletal&hl=en-US&gl=US&ceid=US:en',                      source: 'Acupuncture' },
    { url: 'https://news.google.com/rss/search?q=sports+nutrition+protein+creatine+recovery+supplement+athlete&hl=en-US&gl=US&ceid=US:en',source: 'Nutrition' },
    { url: 'https://news.google.com/rss/search?q=youth+athlete+pediatric+exercise+development&hl=en-US&gl=US&ceid=US:en',                  source: 'Youth Sports' },
    { url: 'https://news.google.com/rss/search?q=sleep+athlete+performance+mental+health+recovery&hl=en-US&gl=US&ceid=US:en',             source: 'Sleep Science' },
  ],
};

// ── RSS parser ─────────────────────────────────────────────────────────────
function parseRSS(xml, source) {
  const items = [];
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const get = tag => {
      const r = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([^<]*)<\\/${tag}>`));
      return r ? (r[1] || r[2] || '').trim() : '';
    };
    const linkM = block.match(/<link>(https?:\/\/[^<]+)<\/link>/) ||
                  block.match(/<guid[^>]*>(https?:\/\/[^<]+)<\/guid>/);
    const titleRaw = get('title');
    const srcM    = titleRaw.match(/ - ([^-]+)$/);
    const pubDate = get('pubDate');
    items.push({
      title: titleRaw.replace(/ - [^-]+$/, '').trim(),
      source: srcM ? srcM[1].trim() : source,
      link: linkM ? linkM[1].trim() : '',
      pubDate,
      published_at: pubDate ? new Date(pubDate).toISOString() : '',
    });
  }
  return items;
}

async function fetchFeed(url, source) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'MorningDigestBot/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return parseRSS(xml, source).slice(0, 5);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAllFeeds() {
  const raw = { japan: [], global: [], research: [] };

  for (const [cat, feeds] of Object.entries(RSS_FEEDS)) {
    for (const feed of feeds) {
      try {
        console.log(`  Fetching [${cat}] ${feed.source}…`);
        const items = await fetchFeed(feed.url, feed.source);
        raw[cat].push(...items);
      } catch (err) {
        console.warn(`  ⚠ ${feed.source}: ${err.message}`);
      }
    }
  }
  return raw;
}

// ── Gemini API ─────────────────────────────────────────────────────────────
const RESEARCH_CATEGORIES = [
  'Athletic Training / ACL Prevention',
  'Biomechanics / Exercise Science',
  'Sports Medicine / Orthopedics',
  'Rehabilitation / Physical Therapy',
  'Oriental Medicine / Acupuncture',
  'Nutrition / Supplements / Recovery',
  'Pediatric Exercise / Youth Development',
  'Sleep Science / Mental Performance',
];
const JAPAN_CATEGORIES  = ['政治','経済','社会','国際','テクノロジー','医療・健康','スポーツ','教育','環境・気候','文化・エンタメ'];
const GLOBAL_CATEGORIES = ['Politics','Economy','Technology','Health','Climate','Conflict','Science','Culture','Sports','Energy'];
const GLOBAL_REGIONS    = ['US','Europe','Asia','Middle East','Africa','Latin America','Global'];

async function generateWithGemini(rawFeeds) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const today = new Date().toLocaleDateString('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  });

  // researchはカテゴリ別に1件ずつ渡す
  const researchByCategory = {};
  RESEARCH_CATEGORIES.forEach((cat, i) => {
    researchByCategory[cat] = rawFeeds.research.slice(i * 5, i * 5 + 5);
  });

  const prompt = `
あなたはスポーツ医学・健康・時事情報のダイジェストサービスのコンテンツ生成AIです。
以下のRSSフィードデータをもとに、Morning Digestのコンテンツを日本語で生成してください。

本日の日付: ${today}

【入力データ】
=== 研究・学術情報（カテゴリ別） ===
${JSON.stringify(researchByCategory, null, 2)}

=== 日本国内ニュース ===
${JSON.stringify(rawFeeds.japan.slice(0, 15), null, 2)}

=== 海外ニュース ===
${JSON.stringify(rawFeeds.global.slice(0, 15), null, 2)}

【出力形式】
JSONのみで返答（コードブロック・マークダウン不要）：
{
  "latest_research": [...],
  "japan_news": [...],
  "global_news": [...]
}

【latest_research のルール】
- 8件生成。各カテゴリから必ず1件ずつ選ぶ（偏り禁止）
- カテゴリ一覧: ${RESEARCH_CATEGORIES.join(', ')}
- フォーマット:
  {
    "id": "r001",
    "category": "カテゴリ名",
    "title": "日本語タイトル",
    "source": "ソース名",
    "url": "元記事URL",
    "abstract": "2〜3文の日本語要約（研究内容・対象・結果を含む）",
    "insight": "現場での活用方法を1〜2文で具体的に",
    "published_at": "ISO8601形式（例: 2026-05-08T06:00:00.000Z）"
  }

【japan_news のルール】
- 8件生成。架空記事禁止、入力データの記事のみ使用
- カテゴリ: ${JAPAN_CATEGORIES.join(', ')}
- フォーマット:
  {
    "id": "j001",
    "category": "カテゴリ",
    "source": "ソース名",
    "title": "日本語タイトル（元タイトルをそのまま）",
    "summary": "2〜3行の日本語要約",
    "url": "元記事URL",
    "published_at": "ISO8601形式"
  }

【global_news のルール】
- 8件生成。架空記事禁止、入力データの記事のみ使用
- category: ${GLOBAL_CATEGORIES.join(', ')}
- region: ${GLOBAL_REGIONS.join(', ')}
- フォーマット:
  {
    "id": "g001",
    "category": "Category",
    "region": "Region",
    "source": "ソース名",
    "title": "日本語タイトル（英語記事は翻訳）",
    "summary": "2〜3行の日本語要約",
    "url": "元記事URL",
    "published_at": "ISO8601形式"
  }
`;

  console.log('Calling Gemini API…');
  const result = await model.generateContent(prompt);
  const text   = result.response.text().trim()
    .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  return JSON.parse(text);
}

// ── Weekly / Monthly 集計 ──────────────────────────────────────────────────
function buildTop20FromArchives(days, todayData) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const all = [];

  const addItems = (items, tab) =>
    items.forEach(item => all.push({ ...item, origin_tab: tab }));

  addItems(todayData.latest_research, 'latest_research');
  addItems(todayData.japan_news,      'japan_news');
  addItems(todayData.global_news,     'global_news');

  if (existsSync(ARCHIVE_DIR)) {
    readdirSync(ARCHIVE_DIR)
      .filter(f => f.endsWith('.json'))
      .sort().reverse()
      .forEach(file => {
        try {
          const d    = JSON.parse(readFileSync(join(ARCHIVE_DIR, file), 'utf8'));
          const date = new Date(d.generated_at);
          if (date < cutoff) return;
          addItems(d.latest_research || [], 'latest_research');
          addItems(d.japan_news      || [], 'japan_news');
          addItems(d.global_news     || [], 'global_news');
        } catch { /* skip */ }
      });
  }

  const seen   = new Set();
  const unique = all.filter(item => {
    if (seen.has(item.title)) return false;
    seen.add(item.title);
    return true;
  });

  return unique.slice(0, 20).map((item, i) => ({
    rank: i + 1,
    origin_tab: item.origin_tab,
    category:   item.category,
    title:      item.title,
    summary:    item.abstract || item.summary || '',
    url:        item.url,
  }));
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('Error: GEMINI_API_KEY is not set.');
    process.exit(1);
  }

  console.log('=== Morning Digest Generator ===');
  const now    = new Date();
  const jst    = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const issueDate = `${jst.getFullYear()}/${String(jst.getMonth()+1).padStart(2,'0')}/${String(jst.getDate()).padStart(2,'0')}`;

  // 1. RSS 取得
  console.log('Fetching RSS feeds…');
  const rawFeeds   = await fetchAllFeeds();
  const totalItems = Object.values(rawFeeds).flat().length;
  console.log(`Fetched ${totalItems} items.`);

  // 2. Gemini で生成
  let generated;
  try {
    generated = await generateWithGemini(rawFeeds);
  } catch (err) {
    console.error('Gemini API failed:', err.message);
    process.exit(1);
  }

  // 3. ID 補完
  ['latest_research','japan_news','global_news'].forEach(key => {
    const prefix = key === 'latest_research' ? 'r' : key === 'japan_news' ? 'j' : 'g';
    (generated[key] || []).forEach((item, i) => {
      if (!item.id) item.id = `${prefix}${String(i+1).padStart(3,'0')}`;
    });
  });

  // 4. Top20 集計
  const weekly_top20  = buildTop20FromArchives(7,  generated);
  const monthly_top20 = buildTop20FromArchives(30, generated);

  // 5. 組み立て
  const digest = {
    issue_date:      issueDate,
    generated_at:    now.toISOString(),
    latest_research: generated.latest_research || [],
    japan_news:      generated.japan_news      || [],
    global_news:     generated.global_news     || [],
    weekly_top20,
    monthly_top20,
  };

  // 6. 書き出し
  const json = JSON.stringify(digest, null, 2);
  writeFileSync(DIGEST_PATH, json, 'utf8');
  console.log(`✓ ${DIGEST_PATH}`);
  writeFileSync(DIGEST_JS, `window.DIGEST_DATA = ${json};\n`, 'utf8');
  console.log(`✓ ${DIGEST_JS}`);

  // 7. アーカイブ保存
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  const archivePath = join(ARCHIVE_DIR, `${issueDate.replace(/\//g,'-')}.json`);
  writeFileSync(archivePath, json, 'utf8');
  console.log(`✓ archived: ${archivePath}`);

  console.log('=== Done ===');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
