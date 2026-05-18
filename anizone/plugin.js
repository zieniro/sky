(function () {

    // ─── Constants & Headers ──────────────────────────────────────────────────
    var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    var HTML_HEADERS = {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
    };

    var manifest = {
        baseUrl: "https://anizone.to"
    };

    // ─── Helpers ──────────────────────────────────────────────────────────────
    function getBody(res) {
        if (!res) return '';
        if (typeof res === 'string') return res;
        if (res.body) return typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
        return String(res);
    }

    async function parseHtml(html, selector, attrType) {
        try {
            var raw = await parse_html(html, selector, attrType);
            if (!Array.isArray(raw)) return [];
            return raw.map(function (item) {
                if (!item) return '';
                if (typeof item === 'string') return item;
                if (attrType === 'text') return item.text || '';
                return item.attr || item[attrType] || '';
            });
        } catch (_) { return []; }
    }

    // ─── Core Methods ─────────────────────────────────────────────────────────

    // Home
    async function getHome(cb) {
        try {
            var base = manifest.baseUrl;
            var html = getBody(await http_get(base, HTML_HEADERS));
            if (!html) return cb({ success: false, error: 'Gagal memuat HTML.' });

            var links   = await parseHtml(html, '.swiper-wrapper .swiper-slide .line-clamp-2 a', 'href');
            var titles  = await parseHtml(html, '.swiper-wrapper .swiper-slide .line-clamp-2 a', 'text');
            var posters = await parseHtml(html, '.swiper-wrapper .swiper-slide img', 'src');

            var animeItems = [];
            var totalItems = Math.min(links.length, titles.length, posters.length);

            for (var i = 0; i < totalItems; i++) {
                var href = links[i];
                if (!href) continue;
                animeItems.push(new MultimediaItem({
                    title:     (titles[i] || 'No Title').trim(),
                    url:       href.startsWith('http') ? href : base + href,
                    posterUrl: posters[i] || '',
                    type:      'anime'
                }));
            }

            var result = {};
            if (animeItems.length > 0) result['Latest Anime'] = animeItems;
            cb({ success: true, data: result });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // Search
    async function search(query, cb) {
        var base = manifest.baseUrl;
        var searchUrl = base + '/anime?search=' + encodeURIComponent(query);

        try {
            var html = getBody(await http_get(searchUrl, HTML_HEADERS));
            if (!html) return cb({ success: false, error: 'Gagal memuat HTML pencarian.' });

            var titles  = await parseHtml(html, '.grid a[href*="/anime/"]', 'text');
            var urls    = await parseHtml(html, '.grid a[href*="/anime/"]', 'href');
            var posters = await parseHtml(html, '.grid img', 'src');

            var results = [];
            var totalItems = Math.min(titles.length, urls.length);

            for (var i = 0; i < totalItems; i++) {
                var href = urls[i];
                if (!href) continue;
                results.push(new MultimediaItem({
                    title:     (titles[i] || 'No Title').trim(),
                    url:       href.startsWith('http') ? href : base + href,
                    posterUrl: posters[i] || '',
                    type:      'anime'
                }));
            }

            cb({ success: true, data: results });
        } catch (e) {
            console.error('Error saat melakukan search:', e);
            cb({ success: false, error: String(e) });
        }
    }

    // Load (detail anime + daftar episode)
    async function load(url, cb) {
        var base = manifest.baseUrl;

        try {
            var html = getBody(await http_get(url, HTML_HEADERS));
            if (!html) return cb({ success: false, error: 'Gagal memuat HTML detail anime.' });

            var titles       = await parseHtml(html, 'h1', 'text');
            var posters      = await parseHtml(html, 'img[src*="/images/anime/"]', 'src');
            var descriptions = await parseHtml(html, '.text-slate-100.text-center div', 'text');

            var animeTitle = titles[0] ? titles[0].trim() : 'No Title';
            var poster     = posters[0] || '';
            var synopsis   = descriptions[0] ? descriptions[0].trim() : '';
            var isOngoing  = /ongoing/i.test(html);

            var epUrls         = await parseHtml(html, 'ul li a[wire\\:navigate][href*="/anime/"]', 'href');
            var epTitles       = await parseHtml(html, 'ul li a[wire\\:navigate][href*="/anime/"] h3', 'text');
            var epDescriptions = await parseHtml(html, 'ul li a[wire\\:navigate][href*="/anime/"] span.text-slate-100.text-sm', 'text');
            var epAirDates     = await parseHtml(html, 'ul li a[wire\\:navigate][href*="/anime/"] .flex-row span:nth-child(2) span.line-clamp-1', 'text');
            var epThumbnails = await parseHtml(html, 'ul li a[wire\\:navigate][href*="/anime/"] img', 'src');

            var episodeItems = [];
            var totalEpisodes = Math.min(epUrls.length, epTitles.length);

            for (var i = 0; i < totalEpisodes; i++) {
                var epHref = epUrls[i];
                if (!epHref) continue;

                var epSlug     = epHref.split('/').pop() || '';
                var rawEpTitle = epTitles[i] || '';
                // Ekstrak angka dari slug: "1"→1, "s1"→1, "ova2"→2, ""→i+1
                var epNum      = parseFloat(epSlug.replace(/[^0-9.]/g, '')) || (i + 1);

                episodeItems.push(new Episode({
                    name:        rawEpTitle.trim() || ('Episode ' + epSlug),
                    url:         epHref.startsWith('http') ? epHref : base + epHref,
                    season:      1,
                    episode:     epNum,
                    dubStatus:   'subbed',
                    description: epDescriptions[i] ? epDescriptions[i].trim() : '',
                    airDate:     epAirDates[i] ? epAirDates[i].trim() : '',
                    posterUrl:   epThumbnails[i] || poster,
                    runtime:     0
                }));
            }

            cb({
                success: true,
                data: new MultimediaItem({
                    title:       animeTitle,
                    url:         url,
                    posterUrl:   poster,
                    type:        'anime',
                    status:      isOngoing ? 'ongoing' : 'completed',
                    description: synopsis,
                    episodes:    episodeItems
                })
            });

        } catch (e) {
            console.error('Error saat melakukan load detail:', e);
            cb({ success: false, error: String(e) });
        }
    }

    // Load Streams
    async function loadStreams(url, cb) {
        try {
            var html = getBody(await http_get(url, HTML_HEADERS));
            if (!html) return cb({ success: false, error: 'Gagal memuat HTML episode.' });

            var streamUrls = await parseHtml(html, 'media-player[src]', 'src');
            var m3u8Url = streamUrls[0];
            if (!m3u8Url) return cb({ success: false, error: 'Stream tidak ditemukan.' });

            var subSrcs   = await parseHtml(html, 'track[kind="subtitles"]', 'src');
            var subLabels = await parseHtml(html, 'track[kind="subtitles"]', 'label');
            var subLangs  = await parseHtml(html, 'track[kind="subtitles"]', 'srclang');

            var subtitles = [];
            for (var i = 0; i < subSrcs.length; i++) {
                if (!subSrcs[i]) continue;
                subtitles.push({
                    url:   subSrcs[i],
                    label: subLabels[i] || ('Sub ' + i),
                    lang:  subLangs[i]  || 'und'
                });
            }

            var stream = new StreamResult({
                url:       m3u8Url,
                quality:   'Multi Quality',
                headers:   { 'Referer': manifest.baseUrl + '/' },
                subtitles: subtitles
            });

            cb({ success: true, data: [stream] });

        } catch (e) {
            console.error('Error loadStreams:', e);
            cb({ success: false, error: String(e) });
        }
    }

    // ─── Expose to Global Scope ───────────────────────────────────────────────
    globalThis.getHome    = getHome;
    globalThis.search     = search;
    globalThis.load       = load;
    globalThis.loadStreams = loadStreams;

})();