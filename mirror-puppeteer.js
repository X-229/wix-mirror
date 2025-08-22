// mirror-puppeteer.js
// Usage: node mirror-puppeteer.js <target-url> <outdir> [maxDepth] [concurrency]
// Example:
//   node mirror-puppeteer.js "https://cssy2672.wixsite.com/my-site-1" "./public" 2 3
//
// If you need a proxy on GitHub Actions, set env PROXY (e.g. "http://127.0.0.1:7890").

const fs = require('fs').promises;
const path = require('path');
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const sanitize = require('sanitize-filename');
const { URL } = require('url');

const TARGET = process.argv[2];
const OUTDIR = process.argv[3] || './public';
const MAX_DEPTH = parseInt(process.argv[4] || '2', 10);
const CONCURRENCY = parseInt(process.argv[5] || '2', 10);
const PROXY = process.argv[6] || process.env.PROXY || null;

if (!TARGET) {
  console.error('Usage: node mirror-puppeteer.js <target-url> <outdir> [maxDepth] [concurrency] [proxy]');
  process.exit(1);
}

function urlKey(u){
  try {
    const U = new URL(u);
    U.hash = '';
    return U.toString();
  } catch(e){
    return null;
  }
}

function mapUrlToLocal(u, baseOut){
  const U = new URL(u);
  let filepath = path.join('assets', U.hostname, decodeURIComponent(U.pathname.replace(/^\/+/,'')));
  if (filepath.endsWith('/')) filepath = path.join(filepath, 'index');
  const ext = path.extname(filepath);
  if (!ext) filepath += '.bin';
  const parts = filepath.split(path.sep).map(s => sanitize(s));
  return path.join(baseOut, ...parts);
}

async function saveBufferTo(filePath, buffer){
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buffer);
}

async function downloadAsset(url, outFile, opts = {}) {
  try {
    if (opts.proxy) {
      process.env.HTTP_PROXY = opts.proxy;
      process.env.HTTPS_PROXY = opts.proxy;
    }
    const headers = opts.headers || {};
    const res = await fetch(url, { headers, timeout: 30000 });
    if (!res.ok) {
      console.warn('Asset fetch failed', res.status, url);
      return false;
    }
    const buf = await res.buffer();
    await saveBufferTo(outFile, buf);
    return true;
  } catch (e) {
    console.warn('Asset download error', url, e.message);
    return false;
  }
}

function makeRelative(fromFile, toFile){
  const rel = path.relative(path.dirname(fromFile), toFile).split(path.sep).join('/');
  return rel.startsWith('.') ? rel : './' + rel;
}

