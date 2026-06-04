(function () {

    // ─── Constants ────────────────────────────────────────────────────────────
    var BASE_URL   = manifest.baseUrl;
    var SERIES_URL = 'https://series.lk21.de';
    var POSTER_CDN = 'https://poster.showcdnx.com/wp-content/uploads/';
    var UA         = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    var HTML_HDR   = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' };
    var JSON_HDR   = { 'User-Agent': UA, 'Accept': 'application/json' };
    var PLAYER_HDR = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Referer': 'https://playeriframe.sbs/' };

    // ─── Helpers ──────────────────────────────────────────────────────────────
    function getBody(res) {
        if (!res) return '';
        if (typeof res === 'string') return res;
        return typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    }

    async function parseHtml(html, selector, attr) {
        try {
            var raw = await parse_html(html, selector, attr);
            if (!Array.isArray(raw)) return [];
            return raw.map(function(item) {
                if (!item) return '';
                if (typeof item === 'string') return item;
                if (attr === 'text') return item.text || '';
                if (attr === 'html') return item.html || '';
                return item.attr || item[attr] || '';
            });
        } catch (_) { return []; }
    }

    function getBaseUrl(url) {
        try { var u = new URL(url); return u.protocol + '//' + u.host; }
        catch (_) { return ''; }
    }

    function cleanTitle(raw) {
        return (raw || '')
            .replace(/^nonton\s+/i, '')
            .replace(/\s+sub\s+indo\s+di\s+lk21\s*$/i, '')
            .replace(/\s+di\s+lk21\s*$/i, '')
            .replace(/\s+sub\s+indo\s*$/i, '')
            .trim();
    }

    function extractQuality(url) {
        var m = (url || '').match(/[/_](\d{3,4}p?)\.m3u8/i)
             || (url || '').match(/[/_](2160|1080|720|480|360|240)(?:[^0-9]|$)/i);
        return m ? m[1].replace(/p?$/, '') + 'p' : '';
    }

    function unpackIfNeeded(html) {
        if (!html.includes('eval(function(p,a,c,k,e')) return html;
        try { return getAndUnpack(html); } catch (_) { return html; }
    }

    function extractM3u8(src) {
        return (src.match(/["'](https?:\/\/[^"']+\.m3u8[^"']{0,400}?)["']/i)
             || src.match(/file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i)
             || src.match(/source\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i)
             || [null, null])[1];
    }

    // ─── Resolvers ────────────────────────────────────────────────────────────

    // P2P — playeriframe.sbs/iframe/p2p/{token} → cloud.hownetwork.xyz/video.php?id={token}
    async function resolveP2P(wrapperUrl) {
        try {
            var wrapHtml = getBody(await http_get(wrapperUrl, { ...HTML_HDR, 'Referer': BASE_URL + '/' }));
            var iframeSrc = (wrapHtml.match(/<iframe[^>]+src=["'](https?:\/\/[^"']+)["']/i) || [])[1];
            if (!iframeSrc) return null;

            // iframeSrc = https://cloud.hownetwork.xyz/video.php?id={token}
            var token = (iframeSrc.match(/[?&]id=([^&]+)/) || [])[1] || '';
            if (!token) return null;

            var apiUrl = 'https://cloud.hownetwork.xyz/api2.php?id=' + encodeURIComponent(token);
            var res = await http_post(apiUrl, {
                'User-Agent':       UA,
                'Referer':          'https://cloud.hownetwork.xyz/',
                'X-Requested-With': 'XMLHttpRequest',
                'Content-Type':     'application/x-www-form-urlencoded',
                'Origin':           'https://cloud.hownetwork.xyz'
            }, 'r=&d=https%3A%2F%2Fcloud.hownetwork.xyz');
            var json = JSON.parse(getBody(res));
            var file = json.file || json.url || null;
            if (!file) return null;

            var q = extractQuality(file) || 'P2P';
            return new StreamResult({
                url:     file,
                quality: q,
                source:  'P2P | ' + q,
                headers: { 'Referer': 'https://cloud.hownetwork.xyz/' }
            });
        } catch (_) { return null; }
    }

    // TurboVIP — playeriframe.sbs/iframe/turbovip/{id} → emturbovid.com or turbovidhls
    async function resolveTurboVip(wrapperUrl) {
        try {
            var wrapHtml = getBody(await http_get(wrapperUrl, { ...HTML_HDR, 'Referer': BASE_URL + '/' }));
            var iframeSrc = (wrapHtml.match(/<iframe[^>]+src=["'](https?:\/\/[^"']+)["']/i) || [])[1];
            if (!iframeSrc) return null;

            var innerHtml = getBody(await http_get(iframeSrc, PLAYER_HDR));
            var src = unpackIfNeeded(innerHtml);
            var m3u8 = extractM3u8(src);
            if (!m3u8) return null;

            var q = extractQuality(m3u8) || 'Auto';
            return new StreamResult({
                url:     m3u8,
                quality: q,
                source:  'TurboVIP | ' + q,
                headers: { 'Referer': getBaseUrl(iframeSrc) + '/', 'Origin': getBaseUrl(iframeSrc) }
            });
        } catch (_) { return null; }
    }

    // Cast — playeriframe.sbs/iframe/cast/{id} → sb1254w9megshle.org/e/{id}
    async function resolveCast(wrapperUrl) {
        try {
            var wrapHtml = getBody(await http_get(wrapperUrl, { ...HTML_HDR, 'Referer': BASE_URL + '/' }));
            var iframeSrc = (wrapHtml.match(/<iframe[^>]+src=["'](https?:\/\/[^"']+)["']/i) || [])[1];
            if (!iframeSrc) return null;

            var innerHtml = getBody(await http_get(iframeSrc, PLAYER_HDR));
            var src = unpackIfNeeded(innerHtml);
            var m3u8 = extractM3u8(src);
            if (!m3u8) return null;

            var q = extractQuality(m3u8) || 'Auto';
            return new StreamResult({
                url:     m3u8,
                quality: q,
                source:  'Cast | ' + q,
                headers: { 'Referer': getBaseUrl(iframeSrc) + '/' }
            });
        } catch (_) { return null; }
    }

    // ─── Main embed dispatcher ────────────────────────────────────────────────
    async function resolveEmbed(embedUrl) {
        if (!embedUrl) return null;
        var h = embedUrl.toLowerCase();

        if (h.includes('/iframe/p2p/') || h.includes('cloud.hownetwork')) {
            var r = await resolveP2P(embedUrl); return r ? [r] : null;
        }
        if (h.includes('/iframe/turbovip/') || h.includes('emturbovid') || h.includes('turbovidhls')) {
            var r = await resolveTurboVip(embedUrl); return r ? [r] : null;
        }
        if (h.includes('/iframe/cast/') || h.includes('sb1254w9megshle')) {
            var r = await resolveCast(embedUrl); return r ? [r] : null;
        }
        // Hydrax requires CF Turnstile — skip
        return null;
    }

    // ─── getHome ──────────────────────────────────────────────────────────────
    async function getHome(cb) {
        var categories = [
            { name: 'Film Terpopuler',                url: BASE_URL   + '/populer/page/1'        },
            { name: 'Film Berdasarkan IMDb Rating',   url: BASE_URL   + '/rating/page/1'         },
            { name: 'Film Dengan Komentar Terbanyak', url: BASE_URL   + '/most-commented/page/1' },
            { name: 'Series Terbaru',                 url: SERIES_URL + '/latest-series/page/1'  },
            { name: 'Film Asian Terbaru',             url: SERIES_URL + '/series/asian/page/1'   },
            { name: 'Film Upload Terbaru',            url: BASE_URL   + '/latest/page/1'         }
        ];
        try {
            var result = {};
            await Promise.all(categories.map(async function(cat) {
                try {
                    var html = getBody(await http_get(cat.url, HTML_HDR));
                    var items = await parseArticles(html, cat.url);
                    if (items.length) result[cat.name] = items;
                } catch (_) {}
            }));
            if (!Object.keys(result).length) return cb({ success: false, error: 'Gagal memuat homepage.' });
            cb({ success: true, data: result });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    async function parseArticles(html, pageUrl) {
        var base   = getBaseUrl(pageUrl);
        var hrefs  = await parseHtml(html, 'article figure a', 'href');
        var imgs   = await parseHtml(html, 'article figure img', 'src');
        var titles = await parseHtml(html, 'article figure h3', 'text');
        var items  = [];
        for (var i = 0; i < hrefs.length; i++) {
            var href  = hrefs[i];
            var title = cleanTitle((titles[i] || '').trim());
            if (!href || !title) continue;
            items.push(new MultimediaItem({
                title:     title,
                url:       href.startsWith('http') ? href : base + href,
                posterUrl: imgs[i] || '',
                type:      'series'
            }));
        }
        return items;
    }

    // ─── search ───────────────────────────────────────────────────────────────
    async function getSearchDomain() {
        try {
            var html  = getBody(await http_get(BASE_URL, HTML_HDR));
            var match = html.match(/["'](https?:\/\/tv\d+\.lk21official\.cc)["']/i);
            if (match) return match[1];
        } catch (_) {}
        return 'https://tv10.lk21official.cc';
    }

    async function search(query, cb) {
        try {
            var searchDomain = await getSearchDomain();
            var res  = await http_get(
                'https://gudangvape.com/search.php?s=' + encodeURIComponent(query) + '&page=1',
                { 'User-Agent': UA, 'Accept': '*/*', 'X-Requested-With': 'XMLHttpRequest', 'Origin': searchDomain, 'Referer': searchDomain + '/' }
            );
            var arr = (JSON.parse(getBody(res)).data || JSON.parse(getBody(res)).items || []);
            var items = arr.map(function(item) {
                var type = item.type === 'series' ? 'series' : 'movie';
                return new MultimediaItem({
                    title:     cleanTitle((item.title || '').replace(/\(\d{4}\)$/, '').trim()),
                    url:       type === 'series' ? (SERIES_URL + '/' + item.slug) : (BASE_URL + '/' + item.slug),
                    posterUrl: item.poster ? (POSTER_CDN + item.poster) : '',
                    type:      type
                });
            }).filter(function(i) { return i.title; });
            cb({ success: true, data: items });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── load ─────────────────────────────────────────────────────────────────
    async function load(url, cb) {
        try {
            var fixedUrl = url;
            if (!url.startsWith(SERIES_URL)) {
                var res0 = await http_get(url, { ...HTML_HDR, 'Allow-Redirects': 'false' });
                var loc  = res0.headers && (res0.headers['location'] || res0.headers['Location']);
                if (loc) fixedUrl = loc;
            }
            var html = getBody(await http_get(fixedUrl, HTML_HDR));
            var base = getBaseUrl(fixedUrl);

            var title  = cleanTitle(((await parseHtml(html, 'div.movie-info h1', 'text'))[0] || '').trim()) || 'Unknown';
            var poster = (await parseHtml(html, 'meta[property="og:image"]', 'content'))[0] || '';
            var desc   = ((await parseHtml(html, 'div.meta-info', 'text'))[0] || '').trim();

            var seasonScripts = await parseHtml(html, 'script#season-data', 'html');
            var isSeries      = seasonScripts.length > 0 && seasonScripts[0];

            if (isSeries) {
                var episodes = [];
                try {
                    var root = JSON.parse(seasonScripts[0]);
                    for (var k of Object.keys(root)) {
                        for (var i = 0; i < root[k].length; i++) {
                            var ep    = root[k][i];
                            var epNum = ep.episode_no || (i + 1);
                            episodes.push(new Episode({
                                name:      'Episode ' + epNum,
                                url:       base + '/' + ep.slug,
                                season:    ep.s || 1,
                                episode:   epNum,
                                posterUrl: ep.thumbnail || ep.poster || ep.image || poster
                            }));
                        }
                    }
                } catch (_) {}
                cb({ success: true, data: new MultimediaItem({ title, url, posterUrl: poster, type: 'series', description: desc, episodes }) });
            } else {
                cb({ success: true, data: new MultimediaItem({
                    title, url, posterUrl: poster, type: 'movie', description: desc,
                    episodes: [new Episode({ name: title, url, season: 1, episode: 1, posterUrl: poster })]
                })});
            }
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── loadStreams ───────────────────────────────────────────────────────────
    async function loadStreams(url, cb) {
        try {
            var html        = getBody(await http_get(url, HTML_HDR));
            var playerHrefs = await parseHtml(html, 'ul#player-list > li a', 'href');

            if (!playerHrefs.length) return cb({ success: false, error: 'Tidak ada player ditemukan.' });

            var streams = [];
            await Promise.all(playerHrefs.map(async function(href) {
                if (!href) return;
                try {
                    var fullHref = href.startsWith('http') ? href : (getBaseUrl(url) + href);
                    var resolved = await resolveEmbed(fullHref);
                    if (resolved && resolved.length) streams = streams.concat(resolved);
                } catch (_) {}
            }));

            if (!streams.length) return cb({ success: false, error: 'Stream tidak ditemukan.' });
            cb({ success: true, data: streams });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── Expose ───────────────────────────────────────────────────────────────
    globalThis.getHome    = getHome;
    globalThis.search     = search;
    globalThis.load       = load;
    globalThis.loadStreams = loadStreams;

})();