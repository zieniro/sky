(function () {

    var headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
    };

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

    // ── getHome ───────────────────────────────────────────────────────────────
    async function getHome(cb) {
        try {
            var base   = manifest.baseUrl;
            var result = {};

            var categories = [
                { key: "Terbaru",       path: "/anime/samehadaku/recent"    },
                { key: "Ongoing",       path: "/anime/samehadaku/ongoing"   },
                { key: "Completed",     path: "/anime/samehadaku/completed" },
                { key: "Movies",        path: "/anime/samehadaku/movies"    }
            ];

            for (var ci = 0; ci < categories.length; ci++) {
                try {
                    var cat  = categories[ci];
                    var res  = await http_get(base + cat.path, headers);
                    var json = parseJSON(res);
                    var list = ((json.data && json.data.animeList) ? json.data.animeList : [])
                        .map(function(i) { return toItem(i, base); });
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

    // ── search ────────────────────────────────────────────────────────────────
    async function search(query, cb) {
        try {
            var base = manifest.baseUrl;
            var res  = await http_get(base + "/anime/samehadaku/search?q=" + encodeURIComponent(query), headers);
            var json = parseJSON(res);
            var items = ((json.data && json.data.animeList) ? json.data.animeList : [])
                .map(function(i) { return toItem(i, base); });
            cb({ success: true, data: items });
        } catch (e) {
            cb({ success: false, error: String(e) });
        }
    }

    // ── load ──────────────────────────────────────────────────────────────────
    async function load(url, cb) {
        try {
            var base  = manifest.baseUrl;
            var res   = await http_get(url, headers);
            var json  = parseJSON(res);
            var anime = json.data || {};

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

            // Status: cek field status dari API, fallback ke ongoing
            var rawStatus = String(anime.status || "").toLowerCase();
            var status = rawStatus.includes("complet") || rawStatus.includes("tamat") ? "completed" : "ongoing";

            // Score: cek beberapa kemungkinan field nama dari API
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

    // ── loadStreams ───────────────────────────────────────────────────────────
    async function loadStreams(url, cb) {
        try {
            var base    = manifest.baseUrl;
            var res     = await http_get(url, headers);
            var json    = parseJSON(res);
            var epData  = json.data || {};
            var streams = [];

            var qualities = (epData.server && epData.server.qualities) ? epData.server.qualities : [];
            for (var qi = 0; qi < qualities.length; qi++) {
                var q = qualities[qi];
                if (!q.title || q.title === "unknown") continue;
                var srvList = q.serverList || [];
                for (var si = 0; si < srvList.length; si++) {
                    var srv = srvList[si];
                    if (!srv.href) continue;
                    try {
                        var srvUrl  = base + "/anime" + srv.href;
                        var srvRes  = await http_get(srvUrl, headers);
                        var srvJson = parseJSON(srvRes);
                        if (srvJson.data && srvJson.data.url) {
                            var streamUrl = srvJson.data.url;
                            if (streamUrl.indexOf("blogger.com/video") !== -1) {
                                var resolved = await resolveBlogger(streamUrl);
                                if (resolved) streamUrl = resolved;
                                else continue;
                            }
                            streams.push(new StreamResult({
                                url:     streamUrl,
                                source:  String(srv.title || q.title),
                                headers: { "Referer": "https://v2.samehadaku.how/" }
                            }));
                        }
                    } catch (_) {}
                }
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

    // ── Resolve Blogger embed → MP4 langsung ─────────────────────────────────
    async function resolveBlogger(embedUrl) {
        try {
            var res   = await http_get(embedUrl, { "User-Agent": "Mozilla/5.0" });
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

    globalThis.getHome     = getHome;
    globalThis.search      = search;
    globalThis.load        = load;
    globalThis.loadStreams = loadStreams;

})();