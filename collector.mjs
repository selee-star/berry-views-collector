// TikTok view collector for the Berry Goes Viral challenge (runs on GitHub Actions).
// 1) asks the Apps Script web app which videos need fresh numbers
// 2) reads each video's public TikTok embed page (no login, no bot-check workarounds)
// 3) sends the numbers back; the web app writes them to the Videos sheet
// Needs two repository secrets: WEBAPP_URL and COLLECTOR_KEY.

const WEBAPP_URL = process.env.WEBAPP_URL;
const COLLECTOR_KEY = process.env.COLLECTOR_KEY;
// Runs once a day and goes slowly on purpose, so TikTok is not asked too often.
const MAX_AGE_MINUTES = Number(process.env.MAX_AGE_MINUTES || 20 * 60); // re-check videos not updated for 20 hours
const DELAY_MS = Number(process.env.DELAY_MS || 20000);                 // at least 20 s between videos (+ up to 10 s)
const RETRY_WAIT_MS = 90000;                                            // after a refusal, wait 90 s before the one retry
const STOP_AFTER_FAILS = 5;                                             // TikTok keeps refusing: stop, the rest wait for tomorrow
const REPORT_EVERY = 10;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!WEBAPP_URL || !COLLECTOR_KEY) {
  console.error('WEBAPP_URL and COLLECTOR_KEY secrets are required.');
  process.exit(1);
}

async function callWebApp(body) {
  const res = await fetch(WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...body, key: COLLECTOR_KEY }),
    redirect: 'follow',
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Web app answered HTTP ${res.status}: ${text.slice(0, 200)}`); }
  if (!data.ok) throw new Error(`Web app error: ${data.error}`);
  return data;
}

function embedUrl(url) {
  const m = String(url).match(/\/video\/(\d+)/);
  return m ? `https://www.tiktok.com/embed/v2/${m[1]}` : null;
}

function parseStats(html) {
  const num = key => {
    const m = html.match(new RegExp(`"${key}":"?(\\d+)`));
    return m ? Number(m[1]) : null;
  };
  const views = num('playCount');
  if (views === null) return null;
  return { views, likes: num('diggCount') || 0, comments: num('commentCount') || 0, shares: num('shareCount') || 0 };
}

/** One embed page; on a temporary refusal (429/503) wait and try once more. Returns stats or null. */
async function fetchStats(url) {
  const target = embedUrl(url);
  if (!target) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(target, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) return parseStats(await res.text());
      console.log(`  TikTok answered HTTP ${res.status}`);
      if (res.status !== 429 && res.status !== 503) return null;
      const after = Number(res.headers.get('retry-after'));
      if (attempt === 0) await sleep(after > 0 ? Math.min(after * 1000, 300000) : RETRY_WAIT_MS);
      continue;
    } catch (err) {
      console.log(`  Network problem: ${err.message}`);
    }
    if (attempt === 0) await sleep(RETRY_WAIT_MS);
  }
  return null;
}

async function main() {
  const due = await callWebApp({ action: 'due', maxAgeMinutes: MAX_AGE_MINUTES });
  console.log(`Mode: ${due.mode} · videos to check: ${due.videos.length}`);
  if (!due.videos.length) return;

  let pending = [];
  let ok = 0, fail = 0, failsInRow = 0;
  const flush = async last => {
    if (!pending.length && !last) return;
    const r = await callWebApp({ action: 'report', mode: due.mode, last, results: pending });
    console.log(`Reported ${pending.length}: updated ${r.updated}, failed ${r.failed}`);
    pending = [];
  };

  for (const v of due.videos) {
    const stats = await fetchStats(v.url);
    if (stats) { ok += 1; failsInRow = 0; pending.push({ id: v.id, ...stats }); }
    else { fail += 1; failsInRow += 1; pending.push({ id: v.id, views: null }); }
    if (pending.length >= REPORT_EVERY) await flush(false);
    if (failsInRow >= STOP_AFTER_FAILS) {
      console.log(`TikTok refused ${STOP_AFTER_FAILS} videos in a row. Stopping today; the rest are tried in the next run.`);
      break;
    }
    await sleep(DELAY_MS + Math.floor(Math.random() * 10000));
  }
  // Marks the final tally as done only when every video was attempted
  await flush(failsInRow < STOP_AFTER_FAILS);
  console.log(`Done · ok ${ok} · failed ${fail}`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
