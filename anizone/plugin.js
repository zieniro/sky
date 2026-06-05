(function () {

    // ─── Constants ────────────────────────────────────────────────────────────
    var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    var HTML_HEADERS = {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
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

    // Extract fallback title from: window.getTitle(this.xxx, 'FallbackTitle')
    function extractFallbackTitle(str) {
        var m = str.match(/window\.getTitle\s*\([^,]+,\s*'([^']+)'\s*\)/);
        return m ? m[1].trim() : '';
    }

    // Decode unicode escapes like \u0022 in x-data attribute strings
    function decodeUnicode(str) {
        try {
            return str.replace(/\\u([0-9a-fA-F]{4})/g, function (_, hex) {
                return String.fromCharCode(parseInt(hex, 16));
            });
        } catch (_) { return str; }
    }

    // ─── parseLatestEpisodes ──────────────────────────────────────────────────
    // Structure from source:
    //   <ul x-data="{ animeDict: JSON.parse('...') }">
    //     <li x-data="{ anmSlug: 'xxx', get displayAnimeTitle() { return window.getTitle(animeDict[anmSlug], 'FallbackTitle') } }">
    //       <a wire:navigate href="https://anizone.to/anime/SLUG/EP_NUM">
    //       Episode number is static in href path
    function parseLatestEpisodes(html) {
        var items = [];

        // Build slug→title map from animeDict JSON embedded in <ul x-data>
        // Source uses &quot; entities inside HTML attribute, so match on the JS content
        var animeTitleMap = {};
        var dictMatch = html.match(/animeDict:\s*JSON\.parse\('([\s\S]+?)'\)\s*\}/);
        if (dictMatch) {
            try {
                var decoded = decodeUnicode(dictMatch[1].replace(/\\'/g, "'"));
                var dict = JSON.parse(decoded);
                // Priority: lang id 1 (English) > 5 (Romaji) > 8 (Japanese)
                Object.keys(dict).forEach(function (slug) {
                    var titles = dict[slug];
                    animeTitleMap[slug] = titles['1'] || titles['5'] || titles['8'] || '';
                });
            } catch (_) {}
        }

        // Split on each <li x-data> block
        var liParts = html.split(/<li\s+x-data="/i).slice(1);

        for (var i = 0; i < liParts.length; i++) {
            var li = liParts[i];

            var slugMatch = li.match(/anmSlug:\s*'([a-z0-9]+)'/i);
            if (!slugMatch) continue;
            var slug = slugMatch[1];

            var epUrlMatch = li.match(/href="(https?:\/\/anizone\.to\/anime\/[a-z0-9]+\/(\d+))"/i);
            if (!epUrlMatch) continue;
            var epUrl = epUrlMatch[1];
            var epNum = epUrlMatch[2];

            var thumbMatch = li.match(/\bsrc="(https?:\/\/[^"]+\/snapshot\.webp)"/i);
            var thumbnail  = thumbMatch ? thumbMatch[1] : '';

            var dateMatch = li.match(/(\d{4}-\d{2}-\d{2})/);
            var airDate   = dateMatch ? dateMatch[1] : '';

            var animeTitle = animeTitleMap[slug] || extractFallbackTitle(li);
            if (!animeTitle) continue;

            items.push({
                animeTitle: animeTitle,
                animeUrl:   'https://anizone.to/anime/' + slug,
                epUrl:      epUrl,
                epNum:      parseInt(epNum, 10),
                thumbnail:  thumbnail,
                airDate:    airDate
            });
        }
        return items;
    }

    // ─── parseLatestAnime ─────────────────────────────────────────────────────
    // Structure from source (x-data spans multiple lines, class comes after):
    //   <div x-data="{\n  anmTitles: JSON.parse('...'),\n  get displayAnimeTitle() {...}\n}"
    //        class="space-y-3 pb-6 swiper-slide">
    //     <a href="https://anizone.to/anime/SLUG">
    //     <img src="https://anizone.to/images/anime/UUID.jpg">
    function parseLatestAnime(html) {
        var items = [];

        // Isolate swiper section — ends at episode list or Latest Episodes heading
        var swiperStart = html.indexOf('swiper-wrapper');
        if (swiperStart === -1) return items;

        // Try multiple end markers robustly
        var endMarkers = ['Latest Episodes', 'animeDict:', 'list-none grid'];
        var swiperEnd  = -1;
        for (var m = 0; m < endMarkers.length; m++) {
            var idx = html.indexOf(endMarkers[m], swiperStart + 100);
            if (idx > swiperStart) { swiperEnd = idx; break; }
        }
        var section = swiperEnd > swiperStart
            ? html.substring(swiperStart, swiperEnd)
            : html.substring(swiperStart, swiperStart + 80000); // cap at 80KB

        // Split on "anmTitles:" — unique per slide
        var parts = section.split(/\banmTitles:/);

        for (var i = 1; i < parts.length; i++) {
            var block = parts[i];
            var nextSlide = block.indexOf('anmTitles:');
            if (nextSlide > 0) block = block.substring(0, nextSlide);

            var title = extractFallbackTitle(block);
            if (!title) continue;

            var hrefMatch   = block.match(/href="(https?:\/\/anizone\.to\/anime\/[a-z0-9]+)"/i);
            var posterMatch = block.match(/\bsrc="(https?:\/\/anizone\.to\/images\/anime\/[^"]+)"/i);
            if (!hrefMatch) continue;

            items.push({
                title:     title,
                url:       hrefMatch[1],
                posterUrl: posterMatch ? posterMatch[1] : ''
            });
        }
        return items;
    }

    // ─── getHome ──────────────────────────────────────────────────────────────
    async function getHome(cb) {
        try {
            var html = getBody(await http_get(manifest.baseUrl, HTML_HEADERS));
            if (!html) return cb({ success: false, error: 'Failed to load HTML.' });

            var epItems = parseLatestEpisodes(html);
            var latestEpisodes = epItems.map(function (ep) {
                return new MultimediaItem({
                    title:     ep.animeTitle + ' - Episode ' + ep.epNum,
                    url:       ep.epUrl,
                    posterUrl: ep.thumbnail,
                    bannerUrl: ep.thumbnail,
                    type:      'anime'
                });
            });

            var animeItems = parseLatestAnime(html);
            var latestAnime = animeItems.map(function (item) {
                return new MultimediaItem({
                    title:     item.title,
                    url:       item.url,
                    posterUrl: item.posterUrl,
                    type:      'anime'
                });
            });

            var result = {};
            if (latestEpisodes.length > 0) result['Latest Episodes'] = latestEpisodes;
            if (latestAnime.length > 0)    result['Latest Anime']    = latestAnime;

            if (!Object.keys(result).length) return cb({ success: false, error: 'No content found.' });
            cb({ success: true, data: result });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── search ───────────────────────────────────────────────────────────────
    async function search(query, cb) {
        try {
            var html = getBody(await http_get(manifest.baseUrl + '/anime?search=' + encodeURIComponent(query), HTML_HEADERS));
            if (!html) return cb({ success: false, error: 'Failed to load search HTML.' });

            var titles  = await parseHtml(html, '.grid a[href*="/anime/"]', 'text');
            var urls    = await parseHtml(html, '.grid a[href*="/anime/"]', 'href');
            var posters = await parseHtml(html, '.grid img', 'src');

            var results = [];
            for (var i = 0; i < Math.min(titles.length, urls.length); i++) {
                var href = urls[i];
                if (!href) continue;
                // Skip episode URLs
                if (/\/anime\/[a-z0-9]+\/\d+$/i.test(href)) continue;
                results.push(new MultimediaItem({
                    title:     (titles[i] || 'No Title').trim(),
                    url:       href.startsWith('http') ? href : manifest.baseUrl + href,
                    posterUrl: posters[i] || '',
                    type:      'anime'
                }));
            }

            cb({ success: true, data: results });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── load ─────────────────────────────────────────────────────────────────
    async function load(url, cb) {
        try {
            // Normalize episode URL to anime page URL
            url = url.replace(/\/anime\/([a-z0-9]+)\/\d+$/i, '/anime/$1');

            var html = getBody(await http_get(url, HTML_HEADERS));
            if (!html) return cb({ success: false, error: 'Failed to load anime detail HTML.' });

            var titles       = await parseHtml(html, 'h1', 'text');
            var posters      = await parseHtml(html, 'img[src*="/images/anime/"]', 'src');
            var descriptions = await parseHtml(html, '.text-slate-100.text-center div', 'text');

            var animeTitle = (titles[0] || 'No Title').trim();
            var poster     = posters[0] || '';
            var synopsis   = (descriptions[0] || '').trim() || 'No description available.';
            var isOngoing  = /ongoing/i.test(html);

            // Parse episodes — same structure as home page episode list
            var episodeItems = [];
            var liParts = html.split(/<li\s+x-data="/i).slice(1);

            for (var i = 0; i < liParts.length; i++) {
                var block = liParts[i];
                var epUrlMatch = block.match(/href="(https?:\/\/anizone\.to\/anime\/[a-z0-9]+\/(\d+))"/i);
                if (!epUrlMatch) continue;
                var epUrl = epUrlMatch[1];
                var epNum = parseInt(epUrlMatch[2], 10);

                var thumbMatch = block.match(/\bsrc="(https?:\/\/[^"]+\/snapshot\.webp)"/i)
                              || block.match(/\bsrc="(https?:\/\/[^"]+\.webp)"/i);
                var epThumb = thumbMatch ? thumbMatch[1] : poster;

                var h3Match = block.match(/<h3[^>]*>\s*([^<]+?)\s*<\/h3>/i);
                var epName  = h3Match ? h3Match[1].trim() : '';
                if (!epName || epName === 'Untitled') epName = 'Episode ' + epNum;

                var dateMatch = block.match(/(\d{4}-\d{2}-\d{2})/);
                var airDate   = dateMatch ? dateMatch[1] : '';

                episodeItems.push(new Episode({
                    name:      epName,
                    url:       epUrl,
                    season:    1,
                    episode:   epNum,
                    dubStatus: 'subbed',
                    posterUrl: epThumb,
                    airDate:   airDate
                }));
            }

            // Fallback: extract from href only
            if (episodeItems.length === 0) {
                var seen = {};
                var epRegex = /href="(https?:\/\/anizone\.to\/anime\/[a-z0-9]+\/(\d+))"/gi;
                var m;
                while ((m = epRegex.exec(html)) !== null) {
                    if (seen[m[1]]) continue;
                    seen[m[1]] = true;
                    var num = parseInt(m[2], 10);
                    episodeItems.push(new Episode({
                        name:      'Episode ' + num,
                        url:       m[1],
                        season:    1,
                        episode:   num,
                        dubStatus: 'subbed',
                        posterUrl: poster
                    }));
                }
            }

            episodeItems.sort(function (a, b) { return a.episode - b.episode; });

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
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── loadStreams ───────────────────────────────────────────────────────────
    async function loadStreams(url, cb) {
        try {
            var html = getBody(await http_get(url, HTML_HEADERS));
            if (!html) return cb({ success: false, error: 'Failed to load episode HTML.' });

            var streamUrls = await parseHtml(html, 'media-player[src]', 'src');
            var m3u8Url = streamUrls[0];
            if (!m3u8Url) return cb({ success: false, error: 'Stream not found.' });

            var subSrcs   = await parseHtml(html, 'track[kind="subtitles"]', 'src');
            var subLabels = await parseHtml(html, 'track[kind="subtitles"]', 'label');
            var subLangs  = await parseHtml(html, 'track[kind="subtitles"]', 'srclang');

            var subtitles = [];
            for (var i = 0; i < subSrcs.length; i++) {
                if (!subSrcs[i]) continue;
                subtitles.push({ url: subSrcs[i], label: subLabels[i] || ('Sub ' + i), lang: subLangs[i] || 'und' });
            }

            cb({
                success: true,
                data: [new StreamResult({
                    url:       m3u8Url,
                    quality:   'Multi Quality',
                    headers:   { 'Referer': manifest.baseUrl + '/' },
                    subtitles: subtitles
                })]
            });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── Expose ───────────────────────────────────────────────────────────────
    globalThis.getHome     = getHome;
    globalThis.search      = search;
    globalThis.load        = load;
    globalThis.loadStreams  = loadStreams;

})();