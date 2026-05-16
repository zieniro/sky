(function () {

    // ─────────────────────────────────────────────────────────────────────────
    // CONFIG
    // ─────────────────────────────────────────────────────────────────────────
    var MAX_RPM      = 40;                          // batas aman di bawah 50
    var MIN_INTERVAL = Math.ceil(60000 / MAX_RPM);  // ~1500ms antar request
    var CACHE_TTL    = 5 * 60000;                   // 5 menit cache untuk API statis
    var MAX_STREAMS  = 3;

    // Priority server per kualitas — lebih kiri = dicoba lebih dulu
    // filedon: 1 req saja (URL langsung di HTML) → paling hemat RPM
    var SERVER_PRIORITY = ["filedon", "ondesu", "vidhide", "odstream", "otakuwatch", "mega"];

    var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    var JSON_HEADERS = { 'User-Agent': UA, 'Accept': 'application/json' };
    var HTML_HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

    // ─────────────────────────────────────────────────────────────────────────
    // RATE LIMITER — sequential queue, satu request selesai baru berikutnya.
    // Ini otomatis menjaga ≤40 RPM tanpa logic tambahan.
    // ─────────────────────────────────────────────────────────────────────────
    var _queue       = [];
    var _running     = false;
    var _lastReqTime = 0;
    var _reqCount    = 0;
    var _windowStart = Date.now();

    function _resetWindow() {
        var now = Date.now();
        if (now - _windowStart >= 60000) { _reqCount = 0; _windowStart = now; }
    }

    function _scheduleNext() {
        if (_running || _queue.length === 0) return;
        _running = true;
        var task = _queue.shift();
        _resetWindow();

        if (_reqCount >= MAX_RPM) {
            var wait = 60000 - (Date.now() - _windowStart) + 200;
            setTimeout(function () { _running = false; _queue.unshift(task); _scheduleNext(); }, wait);
            return;
        }

        var elapsed = Date.now() - _lastReqTime;
        var delay   = elapsed < MIN_INTERVAL ? (MIN_INTERVAL - elapsed + Math.floor(Math.random() * 100)) : 0;

        setTimeout(function () {
            _lastReqTime = Date.now();
            _reqCount++;
            task.fn()
                .then(task.resolve)
                .catch(task.reject)
                .finally(function () { _running = false; _scheduleNext(); });
        }, delay);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CACHE — hanya untuk endpoint statis (home, search, anime detail)
    // ─────────────────────────────────────────────────────────────────────────
    var _cache = {};

    function _cacheGet(url) {
        var e = _cache[url];
        if (!e) return null;
        if (Date.now() - e.ts > CACHE_TTL) { delete _cache[url]; return null; }
        return e.val;
    }

    function _cachePut(url, val) {
        _cache[url] = { val: val, ts: Date.now() };
        var keys = Object.keys(_cache);
        if (keys.length > 200) {
            delete _cache[keys.sort(function (a, b) { return _cache[a].ts - _cache[b].ts; })[0]];
        }
    }

    /** rateLimitedGet — JSON API yang bisa di-cache */
    function rateLimitedGet(url, hdrs) {
        var cached = _cacheGet(url);
        if (cached !== null) return Promise.resolve(cached);
        return new Promise(function (resolve, reject) {
            _queue.push({
                fn: function () {
                    return Promise.resolve(http_get(url, hdrs || JSON_HEADERS)).then(function (res) {
                        _cachePut(url, res); return res;
                    });
                },
                resolve: resolve, reject: reject
            });
            _scheduleNext();
        });
    }

    /** rawGet — embed player / server token URL, TIDAK di-cache */
    function rawGet(url, hdrs) {
        return new Promise(function (resolve, reject) {
            _queue.push({
                fn: function () { return Promise.resolve(http_get(url, hdrs || JSON_HEADERS)); },
                resolve: resolve, reject: reject
            });
            _scheduleNext();
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HELPERS
    // ─────────────────────────────────────────────────────────────────────────
    function parseJSON(res) {
        try { return typeof res.body === 'string' ? JSON.parse(res.body) : res.body; }
        catch (e) { throw new Error("Gagal parse JSON: " + String(e)); }
    }

    function getBody(res) {
        if (!res) return "";
        if (typeof res === "string") return res;
        if (typeof res.body === "string") return res.body;
        return String(res.body || "");
    }

    function toItem(item, baseUrl) {
        return new MultimediaItem({
            title:     String(item.title || "No Title"),
            url:       baseUrl + item.href,
            posterUrl: String(item.poster || ""),
            type:      'anime'
        });
    }

    function sortServers(list) {
        return list.slice().sort(function (a, b) {
            var an = String(a.title || "").toLowerCase().trim();
            var bn = String(b.title || "").toLowerCase().trim();
            function rank(n) {
                for (var i = 0; i < SERVER_PRIORITY.length; i++) {
                    if (n.includes(SERVER_PRIORITY[i])) return i;
                }
                return 999;
            }
            return rank(an) - rank(bn);
        });
    }

    function isPlayable(url) {
        return /\.(mp4|m3u8|webm)/i.test(url)
            || url.indexOf('X-Amz')               !== -1
            || url.indexOf('cloudflarestorage')    !== -1
            || url.indexOf('googlevideo')          !== -1
            || url.indexOf('archive.org/download') !== -1;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STREAM RESOLVERS
    // Setiap resolver return { url, referer } atau null
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * resolveFiledon
     * Filedon adalah Inertia SPA — URL mp4/S3 ada di atribut data-page sebagai JSON.
     * Hanya butuh 1 HTTP request → paling hemat RPM.
     * URL adalah pre-signed Cloudflare R2, expire ~1 jam.
     */
    async function resolveFiledon(embedUrl) {
        try {
            var res  = await rawGet(embedUrl, Object.assign({}, HTML_HEADERS, { 'Referer': 'https://otakudesu.blog/' }));
            var body = getBody(res);
            if (!body) return null;

            var m = body.match(/data-page="([^"]+)"/);
            if (!m) return null;

            var page = JSON.parse(
                m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
                    .replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            );

            var mp4 = page.props && page.props.url;
            if (!mp4 || typeof mp4 !== 'string') return null;
            if (!isPlayable(mp4) && mp4.indexOf('.r2.') === -1) return null;

            return { url: mp4, referer: 'https://filedon.co/' };
        } catch (_) { return null; }
    }

    /**
     * resolveOndesu
     * Ondesu = wrapper iframe yang embed Blogger video.
     * Flow: fetch ondesu HTML → ambil iframe src (Blogger URL) → resolveBlogger.
     * Total: 2 request (ondesu + Blogger).
     */
    async function resolveOndesu(embedUrl, episodeReferer) {
        try {
            var res  = await rawGet(embedUrl, Object.assign({}, HTML_HEADERS, { 'Referer': episodeReferer }));
            var body = getBody(res);
            if (!body) return null;

            // Cari iframe src yang berisi Blogger URL
            var m = body.match(/<iframe[^>]+src=["']([^"']*draft\.blogger\.com[^"']*)["']/i)
                 || body.match(/<iframe[^>]+src=["'](https?:\/\/[^"']*blogger\.com\/video[^"']*)["']/i)
                 || body.match(/src=["'](https?:\/\/[^"']+blogger[^"']*)["']/i);

            if (!m || !m[1]) return null;
            var bloggerUrl = m[1];

            // Sudah googlevideo — tidak perlu resolve lagi
            if (bloggerUrl.indexOf('googlevideo.com') !== -1) {
                return { url: bloggerUrl, referer: 'https://www.blogger.com/' };
            }

            return await resolveBlogger(bloggerUrl);
        } catch (_) { return null; }
    }

    /**
     * resolveBlogger
     * Fetch Blogger video embed page, ekstrak play_url (googlevideo CDN).
     */
    async function resolveBlogger(embedUrl) {
        try {
            var res  = await rawGet(embedUrl, { 'User-Agent': UA });
            var body = getBody(res);
            if (!body) return null;

            var m = body.match(/"play_url"\s*:\s*"([^"]+)"/)
                 || body.match(/"iurl"\s*:\s*"([^"]+)"/);
            if (!m) return null;

            var streamUrl = m[1]
                .replace(/\\u003d/g, '=').replace(/\\u0026/g, '&').replace(/\\\//g, '/');

            return { url: streamUrl, referer: 'https://www.blogger.com/' };
        } catch (_) { return null; }
    }

    /**
     * resolveVidHide (odvidhide.com dan sejenisnya)
     * JWPlayer embed dengan JS ter-obfuscate via Dean Edwards packer.
     * URL m3u8 tersimpan di word list split('|') pada eval() terpack.
     * Kita ekstrak tanpa execute JS — hanya regex pada source.
     */
    async function resolveVidHide(embedUrl, episodeReferer) {
        try {
            var res  = await rawGet(embedUrl, Object.assign({}, HTML_HEADERS, { 'Referer': episodeReferer }));
            var body = getBody(res);
            if (!body) return null;

            var origin = '';
            try { origin = 'https://' + new URL(embedUrl).hostname + '/'; } catch (_) {}

            // Strategi 1: m3u8 URL terlihat langsung di source
            var m = body.match(/["'](https?:\/\/[^"']+\.m3u8[^"']{0,300}?)["']/i);
            if (m && m[1]) return { url: m[1], referer: origin };

            // Strategi 2: Ekstrak dari Dean Edwards packed JS
            // Format: eval(function(p,a,c,k,e,d){...}('ENCODED',BASE,COUNT,'w1|w2|...'.split('|')))
            var packMatch = body.match(/\}\s*\('([\s\S]+?)',\s*(\d+)\s*,\s*\d+\s*,\s*'([\s\S]+?)'\.split\('\|'\)\s*\)/);
            if (packMatch) {
                var words = packMatch[3].split('|');
                // Cari kata yang berupa URL m3u8 atau mp4
                for (var wi = 0; wi < words.length; wi++) {
                    var w = words[wi];
                    if (w.length > 10 && (/\.m3u8/i.test(w) || /\.mp4/i.test(w))) {
                        if (!w.startsWith('http')) w = 'https://' + w;
                        return { url: w, referer: origin };
                    }
                }
                // Cari URL CDN dari fragment potongan words (kadang URL terpecah antar index)
                // Cari semua kata yang mengandung domain CDN umum
                var cdnFragments = words.filter(function (w) {
                    return w.length > 5 && (
                        w.indexOf('cdn') !== -1 || w.indexOf('stream') !== -1 ||
                        w.indexOf('video') !== -1 || w.indexOf('media') !== -1
                    );
                });
                // Coba gabungkan dengan kata berikutnya jika mengandung ekstensi video
                for (var ci = 0; ci < cdnFragments.length; ci++) {
                    var idx = words.indexOf(cdnFragments[ci]);
                    if (idx >= 0 && idx + 1 < words.length) {
                        var combined = cdnFragments[ci] + '/' + words[idx + 1];
                        if (/\.m3u8|\.mp4/i.test(combined)) {
                            if (!combined.startsWith('http')) combined = 'https://' + combined;
                            return { url: combined, referer: origin };
                        }
                    }
                }
            }

            // Strategi 3: Cari URL video apapun di source
            m = body.match(/["'](https?:\/\/[^"']{15,}\.(?:mp4|m3u8|webm)[^"']{0,300}?)["']/i);
            if (m && m[1]) return { url: m[1], referer: origin };

            return null;
        } catch (_) { return null; }
    }

    /**
     * resolveDesustream — embed HTML standar (fallback untuk server tidak dikenal)
     */
    async function resolveDesustream(embedUrl, episodeReferer) {
        try {
            var res  = await rawGet(embedUrl, Object.assign({}, HTML_HEADERS, { 'Referer': episodeReferer }));
            var body = getBody(res);
            if (!body) return null;

            var m =
                body.match(/<source[^>]+src=["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i) ||
                body.match(/file\s*:\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/i) ||
                body.match(/src\s*:\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/i) ||
                body.match(/["'](https?:\/\/[^"']{15,}\.(?:mp4|m3u8)[^"']{0,300}?)["']/i);

            if (!m || !m[1]) return null;

            var ref = m[1].indexOf('archive.org') !== -1 ? 'https://archive.org/' : '';
            try { if (!ref) ref = new URL(embedUrl).origin + '/'; } catch (_) { ref = episodeReferer; }

            return { url: m[1], referer: ref };
        } catch (_) { return null; }
    }

    /**
     * resolveAny — dispatcher utama berdasarkan domain/nama server
     */
    async function resolveAny(embedUrl, serverName, episodeReferer) {
        try {
            if (/\.(mp4|m3u8|webm)(\?|$)/i.test(embedUrl)) {
                try { return { url: embedUrl, referer: new URL(embedUrl).origin + '/' }; }
                catch (_) { return { url: embedUrl, referer: episodeReferer }; }
            }
            if (embedUrl.indexOf('archive.org')   !== -1) return { url: embedUrl, referer: 'https://archive.org/' };
            if (embedUrl.indexOf('googlevideo')    !== -1) return { url: embedUrl, referer: 'https://www.blogger.com/' };
            if (embedUrl.indexOf('filedon')        !== -1 || serverName.includes('filedon'))    return await resolveFiledon(embedUrl);
            if (embedUrl.indexOf('blogger.com/video') !== -1 || serverName.includes('blogger')) return await resolveBlogger(embedUrl);
            if (embedUrl.indexOf('ondesu')         !== -1 || serverName.includes('ondesu'))     return await resolveOndesu(embedUrl, episodeReferer);
            if (embedUrl.indexOf('vidhide')        !== -1 || embedUrl.indexOf('odvidhide') !== -1
                || serverName.includes('vidhide'))                                               return await resolveVidHide(embedUrl, episodeReferer);
            return await resolveDesustream(embedUrl, episodeReferer);
        } catch (_) { return null; }
    }

    function getLabel(streamUrl, serverName) {
        if (streamUrl.indexOf('cloudflarestorage') !== -1 || streamUrl.indexOf('filedon') !== -1) return 'Filedon';
        if (streamUrl.indexOf('archive.org')       !== -1) return 'Archive';
        if (streamUrl.indexOf('googlevideo')        !== -1) return 'Blogger';
        if (serverName.includes('vidhide'))                 return 'VidHide';
        if (serverName.includes('ondesu'))                  return 'OnDesu';
        if (serverName.includes('filedon'))                 return 'Filedon';
        if (serverName.includes('otakuwatch'))              return 'OtakuWatch';
        if (serverName.includes('odstream'))                return 'ODStream';
        return 'Stream';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CORE EXTENSION METHODS
    // ─────────────────────────────────────────────────────────────────────────

    async function getHome(cb) {
        try {
            var base = manifest.baseUrl, result = {};
            try {
                var rh = await rateLimitedGet(base + '/anime/home');
                var jh = parseJSON(rh), hd = jh.data || {};
                var ol = hd.ongoing  && hd.ongoing.animeList  ? hd.ongoing.animeList  : [];
                var cl = hd.complete && hd.complete.animeList ? hd.complete.animeList : [];
                if (ol.length > 0) result['Ongoing']   = ol.map(function (i) { return toItem(i, base); });
                if (cl.length > 0) result['Completed'] = cl.map(function (i) { return toItem(i, base); });
            } catch (_) {}

            var fallbacks = [
                { key: 'Ongoing',   path: '/anime/ongoing-anime'  },
                { key: 'Completed', path: '/anime/complete-anime' }
            ];
            for (var fi = 0; fi < fallbacks.length; fi++) {
                var cat = fallbacks[fi];
                if (result[cat.key]) continue;
                try {
                    var r  = await rateLimitedGet(base + cat.path);
                    var j  = parseJSON(r);
                    var ls = (j.data && j.data.animeList ? j.data.animeList : [])
                        .map(function (i) { return toItem(i, base); });
                    if (ls.length > 0) result[cat.key] = ls;
                } catch (_) {}
            }

            if (Object.keys(result).length === 0) { cb({ success: false, error: 'Tidak ada data.' }); return; }
            cb({ success: true, data: result });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    async function search(query, cb) {
        try {
            var base  = manifest.baseUrl;
            var res   = await rateLimitedGet(base + '/anime/search/' + encodeURIComponent(query));
            var json  = parseJSON(res);
            var items = (json.data && json.data.animeList ? json.data.animeList : [])
                .map(function (i) { return toItem(i, base); });
            cb({ success: true, data: items });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    async function load(url, cb) {
        try {
            var res   = await rateLimitedGet(url);
            var json  = parseJSON(res);
            var anime = json.data || {};

            var synopsis = anime.synopsis && anime.synopsis.paragraphs
                ? anime.synopsis.paragraphs.join('\n\n')
                : (typeof anime.synopsis === 'string' ? anime.synopsis : '');

            var poster      = String(anime.poster || '');
            var episodeList = anime.episodeList || [];

            var episodes = episodeList.slice().reverse().map(function (ep, idx) {
                var epNum = parseFloat(ep.eps || ep.episode) || (idx + 1);
                return new Episode({
                    name:      'Episode ' + (ep.title || ep.episode || (idx + 1)),
                    posterUrl: ep.poster ? String(ep.poster) : poster,
                    url:       manifest.baseUrl + ep.href,
                    season:    1,
                    episode:   epNum,
                    dubStatus: 'subbed'
                });
            });

            var rawStatus = String(anime.status || '').toLowerCase();
            var status    = rawStatus.includes('complet') || rawStatus.includes('tamat') ? 'completed' : 'ongoing';
            var score     = parseFloat(anime.score || anime.rating || anime.voteAverage || 0) || undefined;

            cb({
                success: true,
                data: new MultimediaItem({
                    title: String(anime.title || ''), url, posterUrl: poster,
                    type: 'anime', description: synopsis, status, score, episodes
                })
            });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    async function loadStreams(url, cb) {
        try {
            var base = manifest.baseUrl;

            // Budget request: maks 12 per loadStreams call
            // Worst case: 1 (episode) + 3 kualitas × (1 server + 2 resolve) = 10 → aman
            var budget = 12;

            // ── Fetch episode data ──
            budget--;
            var res    = await rawGet(url, JSON_HEADERS);
            var json   = parseJSON(res);
            var epData = json.data || {};

            var episodeReferer = epData.otakudesuUrl
                ? String(epData.otakudesuUrl)
                : 'https://otakudesu.blog/';

            var serverQualities = epData.server && epData.server.qualities
                ? epData.server.qualities : [];

            // Sort kualitas: 720p → 480p → 360p
            var qOrder = { '720p': 0, '480p': 1, '360p': 2 };
            var sortedQ = serverQualities.slice().sort(function (a, b) {
                var ai = qOrder[a.title] !== undefined ? qOrder[a.title] : 99;
                var bi = qOrder[b.title] !== undefined ? qOrder[b.title] : 99;
                return ai - bi;
            });

            var streams = [];

            outerQ:
            for (var qi = 0; qi < sortedQ.length; qi++) {
                var q      = sortedQ[qi];
                var qTitle = String(q.title || '').trim();
                if (!qTitle || qTitle.toLowerCase() === 'unknown') continue;
                if (!q.serverList || q.serverList.length === 0)    continue;

                // Stop jika budget tidak cukup untuk minimal 1 server (2 req: server + resolve)
                if (budget < 2) break outerQ;

                var sortedSrv = sortServers(q.serverList);

                for (var si = 0; si < sortedSrv.length; si++) {
                    if (budget < 2) break outerQ;

                    var srv        = sortedSrv[si];
                    var serverName = String(srv.title || '').toLowerCase().trim();
                    var srvPath    = srv.href
                        ? (base + srv.href)
                        : (base + '/anime/server/' + srv.serverId);

                    try {
                        // Fetch server URL
                        budget--;
                        var srvRes  = await rawGet(srvPath, JSON_HEADERS);
                        if (!srvRes) { budget++; continue; }

                        var srvJson = parseJSON(srvRes);
                        if (!srvJson.data || !srvJson.data.url) continue;

                        var embedUrl = String(srvJson.data.url).trim();
                        if (!embedUrl) continue;

                        // Resolve stream URL (bisa butuh 1-2 request tergantung resolver)
                        budget--;
                        var resolved = await resolveAny(embedUrl, serverName, episodeReferer);

                        if (!resolved || !resolved.url || !isPlayable(resolved.url)) {
                            budget++; // kembalikan budget jika gagal
                            continue;
                        }

                        streams.push(new StreamResult({
                            url:     resolved.url,
                            source:  getLabel(resolved.url, serverName) + ' [' + qTitle + ']',
                            headers: { 'User-Agent': UA, 'Referer': resolved.referer }
                        }));

                        break; // berhasil untuk kualitas ini

                    } catch (_) { budget++; continue; }
                }

                if (streams.length >= MAX_STREAMS) break outerQ;
            }

            if (streams.length === 0) {
                cb({ success: false, error: 'Gagal mengekstrak stream video.' });
                return;
            }
            cb({ success: true, data: streams });

        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EXPOSE
    // ─────────────────────────────────────────────────────────────────────────
    globalThis.getHome     = getHome;
    globalThis.search      = search;
    globalThis.load        = load;
    globalThis.loadStreams = loadStreams;

})();