async function autoScroll(page){
  await page.evaluate(async () => {
    await new Promise(resolve => {
      var total = 0; var dist = 400;
      var timer = setInterval(() => {
        window.scrollBy(0, dist);
        total += dist;
        if (total > document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 250);
    });
  });
  await page.waitForTimeout(1000);
}

(async () => {
  const origin = new URL(TARGET).origin;
  const startPathPrefix = new URL(TARGET).pathname.replace(/\/$/, '');
  console.log('Target:', TARGET);
  console.log('Outdir:', OUTDIR, 'MaxDepth:', MAX_DEPTH, 'Concurrency:', CONCURRENCY, 'Proxy:', PROXY || 'none');

  const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
  if (PROXY) launchArgs.push(`--proxy-server=${PROXY.replace(/^http:\\/\\//,'')}`); // e.g. "http://127.0.0.1:7890"
  const browser = await puppeteer.launch({ headless: true, args: launchArgs });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36');

  const queue = [{ url: TARGET, depth: 0 }];
  const visited = new Set();
  const assetMap = new Map();
  const pageLocalMap = new Map();

  async function processOne(item) {
    const url = item.url;
    const depth = item.depth;
    const key = urlKey(url);
    if (!key || visited.has(key)) return;
    visited.add(key);
    console.log(`Fetching (${visited.size})`, url, 'depth', depth);
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      await autoScroll(page);
      const html = await page.content();
      const $ = cheerio.load(html, { decodeEntities: false });

      // local page path
      const u = new URL(url);
      let localPath = path.join(OUTDIR, sanitize(u.hostname), decodeURIComponent(u.pathname.replace(/^\/+/,'')));
      if (!path.extname(localPath)) localPath = path.join(localPath, 'index.html');
      else if (!localPath.endsWith('.html')) localPath += '.html';
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      pageLocalMap.set(key, localPath);

      // collect links and asset URLs
      const domAssets = await page.evaluate(() => {
        const urls = new Set();
        document.querySelectorAll('img[src]').forEach(i => urls.add(i.src));
        document.querySelectorAll('script[src]').forEach(s => urls.add(s.src));
        document.querySelectorAll('link[rel="stylesheet"][href]').forEach(l => urls.add(l.href));
        document.querySelectorAll('source[src], source[srcset]').forEach(s => {
          if (s.src) urls.add(s.src);
          if (s.srcset) urls.add(s.srcset);
        });
        const links = Array.from(document.querySelectorAll('a[href]')).map(a => a.href);
        // background images
        document.querySelectorAll('*').forEach(el => {
          const bg = getComputedStyle(el).backgroundImage;
          if (bg && bg !== 'none') {
            const re = /url\\((?:'|")?(.*?)(?:'|")?\\)/g;
            let m;
            while ((m = re.exec(bg)) !== null) {
              if (m[1]) urls.add(new URL(m[1], location.href).href);
            }
          }
        });
        return { assetUrls: Array.from(urls), links };
      });

      const foundLinks = (domAssets.links || []).map(h => {
        try { return (new URL(h, url)).toString(); } catch(e){ return null; }
      }).filter(Boolean);

      for (const l of foundLinks) {
        if (!l.startsWith(origin)) continue;
        const p = new URL(l);
        if (!p.pathname.startsWith(startPathPrefix)) continue;
        const lk = urlKey(l);
        if (!visited.has(lk) && item.depth + 1 <= MAX_DEPTH) queue.push({ url: l, depth: depth + 1 });
      }

      const rawAssets = domAssets.assetUrls.flatMap(a => (a||'').split(',').map(x=>x.trim()).filter(Boolean));
      const uniqueAssets = Array.from(new Set(rawAssets)).filter(a => !a.startsWith('data:') && /^https?:\/\//.test(a)).map(a => (new URL(a, url)).toString());

      for (const assetUrl of uniqueAssets) {
        if (assetMap.has(assetUrl)) continue;
        const local = mapUrlToLocal(assetUrl, OUTDIR);
        assetMap.set(assetUrl, local);
        const ok = await downloadAsset(assetUrl, local, { proxy: PROXY, headers: { Referer: url }});
        if (!ok) console.warn('Failed asset', assetUrl);
        else {
          // if css -> parse for url() references and try to download
          if (local.endsWith('.css')) {
            try {
              const cssText = (await fs.readFile(local)).toString();
              const re = /url\\((?:'|")?(.*?)(?:'|")?\\)/g;
              let m;
              while ((m = re.exec(cssText)) !== null) {
                const ref = m[1];
                if (!ref || ref.startsWith('data:')) continue;
                try {
                  const abs = (new URL(ref, assetUrl)).toString();
                  if (!assetMap.has(abs)) {
                    const local2 = mapUrlToLocal(abs, OUTDIR);
                    assetMap.set(abs, local2);
                    await downloadAsset(abs, local2, { proxy: PROXY, headers: { Referer: assetUrl }});
                  }
                } catch(e){}
              }
            } catch(e){ }
          }
        }
      }

      // rewrite urls in HTML
      function rewrite(abs) {
        if (!abs || !/^https?:\/\//.test(abs)) return abs;
        const local = assetMap.get(abs);
        if (!local) return abs;
        return makeRelative(localPath, local);
      }
      $('img').each((i, el) => { const src=$(el).attr('src')||''; $(el).attr('src', rewrite(new URL(src, url).toString())); });
      $('script[src]').each((i,el)=>{ const s=$(el).attr('src')||''; $(el).attr('src', rewrite(new URL(s, url).toString())); });
      $('link[rel="stylesheet"]').each((i,el)=>{ const h=$(el).attr('href')||''; $(el).attr('href', rewrite(new URL(h, url).toString())); });
      $('source').each((i,el)=>{ const s=$(el).attr('src'); const ss=$(el).attr('srcset'); if (s) $(el).attr('src', rewrite(new URL(s, url).toString())); if (ss){ const parts = ss.split(',').map(p=>{ const s0=p.trim().split(' ')[0]; const r=rewrite(new URL(s0,url).toString()); return r + (p.includes(' ')?' '+p.trim().split(' ').slice(1).join(' '):''); }); $(el).attr('srcset', parts.join(', ')); }});
      $('[style]').each((i,el)=>{ let st=$(el).attr('style'); st = st.replace(/url\\((?:'|")?(.*?)(?:'|")?\\)/g, (m,g1)=>{ try{ const abs=new URL(g1,url).toString(); return 'url(' + rewrite(abs) + ')'; }catch(e){ return m; }}); $(el).attr('style', st); });

      await fs.writeFile(localPath, $.html({ decodeEntities:false }));
      console.log('Saved page ->', localPath);
      await new Promise(r => setTimeout(r, 300));
    } catch (e){
      console.warn('Fetch failed', url, e.message);
    }
  }

  // worker pool
  const workers = Array.from({length: CONCURRENCY}).map(async () => {
    while (queue.length){
      const job = queue.shift();
      if (!job) break;
      await processOne(job);
    }
  });

  await Promise.all(workers);
  await browser.close();

  // index page
  const indexFile = path.join(OUTDIR, 'index.html');
  const list = Array.from(pageLocalMap.values()).map(p => path.relative(OUTDIR, p).split(path.sep).join('/'));
  let idxHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Mirror index</title></head><body><h1>Mirrored pages</h1><ul>`;
  for (const l of list) idxHtml += `<li><a href="./${l}">${l}</a></li>`;
  idxHtml += `</ul></body></html>`;
  await fs.writeFile(indexFile, idxHtml);

  console.log('Done. Mirror saved to:', OUTDIR);
})();
