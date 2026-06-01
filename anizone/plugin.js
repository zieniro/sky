(function () {

    // ─── Constants ────────────────────────────────────────────────────────────
    const HEADERS = {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
    };

    // ─── Helpers ──────────────────────────────────────────────────────────────
    function getBody(res) {
        if (!res)                         return '';
        if (typeof res === 'string')      return res;
        if (typeof res.body === 'string') return res.body;
        if (res.body)                     return JSON.stringify(res.body);
        return String(res);
    }

    async function $$(html, selector, attr) {
        try {
            const raw = await parse_html(html, selector, attr);
            if (!Array.isArray(raw)) return [];
            return raw.map(item => {
                if (!item)                    return '';
                if (typeof item === 'string') return item;
                if (attr === 'text')          return item.text  || '';
                return item.attr || item[attr] || '';
            });
        } catch (_) { return []; }
    }

    function url(href) {
        if (!href) return '';
        return href.startsWith('http') ? href : manifest.baseUrl + href;
    }

    async function fetchHtml(pageUrl) {
        const body = getBody(await http_get(pageUrl, HEADERS));
        if (!body) throw new Error('Empty response from ' + pageUrl);
        return body;
    }

    // ─── getHome ──────────────────────────────────────────────────────────────
    async function getHome(cb) {
        try {
            const base = manifest.baseUrl;
            const html = await fetchHtml(base);

            const [
                animeHrefs, animeTitles, animePosters,
                epHrefs, epTitles, epThumbs, epDates
            ] = await Promise.all([
                $$(html, '.swiper-slide .line-clamp-2 a',            'href'),
                $$(html, '.swiper-slide .line-clamp-2 a',            'text'),
                $$(html, '.swiper-slide img',                         'src'),
                $$(html, 'ul li a[wire\\:navigate][href*="/anime/"]', 'href'),
                $$(html, 'ul li a[wire\\:navigate][href*="/anime/"]', 'text'),
                $$(html, 'ul li a.group img',                         'src'),
                $$(html, 'ul li .flex-row span span',                 'text'),
            ]);

            const animeItems = [];
            const animeCount = Math.min(animeHrefs.length, animeTitles.length, animePosters.length);
            for (let i = 0; i < animeCount; i++) {
                if (!animeHrefs[i]) continue;
                animeItems.push(new MultimediaItem({
                    title:     (animeTitles[i] || 'No Title').trim(),
                    url:       url(animeHrefs[i]),
                    posterUrl: animePosters[i] || '',
                    type:      'anime'
                }));
            }

            // Latest Episodes
            const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
            const epItems = [];
            for (let j = 0; j + 1 < epHrefs.length; j += 2) {
                const epHref = epHrefs[j + 1];
                if (!epHref || !/\/anime\/[^/]+\/\w+/.test(epHref)) continue;

                const idx     = j / 2;
                const epTitle = (epTitles[j + 1] || '').trim();
                const airDate = (epDates[idx] || '').trim();

                epItems.push(new MultimediaItem({
                    title:       (epTitles[j] || 'No Title').trim() + (epTitle ? ' — ' + epTitle : ''),
                    url:         url(epHrefs[j]),
                    posterUrl:   epThumbs[idx] || '',
                    type:        'anime',
                    description: DATE_RE.test(airDate) ? 'Aired: ' + airDate : 'No description available.'
                }));
            }

            const result = {};
            if (animeItems.length) result['Trending']        = animeItems;
            if (animeItems.length) result['Latest Anime']    = animeItems;
            if (epItems.length)    result['Latest Episodes'] = epItems;

            if (!Object.keys(result).length)
                return cb({ success: false, error: 'No data found on homepage.' });

            cb({ success: true, data: result });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── search ───────────────────────────────────────────────────────────────
    async function search(query, cb) {
        try {
            const base = manifest.baseUrl;
            const html = await fetchHtml(base + '/anime?search=' + encodeURIComponent(query));

            const [titles, hrefs, posters] = await Promise.all([
                $$(html, '.grid a[href*="/anime/"]', 'text'),
                $$(html, '.grid a[href*="/anime/"]', 'href'),
                $$(html, '.grid img',                'src'),
            ]);

            const results = [];
            for (let i = 0; i < Math.min(titles.length, hrefs.length); i++) {
                if (!hrefs[i]) continue;
                results.push(new MultimediaItem({
                    title:     (titles[i] || 'No Title').trim(),
                    url:       url(hrefs[i]),
                    posterUrl: posters[i] || '',
                    type:      'anime'
                }));
            }

            cb({ success: true, data: results });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── load ─────────────────────────────────────────────────────────────────
    async function load(pageUrl, cb) {
        try {
            const html   = await fetchHtml(pageUrl);
            const EP_SEL = 'ul li a[wire\\:navigate][href*="/anime/"]';
            const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

            const [
                titles, posters, descriptions, years,
                epHrefs, epTitles, epAllMeta, epThumbs
            ] = await Promise.all([
                $$(html, 'h1',                                         'text'),
                $$(html, 'img[src*="/images/anime/"]',                 'src'),
                $$(html, '.text-slate-100.text-center div',            'text'),
                $$(html, '.flex.flex-wrap span span',                  'text'),
                $$(html, EP_SEL,                                       'href'),
                $$(html, EP_SEL + ' h3',                               'text'),
                $$(html, EP_SEL + ' .flex-row span span.line-clamp-1', 'text'),
                $$(html, EP_SEL + ' div img',                          'src'),
            ]);

            const poster    = posters[0] || '';
            const synopsis  = (descriptions[0] || '').trim();
            const isOngoing = /ongoing/i.test(html);

            const yearStr = years.find(s => /^\d{4}$/.test((s || '').trim())) || '';
            const year    = yearStr ? parseInt(yearStr, 10) : undefined;

            const epDates = epHrefs.map((_, i) => {
                const chunk = epAllMeta.slice(i * 3, i * 3 + 3);
                return chunk.find(s => DATE_RE.test((s || '').trim())) || '';
            });

            const validEps = epHrefs
                .map((href, i) => ({
                    href,
                    title: epTitles[i] || '',
                    date:  epDates[i]  || '',
                    thumb: epThumbs[i] || ''
                }))
                .filter(ep => /\/anime\/[^/]+\/\w+$/.test(ep.href));

            const episodes = validEps.map((ep, i) => {
                const slug  = ep.href.split('/').pop() || '';
                const epNum = parseFloat(slug.replace(/[^0-9.]/g, '')) || (i + 1);

                return new Episode({
                    name:      ep.title.trim() || ('Episode ' + slug),
                    url:       url(ep.href),
                    season:    1,
                    episode:   epNum,
                    dubStatus: 'subbed',
                    airDate:   ep.date.trim(),
                    posterUrl: ep.thumb || poster,
                });
            });

            cb({
                success: true,
                data: new MultimediaItem({
                    title:       (titles[0] || 'No Title').trim(),
                    url:         pageUrl,
                    posterUrl:   poster,
                    type:        'anime',
                    year,
                    status:      isOngoing ? 'ongoing' : 'completed',
                    description: synopsis || 'No description available.',
                    episodes,
                })
            });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── loadStreams ───────────────────────────────────────────────────────────
    async function loadStreams(pageUrl, cb) {
        try {
            const html = await fetchHtml(pageUrl);

            const [streamUrls, subSrcs, subLabels, subLangs] = await Promise.all([
                $$(html, 'media-player[src]',       'src'),
                $$(html, 'track[kind="subtitles"]', 'src'),
                $$(html, 'track[kind="subtitles"]', 'label'),
                $$(html, 'track[kind="subtitles"]', 'srclang'),
            ]);

            const m3u8 = streamUrls[0];
            if (!m3u8) return cb({ success: false, error: 'Stream not found.' });

            const subtitles = subSrcs
                .map((src, i) => src ? {
                    url:   src,
                    label: subLabels[i] || 'Sub ' + i,
                    lang:  subLangs[i]  || 'und'
                } : null)
                .filter(Boolean);

            cb({
                success: true,
                data: [new StreamResult({
                    url:       m3u8,
                    quality:   'Multi Quality',
                    headers:   { 'Referer': manifest.baseUrl + '/' },
                    subtitles,
                })]
            });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── Expose ───────────────────────────────────────────────────────────────
    globalThis.getHome    = getHome;
    globalThis.search     = search;
    globalThis.load       = load;
    globalThis.loadStreams = loadStreams;

})();