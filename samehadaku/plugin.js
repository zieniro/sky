(function () {

    // ─────────────────────────────────────────────────────────────────────────
    // CONFIG
    // ─────────────────────────────────────────────────────────────────────────
    var MAX_RPM        = 45;          // hard cap (API limit = 50, kita pakai 45 buat buffer)
    var MIN_INTERVAL   = Math.ceil(60000 / MAX_RPM); // ~1333 ms antar request
    var CACHE_TTL      = 5 * 60000;  // 5 menit cache per URL
    var MAX_STREAMS    = 3;          // max stream yang dikumpulkan per episode (hemat request)

    var HEADERS = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':     'application/json'
    };

    // ─────────────────────────────────────────────────────────────────────────
    // RATE LIMITER — antrian serial, max MAX_RPM request/menit
    // ─────────────────────────────────────────────────────────────────────────
    var _queue         = [];
    var _running       = false;
    var _lastReqTime   = 0;
    var _reqCount      = 0;      // request dalam window 60 detik terakhir
    var _windowStart   = Date.now();

    function _resetWindowIfNeeded() {
        var now = Date.now();
        if (now - _windowStart >= 60000) {
            _reqCount    = 0;
            _windowStart = now;
        }
    }

    function _scheduleNext() {
        if (_running || _queue.length === 0) return;
        _running = true;

        var task = _queue.shift();
        _resetWindowIfNeeded();

        if (_reqCount >= MAX_RPM) {
            // Window penuh — tunda sampai window baru
            var wait = 60000 - (Date.now() - _windowStart) + 50; // +50ms jitter
            setTimeout(function () {
                _running = false;
                _queue.unshift(task);
                _scheduleNext();
            }, wait);
            return;
        }

        var now      = Date.now();
        var elapsed  = now - _lastReqTime;
        var delay    = elapsed < MIN_INTERVAL ? (MIN_INTERVAL - elapsed + Math.floor(Math.random() * 200)) : 0;

        setTimeout(function () {
            _lastReqTime = Date.now();
            _reqCount++;
            task.fn().then(function (result) {
                task.resolve(result);
            }).catch(function (err) {
                task.reject(err);
            }).finally(function () {
                _running = false;
                _scheduleNext();
            });
        }, delay);
    }

    /**
     * Semua http_get harus lewat sini.
     * Mengembalikan Promise<response>.
     */
    function rateLimitedGet(url, hdrs) {
        // Cek cache dulu
        var cached = _cacheGet(url);
        if (cached !== null) return Promise.resolve(cached);

        return new Promise(function (resolve, reject) {
            _queue.push({
                fn: function () {
                    return Promise.resolve(http_get(url, hdrs || HEADERS)).then(function (res) {
                        _cachePut(url, res);
                        return res;
                    });
                },
                resolve: resolve,
                reject:  reject
            });
            _scheduleNext();
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // IN-MEMORY CACHE
    // ─────────────────────────────────────────────────────────────────────────
    var _cache = {};

    function _cacheGet(url) {
        var entry = _cache[url];
        if (!entry) return null;
        if (Date.now() - entry.ts > CACHE_TTL) {
            delete _cache[url];
            return null;
        }
        return entry.val;
    }

    function _cachePut(url, val) {
        _cache[url] = { val: val, ts: Date.now() };
        // Bersihkan entry lama (sederhana, max 200 entry)
        var keys = Object.keys(_cache);
        if (keys.length > 200) {
            var oldest = keys.sort(function(a, b) { return _cache[a].ts - _cache[b].ts; })[0];
            delete _cache[oldest];
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HELPERS
    // ─────────────────────────────────────────────────────────────────────────
    function parseJSON(res) {
        try {
            return typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
        } catch (e) {
            throw new Error("Gagal parse JSON: " + String(e));
        }
    }

    function toItem(item, baseUrl) {
        return new MultimediaItem({
            title:     String(item.title || "No Title"),
            url:       baseUrl + "/anime/samehadaku/anime/" + item.animeId,
            posterUrl: String(item.poster || ""),
            type:      'anime'
        });
    }

    function safeGet(url, hdrs) {
        return rateLimitedGet(url, hdrs).catch(function () { return null; });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // getHome — 4 request, serial via queue → aman
    // ─────────────────────────────────────────────────────────────────────────
    async function getHome(cb) {
        try {
            var base   = manifest.baseUrl;
            var result = {};

            var categories = [
                { key: "Terbaru",   path: "/anime/samehadaku/recent"    },
                { key: "Ongoing",   path: "/anime/samehadaku/ongoing"   },
                { key: "Completed", path: "/anime/samehadaku/completed" },
                { key: "Movies",    path: "/anime/samehadaku/movies"    }
            ];

            for (var ci = 0; ci < categories.length; ci++) {
                try {
                    var cat  = categories[ci];
                    var res  = await rateLimitedGet(base + cat.path);
                    if (!res) continue;
                    var json = parseJSON(res);
                    var list = ((json.data && json.data.animeList) ? json.data.animeList : [])
                        .map(function (i) { return toItem(i, base); });
                    if (list.length > 0) result[cat.key] = list;
                } catch (_) {}
            }

            if (Object.keys(result).length === 0) {
                cb({ success: false, error: "Tidak ada data dari API." });
                return;
            }
            cb({ success: true, data: result });
        } catch (e) {
            cb({ success: false, error: String(e) });
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // search — 1 request
    // ─────────────────────────────────────────────────────────────────────────
    async function search(query, cb) {
        try {
            var base = manifest.baseUrl;
            var res  = await rateLimitedGet(base + "/anime/samehadaku/search?q=" + encodeURIComponent(query));
            var json = parseJSON(res);
            var items = ((json.data && json.data.animeList) ? json.data.animeList : [])
                .map(function (i) { return toItem(i, base); });
            cb({ success: true, data: items });
        } catch (e) {
            cb({ success: false, error: String(e) });
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // load — 1 request
    // ─────────────────────────────────────────────────────────────────────────
    async function load(url, cb) {
        try {
            var base  = manifest.baseUrl;
            var res   = await rateLimitedGet(url);
            var json  = parseJSON(res);
            var anime = json.data || {};

            var synopsis = (anime.synopsis && anime.synopsis.paragraphs)
                ? anime.synopsis.paragraphs.join("\n\n")
                : "";

            var animePoster = String(anime.poster || "");
            var episodeList = anime.episodeList || [];

            var episodes = episodeList.slice().reverse().map(function (ep, index) {
                var epNum = parseFloat(ep.title) || (index + 1);
                return new Episode({
                    name:      "Episode " + ep.title,
                    posterUrl: ep.poster ? String(ep.poster) : animePoster,
                    url:       base + "/anime/samehadaku/episode/" + ep.episodeId,
                    season:    1,
                    episode:   epNum,
                    dubStatus: "subbed"
                });
            });

            var rawStatus = String(anime.status || "").toLowerCase();
            var status = (rawStatus.includes("complet") || rawStatus.includes("tamat"))
                ? "completed"
                : "ongoing";

            var score = parseFloat(anime.score || anime.rating || anime.voteAverage || 0) || undefined;

            cb({
                success: true,
                data: new MultimediaItem({
                    title:       String(anime.title || ""),
                    url:         url,
                    posterUrl:   animePoster,
                    type:        'anime',
                    description: synopsis,
                    status:      status,
                    score:       score,
                    episodes:    episodes
                })
            });
        } catch (e) {
            cb({ success: false, error: String(e) });
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // loadStreams — PALING boros request, dioptimasi ketat
    //
    // Strategi:
    //   1. Ambil episode page → 1 request
    //   2. Iterasi quality, untuk setiap quality coba server satu per satu
    //      → stop begitu dapat stream valid (early exit per quality)
    //   3. Stop total setelah kumpulkan MAX_STREAMS stream
    //   4. Semua via rateLimitedGet (queue + cache)
    // ─────────────────────────────────────────────────────────────────────────
    async function loadStreams(url, cb) {
        try {
            var base    = manifest.baseUrl;
            var res     = await rateLimitedGet(url);
            var json    = parseJSON(res);
            var epData  = json.data || {};
            var streams = [];

            var qualities = (epData.server && epData.server.qualities)
                ? epData.server.qualities
                : [];

            outer:
            for (var qi = 0; qi < qualities.length; qi++) {
                var q       = qualities[qi];
                var qTitle  = String(q.title || "").toLowerCase();
                if (!q.title || qTitle === "unknown") continue;

                var srvList = q.serverList || [];

                for (var si = 0; si < srvList.length; si++) {
                    var srv = srvList[si];
                    if (!srv.href) continue;

                    try {
                        var srvUrl  = base + "/anime" + srv.href;
                        var srvRes  = await rateLimitedGet(srvUrl);
                        if (!srvRes) continue;

                        var srvJson = parseJSON(srvRes);
                        if (!srvJson.data || !srvJson.data.url) continue;

                        var streamUrl = srvJson.data.url;

                        // Resolve Blogger embed jika perlu
                        if (streamUrl.indexOf("blogger.com/video") !== -1) {
                            var resolved = await resolveBlogger(streamUrl);
                            if (!resolved) continue;
                            streamUrl = resolved;
                        }

                        streams.push(new StreamResult({
                            url:     streamUrl,
                            source:  String(srv.title || ""),
                            headers: { "Referer": "https://v2.samehadaku.how/" }
                        }));

                        // Dapat 1 stream per quality sudah cukup → pindah quality berikutnya
                        break;

                    } catch (_) {
                        // Server ini gagal, coba server berikutnya dalam quality yang sama
                        continue;
                    }
                }

                // Sudah cukup stream? Berhenti total
                if (streams.length >= MAX_STREAMS) break outer;
            }

            if (streams.length === 0) {
                cb({ success: false, error: "Tidak ada stream ditemukan." });
                return;
            }
            cb({ success: true, data: streams });
        } catch (e) {
            cb({ success: false, error: String(e) });
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // resolveBlogger — 1 extra request, lewat queue juga
    // ─────────────────────────────────────────────────────────────────────────
    async function resolveBlogger(embedUrl) {
        try {
            var res = await rateLimitedGet(embedUrl, { "User-Agent": "Mozilla/5.0" });
            if (!res) return null;
            var match = res.body.match(/"play_url"\s*:\s*"([^"]+)"/)
                     || res.body.match(/"iurl"\s*:\s*"([^"]+)"/);
            if (!match) return null;
            return match[1]
                .replace(/\\u003d/g, "=")
                .replace(/\\u0026/g, "&")
                .replace(/\\\//g, "/");
        } catch (_) {
            return null;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    globalThis.getHome     = getHome;
    globalThis.search      = search;
    globalThis.load        = load;
    globalThis.loadStreams = loadStreams;

})();