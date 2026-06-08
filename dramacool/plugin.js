(function () {

    var BASE = manifest.baseUrl;
    var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    var HEADERS = {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8'
    };

    var HOME_CATEGORIES = [
        { name: 'Recent Drama',   url: BASE + '/category/latest-asian-drama-releases-hd/' },
        { name: 'Recent K-Show',  url: BASE + '/category/latest-kshow-releases/' },
        { name: 'Korean Drama',   url: BASE + '/country/south-korea' },
        { name: 'Chinese Drama',  url: BASE + '/country/china-etc' },
        { name: 'Japanese Drama', url: BASE + '/country/japan-et' },
        { name: 'Thai Drama',     url: BASE + '/country/thailand' }
    ];

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
            return raw.map(function (item) {
                if (!item) return '';
                if (typeof item === 'string') return item;
                if (attr === 'text') return item.text || '';
                if (attr === 'html') return item.html || '';
                return item.attr || item[attr] || '';
            });
        } catch (_) { return []; }
    }

    function decodeHtmlEntities(str) {
        return (str || '')
            .replace(/&#8217;/g, "'").replace(/&#8216;/g, "'")
            .replace(/&#8220;/g, '"').replace(/&#8221;/g, '"')
            .replace(/&#8211;/g, '–').replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    }

    function cleanTitle(raw) {
        return (raw || '').replace(/\s+Episode\s+[\d.]+\s*$/i, '').trim();
    }

    function dramaSlug(url) {
        return url.replace(/-episode-[\d-]+\.html$/i, '').replace(/\.html$/i, '');
    }

    function extractEpNum(title) {
        var m = (title || '').match(/Episode\s+(\d+(?:\.\d+)?)/i);
        return m ? parseFloat(m[1]) : null;
    }

    // ─── Resolvers ────────────────────────────────────────────────────────────

    async function resolveMegaplay(embedUrl) {
        try {
            var body = getBody(await http_get(embedUrl, {
                'User-Agent': UA, 'Referer': BASE + '/', 'Accept': 'text/html,*/*'
            }));
            if (!body) return null;
            var src = body;
            if (body.includes('eval(function(p,a,c,k,e')) {
                try { src = getAndUnpack(body); } catch (_) {}
            }
            var m = src.match(/["'](https?:\/\/[^"']+\.m3u8[^"']{0,300}?)["']/i)
                 || src.match(/file\s*:\s*["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/i)
                 || src.match(/source\s*:\s*["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/i)
                 || src.match(/["'](https?:\/\/[^"']{20,}\.mp4[^"']{0,200}?)["']/i);
            if (!m) return null;
            return new StreamResult({
                url: m[1], quality: 'Auto', source: 'MegaPlay',
                headers: { 'Referer': 'https://megaplay.su/' }
            });
        } catch (_) { return null; }
    }

    async function resolveVidmoly(embedUrl) {
        try {
            var body = getBody(await http_get(embedUrl, {
                'User-Agent': UA, 'Referer': BASE + '/', 'Accept': 'text/html,*/*'
            }));
            if (!body) return null;

            var m = body.match(/["']file["']\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']{0,500}?)["']/i)
                 || body.match(/[?&]url=(https?:\/\/[^&"'\s]+\.m3u8[^&"'\s]*)/i)
                 || body.match(/["'](https?:\/\/[^"']+\.m3u8[^"']{0,500}?)["']/i);

            if (!m) return null;
            var m3u8 = decodeURIComponent(m[1]);

            return new StreamResult({
                url: m3u8, quality: 'Auto', source: 'Vidmoly',
                headers: { 'Referer': 'https://vidmoly.biz/' }
            });
        } catch (_) { return null; }
    }

    async function resolveEmbed(embedUrl, label) {
        if (!embedUrl) return null;
        var h = embedUrl.toLowerCase();
        if (h.includes('megaplay.su'))              return resolveMegaplay(embedUrl);
        if (h.includes('vidmoly.'))                 return resolveVidmoly(embedUrl);
        // Generic fallback
        try {
            var body = getBody(await http_get(embedUrl, { 'User-Agent': UA, 'Referer': BASE + '/' }));
            var src = body;
            if (body.includes('eval(function(p,a,c,k,e')) {
                try { src = getAndUnpack(body); } catch (_) {}
            }
            var m = src.match(/["'](https?:\/\/[^"']+\.m3u8[^"']{0,300}?)["']/i)
                 || src.match(/file\s*:\s*["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/i);
            if (!m) return null;
            var origin = '';
            try { origin = new URL(embedUrl).origin + '/'; } catch (_) {}
            return new StreamResult({
                url: m[1], quality: 'Auto', source: label || 'Server',
                headers: { 'Referer': origin || BASE + '/' }
            });
        } catch (_) { return null; }
    }

    // ─── parseCards ───────────────────────────────────────────────────────────

    async function parseCards(html, dedup) {
        var hrefs   = await parseHtml(html, 'ul.box li a.mask', 'href');
        var titles  = await parseHtml(html, 'ul.box li a.mask h3', 'text');
        var posters = await parseHtml(html, 'ul.box li a.mask img', 'data-original');
        if (!posters.filter(Boolean).length)
            posters = await parseHtml(html, 'ul.box li a.mask img', 'src');

        var seen = {};
        var items = [];

        for (var i = 0; i < hrefs.length; i++) {
            var rawTitle = decodeHtmlEntities(titles[i] || '');
            var href     = hrefs[i];
            if (!href || !rawTitle) continue;

            var fullUrl = href.startsWith('http') ? href : BASE + href;
            var title   = cleanTitle(rawTitle);

            if (dedup) {
                var slug = dramaSlug(fullUrl);
                if (seen[slug]) continue;
                seen[slug] = true;
                // Redirect episode URL to drama page
                fullUrl = slug.startsWith('http') ? slug : BASE + slug;
            }

            items.push(new MultimediaItem({
                title:     title,
                url:       fullUrl,
                posterUrl: posters[i] || '',
                type:      'series'
            }));
        }
        return items;
    }

    // ─── getHome ──────────────────────────────────────────────────────────────

    async function getHome(cb) {
        try {
            var result = {};
            for (var i = 0; i < HOME_CATEGORIES.length; i++) {
                var cat = HOME_CATEGORIES[i];
                var isEpFeed = cat.name.startsWith('Recent');
                try {
                    var html  = getBody(await http_get(cat.url, HEADERS));
                    var items = await parseCards(html, isEpFeed);
                    if (items.length) result[cat.name] = items;
                } catch (_) {}
            }
            if (!Object.keys(result).length)
                return cb({ success: false, error: 'Failed to load homepage.' });
            cb({ success: true, data: result });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── search ───────────────────────────────────────────────────────────────

    async function search(query, cb) {
        try {
            var html  = getBody(await http_get(BASE + '/?s=' + encodeURIComponent(query), HEADERS));
            var items = await parseCards(html, false);
            cb({ success: true, data: items });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── load ─────────────────────────────────────────────────────────────────

    async function load(url, cb) {
        try {
            var html = getBody(await http_get(url, HEADERS));

            var title    = decodeHtmlEntities((await parseHtml(html, '#drama-details .drama-details h1', 'text'))[0] || '');
            var poster   = (await parseHtml(html, '#drama-details .drama-thumbnail img', 'data-original'))[0]
                        || (await parseHtml(html, '#drama-details .drama-thumbnail img', 'src'))[0] || '';
            var synParts = await parseHtml(html, '#drama-details .synopsis p', 'text');
            var synopsis = synParts.filter(Boolean).join('\n\n').trim();
            var status   = /ongoing/i.test(html) ? 'ongoing' : 'completed';

            var epHrefs  = await parseHtml(html, '#episode-list ul.list li h3 a', 'href');
            var epTitles = await parseHtml(html, '#episode-list ul.list li h3 a', 'text');

            epHrefs  = epHrefs.slice().reverse();
            epTitles = epTitles.slice().reverse();

            var episodes = epHrefs.map(function (href, i) {
                var rawTitle = decodeHtmlEntities(epTitles[i] || '');
                var epNum    = extractEpNum(rawTitle) || (i + 1);
                return new Episode({
                    name:      'Episode ' + epNum,
                    url:       href.startsWith('http') ? href : BASE + href,
                    season:    1,
                    episode:   epNum,
                    dubStatus: 'subbed',
                    posterUrl: poster
                });
            });

            cb({
                success: true,
                data: new MultimediaItem({
                    title, url, posterUrl: poster, type: 'series',
                    status, description: synopsis, episodes
                })
            });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── loadStreams ───────────────────────────────────────────────────────────

    async function loadStreams(url, cb) {
        try {
            var html = getBody(await http_get(url, HEADERS));

            var primarySrc   = (await parseHtml(html, '#video-frame', 'src'))[0] || '';
            var serverSrcs   = await parseHtml(html, '.server-btn[data-src]', 'data-src');
            var serverLabels = await parseHtml(html, '.server-btn[data-src]', 'text');

            var embeds = [];
            if (primarySrc) embeds.push({ src: primarySrc, label: 'Fast Server' });
            serverSrcs.forEach(function (src, i) {
                if (src && src !== primarySrc)
                    embeds.push({ src: src, label: (serverLabels[i] || 'Server ' + (i + 1)).trim() });
            });

            if (!embeds.length)
                return cb({ success: false, error: 'No embed sources found.' });

            var streams = [];
            await Promise.all(embeds.map(async function (embed) {
                try {
                    var result = await resolveEmbed(embed.src, embed.label);
                    if (result) streams.push(result);
                } catch (_) {}
            }));

            if (!streams.length)
                return cb({ success: false, error: 'No playable streams resolved.' });

            cb({ success: true, data: streams });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── Expose ───────────────────────────────────────────────────────────────

    globalThis.getHome    = getHome;
    globalThis.search     = search;
    globalThis.load       = load;
    globalThis.loadStreams = loadStreams;

})();