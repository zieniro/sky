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
            
            if (!res || !res.body) {
                cb({ success: false, error: "Respon API kosong atau bermasalah." });
                return;
            }

            var json  = parseJSON(res);
            var anime = json.data || {};

            // FORCE TO STRING & TRIM: Paksa konversi ke primitif string untuk memutus 
            // referensi objek async yang mungkin hilang di runtime CloudStream
            var animeTitle = "";
            if (anime.title) {
                animeTitle = String(anime.title).trim();
            } else if (anime.name) {
                animeTitle = String(anime.name).trim();
            }

            // Jika masih kosong karena masalah parsing, ambil potongan URL akhir sebagai penyelamat
            if (!animeTitle || animeTitle === "undefined" || animeTitle === "") {
                var urlParts = url.split('/');
                var slug = urlParts[urlParts.length - 1] || "Anime Detail";
                animeTitle = slug.replace(/-/g, ' ').toUpperCase();
            }

            var synopsis = (anime.synopsis && anime.synopsis.paragraphs)
                ? anime.synopsis.paragraphs.join("\n\n")
                : "";

            var animePoster = String(anime.poster || "");
            var episodeList = anime.episodeList || [];
            
            var episodes = episodeList.slice().reverse().map(function(ep, index) {
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
            var status = rawStatus.includes("complet") || rawStatus.includes("tamat") ? "completed" : "ongoing";

            var score = parseFloat(anime.score || anime.rating || anime.voteAverage || 0) || undefined;

            cb({
                success: true,
                data: new MultimediaItem({
                    title:       animeTitle, // <-- Menggunakan string murni yang sudah diamankan
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
    // loadStreams — Dioptimasi Khusus untuk Blogger, Wibufile, & Pixeldrain
    // Sangat Stabil, Anti-Stuck, & Aman dari Limitasi 50 RPM
    // ─────────────────────────────────────────────────────────────────────────
    async function loadStreams(url, cb) {
        try {
            var base    = manifest.baseUrl;
            var res     = await rateLimitedGet(url); // Request ke-1 (Halaman episode)
            var json    = parseJSON(res);
            var epData  = json.data || {};
            var streams = [];

            var serverQualities = (epData.server && epData.server.qualities)
                ? epData.server.qualities
                : [];

            outerServer:
            for (var qi = 0; qi < serverQualities.length; qi++) {
                var q = serverQualities[qi];
                var qTitle = String(q.title || "").toLowerCase();
                
                if (!q.title || qTitle === "unknown") continue;

                var srvList = q.serverList || [];

                for (var si = 0; si < srvList.length; si++) {
                    var srv = srvList[si];
                    if (!srv.href) continue;

                    try {
                        var srvUrl  = base + "/anime" + srv.href;
                        var srvRes  = await rateLimitedGet(srvUrl); // Ambil URL stream (Ikut antrean aman)
                        if (!srvRes) continue;

                        var srvJson = parseJSON(srvRes);
                        if (!srvJson.data || !srvJson.data.url) continue;

                        var streamUrl  = String(srvJson.data.url).trim();
                        var serverName = String(srv.title || "").toLowerCase();
                        var isValidSource = false;

                        // ── 1. JALUR OPTIMASI: BLOGGER ──
                        if (streamUrl.indexOf("blogger.com/video") !== -1 || serverName.includes("blogger") || serverName.includes("blogpost")) {
                            var resolvedBlogger = await resolveBlogger(streamUrl);
                            if (resolvedBlogger) {
                                streamUrl = resolvedBlogger;
                                isValidSource = true;
                            }
                        }
                        
                        // ── 2. JALUR OPTIMASI: PIXELDRAIN (Instant Rewrite) ──
                        else if (streamUrl.indexOf("pixeldrain.com/u/") !== -1 || serverName.includes("pixeldrain")) {
                            streamUrl = streamUrl.replace("pixeldrain.com/u/", "pixeldrain.com/api/file/");
                            isValidSource = true;
                        }

                        // ── 3. JALUR OPTIMASI: WIBUFILE (Direct Link .mp4) ──
                        else if (streamUrl.indexOf("wibufile.com") !== -1 || serverName.includes("wibufile")) {
                            // Wibufile biasanya langsung mengembalikan direct link murni (.mp4)
                            if (streamUrl.indexOf("http") !== -1) {
                                isValidSource = true;
                            }
                        }

                        // Jika lolos dari salah satu 3 pilar server di atas, bungkus ke StreamResult
                        if (isValidSource) {
                            streams.push(new StreamResult({
                                url:     streamUrl,
                                source:  String(srv.title || "Server") + " - " + q.title,
                                headers: { 
                                    "Referer": "https://v2.samehadaku.how/",
                                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
                                }
                            }));

                            // Early Exit: Jika kualitas ini (misal 720p) sudah dapat 1 server valid, 
                            // langsung lompat ke kualitas berikutnya demi hemat kuota RPM!
                            break;
                        }

                    } catch (_) {
                        continue; // Lewati server yang error, coba alternatif lainnya
                    }
                }

                // Jika total stream yang dikumpulkan sudah mencukupi target maksimal, hentikan pencarian
                if (streams.length >= MAX_STREAMS) break outerServer;
            }

            // Validasi hasil akhir
            if (streams.length === 0) {
                cb({ success: false, error: "Tidak ada stream dari Blogger/Wibufile/Pixeldrain yang siap putar." });
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