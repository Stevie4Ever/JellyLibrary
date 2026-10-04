/* JellyLibrary – UI-Logik.
 *
 * Der Such-Screen arbeitet komplett offline aus der IndexedDB.
 * Netzwerk braucht es nur beim Verbindungstest und beim Aktualisieren.
 */
(function () {
    "use strict";

    /* ------------------------------------------------------------------ *
     *  Einstellungen (localStorage)
     * ------------------------------------------------------------------ */
    const LS = {
        server: "jelly_server",
        user: "jelly_user",
        token: "jelly_token",
        userId: "jelly_userid",
        session: "jelly_session",   // "server|user", zu dem das Token gehoert
        images: "jelly_images"
    };
    // Altlast: fruehere Versionen speicherten das Passwort im Klartext.
    localStorage.removeItem("jelly_pass");

    function getSetting(key, fallback) {
        const v = localStorage.getItem(key);
        return v === null ? fallback : v;
    }

    /* ------------------------------------------------------------------ *
     *  Zustand
     * ------------------------------------------------------------------ */
    let allItems = [];        // Metadaten aller Medien (im Speicher)
    let currentFilter = "all";
    let currentQuery = "";
    let searchTimer = null;

    // Max. gleichzeitig gerenderte Karten (grosse Bibliotheken: per Suche eingrenzen).
    const RENDER_LIMIT = 300;

    const objectUrls = new Set();   // fuer sauberes Aufraeumen
    let imgObserver = null;

    const t = I18N.t;

    function typeLabel(type) {
        const k = "type." + type;
        const v = t(k);
        return v === k ? type : v;
    }

    // ISO-639-2-Codes (3-stellig, auch bibliografische) auf 2-stellige Codes;
    // die Sprachnamen selbst liefert Intl.DisplayNames in der UI-Sprache.
    const LANG3 = {
        ger: "de", deu: "de", eng: "en", fre: "fr", fra: "fr", spa: "es",
        ita: "it", dut: "nl", nld: "nl", por: "pt", pol: "pl", rus: "ru",
        jpn: "ja", kor: "ko", chi: "zh", zho: "zh", tur: "tr", swe: "sv",
        dan: "da", nor: "no", fin: "fi", cze: "cs", ces: "cs", hun: "hu",
        gre: "el", ell: "el", ara: "ar", heb: "he", hin: "hi", ukr: "uk"
    };

    function langName(code) {
        const c = (code || "").toLowerCase();
        if (!c || c === "und") return t("lang.unknown");
        const c2 = LANG3[c] || c;
        try {
            const n = new Intl.DisplayNames([I18N.lang], { type: "language" }).of(c2);
            if (n && n.toLowerCase() !== c2) return n;
        } catch (e) { /* ungueltiger Code */ }
        return c.toUpperCase();
    }

    function langList(codes) {
        return uniq((codes || []).map(langName)).join(", ");
    }

    /* ------------------------------------------------------------------ *
     *  DOM-Referenzen
     * ------------------------------------------------------------------ */
    const el = {
        results: document.getElementById("results"),
        emptyState: document.getElementById("empty-state"),
        emptyText: document.getElementById("empty-text"),
        resultCount: document.getElementById("result-count"),
        syncHint: document.getElementById("sync-hint"),
        searchInput: document.getElementById("search-input"),
        // settings
        cfgServer: document.getElementById("cfg-server"),
        cfgUser: document.getElementById("cfg-user"),
        cfgPass: document.getElementById("cfg-pass"),
        cfgImages: document.getElementById("cfg-images"),
        cfgLang: document.getElementById("cfg-lang"),
        testResult: document.getElementById("test-result"),
        btnTest: document.getElementById("btn-test"),
        btnSync: document.getElementById("btn-sync"),
        syncProgress: document.getElementById("sync-progress"),
        progressFill: document.getElementById("progress-fill"),
        progressText: document.getElementById("progress-text"),
        libStats: document.getElementById("lib-stats"),
        btnClear: document.getElementById("btn-clear"),
        // detail
        overlay: document.getElementById("detail-overlay"),
        detailImg: document.getElementById("detail-img"),
        detailType: document.getElementById("detail-type"),
        detailTitle: document.getElementById("detail-title"),
        detailSub: document.getElementById("detail-sub"),
        detailMedia: document.getElementById("detail-media"),
        detailOverview: document.getElementById("detail-overview"),
        detailEpisodes: document.getElementById("detail-episodes")
    };

    /* ------------------------------------------------------------------ *
     *  Screen-Navigation
     * ------------------------------------------------------------------ */
    function showScreen(id) {
        document.querySelectorAll(".screen").forEach(function (s) {
            s.classList.toggle("active", s.id === id);
        });
        if (id === "screen-settings") renderLibStats();
        window.scrollTo(0, 0);
    }

    document.querySelectorAll("[data-target]").forEach(function (btn) {
        btn.addEventListener("click", function () {
            showScreen(btn.getAttribute("data-target"));
        });
    });
    document.getElementById("btn-open-settings").addEventListener("click", function () {
        showScreen("screen-settings");
    });

    /* ------------------------------------------------------------------ *
     *  Suche + Filter
     * ------------------------------------------------------------------ */
    el.searchInput.addEventListener("input", function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
            currentQuery = el.searchInput.value.trim().toLowerCase();
            renderResults();
        }, 120);
    });

    document.querySelectorAll(".chip").forEach(function (chip) {
        chip.addEventListener("click", function () {
            document.querySelectorAll(".chip").forEach(function (c) {
                c.classList.remove("active");
            });
            chip.classList.add("active");
            currentFilter = chip.getAttribute("data-filter");
            renderResults();
        });
    });

    function matches(item) {
        if (currentFilter !== "all" && item.type !== currentFilter) return false;
        if (!currentQuery) return true;
        if (item.sortName.indexOf(currentQuery) !== -1) return true;
        if (item.artist && item.artist.toLowerCase().indexOf(currentQuery) !== -1) return true;
        return false;
    }

    function subtitleFor(item) {
        const parts = [];
        if (item.type === "MusicAlbum" && item.artist) parts.push(item.artist);
        if (item.year) parts.push(item.year);
        if (item.genres && item.genres.length) parts.push(item.genres.slice(0, 2).join(", "));
        return parts.join(" · ");
    }

    /* ------------------------------------------------------------------ *
     *  Rendering der Ergebnisliste (mit Lazy-Loading der Bilder)
     * ------------------------------------------------------------------ */
    function cleanupImages() {
        if (imgObserver) imgObserver.disconnect();
        objectUrls.forEach(function (u) { URL.revokeObjectURL(u); });
        objectUrls.clear();
        imgObserver = new IntersectionObserver(onThumbVisible, { rootMargin: "200px" });
    }

    function onThumbVisible(entries) {
        entries.forEach(function (entry) {
            if (!entry.isIntersecting) return;
            const thumb = entry.target;
            imgObserver.unobserve(thumb);
            const id = thumb.getAttribute("data-id");
            DB.getImage(id).then(function (blob) {
                if (!blob) return;
                const url = URL.createObjectURL(blob);
                objectUrls.add(url);
                const img = document.createElement("img");
                img.src = url;
                img.alt = "";
                thumb.textContent = "";
                thumb.appendChild(img);
            });
        });
    }

    function iconFor(type) {
        if (type === "Movie") return "🎬";
        if (type === "Series") return "📺";
        if (type === "MusicAlbum") return "🎵";
        return "🎞";
    }

    function renderResults() {
        cleanupImages();
        el.results.innerHTML = "";

        if (allItems.length === 0) {
            el.emptyState.classList.remove("hidden");
            el.emptyText.textContent = t("empty.noLibrary");
            el.resultCount.textContent = t("results.count", { n: 0 });
            return;
        }

        const matched = allItems.filter(matches);
        el.resultCount.textContent = t("results.count", { n: matched.length });

        if (matched.length === 0) {
            el.emptyState.classList.remove("hidden");
            el.emptyText.textContent = t("empty.nothingFound");
            return;
        }
        el.emptyState.classList.add("hidden");

        // Bei sehr grossen Bibliotheken nicht alle Treffer auf einmal ins DOM
        // haengen (Performance). Erste RENDER_LIMIT anzeigen, Rest per Suche eingrenzen.
        const shown = matched.slice(0, RENDER_LIMIT);
        if (matched.length > RENDER_LIMIT) {
            el.resultCount.textContent = t("results.limited", {
                count: t("results.count", { n: matched.length }), limit: RENDER_LIMIT
            });
        }

        const frag = document.createDocumentFragment();
        shown.forEach(function (item) {
            const card = document.createElement("div");
            card.className = "card";

            const thumb = document.createElement("div");
            thumb.className = "thumb";
            thumb.textContent = iconFor(item.type);
            if (item.hasImage) {
                thumb.setAttribute("data-id", item.id);
            }

            const info = document.createElement("div");
            info.className = "card-info";
            const title = document.createElement("div");
            title.className = "card-title";
            title.textContent = item.name;
            const sub = document.createElement("div");
            sub.className = "card-sub";
            sub.textContent = subtitleFor(item);
            const badge = document.createElement("span");
            badge.className = "badge " + item.type;
            badge.textContent = typeLabel(item.type);
            info.appendChild(title);
            info.appendChild(sub);
            info.appendChild(badge);

            card.appendChild(thumb);
            card.appendChild(info);
            card.addEventListener("click", function () { openDetail(item); });
            frag.appendChild(card);

            if (item.hasImage) imgObserver.observe(thumb);
        });
        el.results.appendChild(frag);
    }

    /* ------------------------------------------------------------------ *
     *  Detail-Overlay
     * ------------------------------------------------------------------ */
    let detailUrl = null;

    function openDetail(item) {
        el.detailType.textContent = typeLabel(item.type);
        el.detailType.className = "badge " + item.type;
        el.detailTitle.textContent = item.name;
        el.detailSub.textContent = subtitleFor(item) +
            (item.rating ? "  ★ " + item.rating.toFixed(1) : "");
        renderMediaLine(item);
        el.detailOverview.textContent = item.overview || t("detail.noOverview");
        renderEpisodes(item);

        if (detailUrl) { URL.revokeObjectURL(detailUrl); detailUrl = null; }
        el.detailImg.removeAttribute("src");
        el.detailImg.parentElement.classList.add("hidden");
        if (item.hasImage) {
            DB.getImage(item.id).then(function (blob) {
                if (!blob) return;
                detailUrl = URL.createObjectURL(blob);
                el.detailImg.src = detailUrl;
                el.detailImg.parentElement.classList.remove("hidden");
            });
        }
        el.overlay.classList.remove("hidden");
    }

    /* Infozeile: Qualitaet, Audio-Sprachen, Untertitel. */
    function renderMediaLine(item) {
        el.detailMedia.innerHTML = "";
        const chips = [];
        if (item.resolution) {
            chips.push({ cls: "mchip res", text: item.resolution });
        }
        if (item.audio && item.audio.length) {
            chips.push({ cls: "mchip", text: "🔊 " + langList(item.audio) });
        }
        if (item.subs && item.subs.length) {
            chips.push({ cls: "mchip", text: "💬 " + t("detail.subsShort") + ": " + langList(item.subs) });
        }
        if (item.type === "Series" && item.seasonCount) {
            chips.push({
                cls: "mchip",
                text: t("detail.seasons", { n: item.seasonCount }) + " · " +
                    t("detail.episodes", { n: item.episodeCount })
            });
        }
        chips.forEach(function (c) {
            const span = document.createElement("span");
            span.className = c.cls;
            span.textContent = c.text;
            el.detailMedia.appendChild(span);
        });
        el.detailMedia.classList.toggle("hidden", chips.length === 0);
    }

    /* Staffel-/Folgenliste (nur Serien), gruppiert nach Staffel. */
    function renderEpisodes(item) {
        el.detailEpisodes.innerHTML = "";
        if (item.type !== "Series") {
            el.detailEpisodes.classList.add("hidden");
            return;
        }
        el.detailEpisodes.classList.remove("hidden");
        el.detailEpisodes.textContent = t("detail.loadingEpisodes");
        DB.getEpisodes(item.id).then(function (list) {
            el.detailEpisodes.innerHTML = "";
            if (!list.length) {
                el.detailEpisodes.textContent = t("detail.noEpisodes");
                return;
            }
            let currentSeason = null;
            list.forEach(function (ep) {
                if (ep.season !== currentSeason) {
                    currentSeason = ep.season;
                    const h = document.createElement("div");
                    h.className = "season-head";
                    h.textContent = ep.season == null ? t("detail.noSeason") : t("detail.season", { n: ep.season });
                    el.detailEpisodes.appendChild(h);
                }
                const row = document.createElement("div");
                row.className = "ep-row";
                const num = document.createElement("span");
                num.className = "ep-num";
                num.textContent = ep.episode == null ? "–" : ep.episode + ".";
                const name = document.createElement("span");
                name.className = "ep-name";
                name.textContent = ep.name || t("detail.untitled");
                row.appendChild(num);
                row.appendChild(name);
                if (ep.resolution) {
                    const q = document.createElement("span");
                    q.className = "ep-res";
                    q.textContent = ep.resolution;
                    row.appendChild(q);
                }
                el.detailEpisodes.appendChild(row);
            });
        });
    }

    function closeDetail() {
        el.overlay.classList.add("hidden");
        if (detailUrl) { URL.revokeObjectURL(detailUrl); detailUrl = null; }
    }
    document.getElementById("detail-close").addEventListener("click", closeDetail);
    el.overlay.addEventListener("click", function (e) {
        if (e.target === el.overlay) closeDetail();
    });

    /* ------------------------------------------------------------------ *
     *  Einstellungen laden / speichern
     * ------------------------------------------------------------------ */
    /* Sprachauswahl: "Systemstandard" + alle registrierten Sprachen. */
    function buildLangSelect() {
        el.cfgLang.innerHTML = "";
        const auto = document.createElement("option");
        auto.value = "auto";
        auto.textContent = t("settings.languageAuto");
        el.cfgLang.appendChild(auto);
        I18N.available().forEach(function (l) {
            const o = document.createElement("option");
            o.value = l.code;
            o.textContent = l.name;
            el.cfgLang.appendChild(o);
        });
        el.cfgLang.value = I18N.choice();
    }

    el.cfgLang.addEventListener("change", function () {
        I18N.setLanguage(el.cfgLang.value);
        buildLangSelect();
        renderResults();
        renderLibStats();
        updateSyncHint();
        if (!el.overlay.classList.contains("hidden")) closeDetail();
    });

    function loadSettingsIntoForm() {
        el.cfgServer.value = getSetting(LS.server, "");
        el.cfgUser.value = getSetting(LS.user, "");
        el.cfgPass.value = "";
        el.cfgImages.checked = getSetting(LS.images, "1") === "1";
    }

    function saveSettingsFromForm() {
        localStorage.setItem(LS.server, el.cfgServer.value.trim());
        localStorage.setItem(LS.user, el.cfgUser.value.trim());
        localStorage.setItem(LS.images, el.cfgImages.checked ? "1" : "0");
    }

    el.cfgImages.addEventListener("change", saveSettingsFromForm);

    /* Liefert { token, userId, userName }. Mit eingetipptem Passwort wird neu
     * angemeldet und nur das Token gespeichert (das Passwort nie); sonst wird
     * das gespeicherte Token zum aktuellen Server/Benutzer verwendet. */
    function getSession(server, user, pass) {
        const key = Jellyfin.normalizeUrl(server) + "|" + user;
        const token = getSetting(LS.token, "");
        if (!pass && token && getSetting(LS.session, "") === key) {
            return Jellyfin.validateToken(server, token).then(function (a) {
                // userId aus /Users/Me ist maßgeblich
                localStorage.setItem(LS.userId, a.userId);
                return a;
            });
        }
        return Jellyfin.authenticate(server, user, pass).then(function (auth) {
            localStorage.setItem(LS.token, auth.token);
            localStorage.setItem(LS.userId, auth.userId);
            localStorage.setItem(LS.session, key);
            el.cfgPass.value = "";
            return auth;
        });
    }

    /* ------------------------------------------------------------------ *
     *  Verbindungstest
     * ------------------------------------------------------------------ */
    function setStatus(node, text, kind) {
        node.textContent = text;
        node.className = "status-line" + (kind ? " " + kind : "");
    }

    el.btnTest.addEventListener("click", function () {
        saveSettingsFromForm();
        const server = el.cfgServer.value.trim();
        const user = el.cfgUser.value.trim();
        const pass = el.cfgPass.value;
        if (!server) { setStatus(el.testResult, t("test.needServer"), "err"); return; }

        el.btnTest.disabled = true;
        setStatus(el.testResult, t("test.connecting"), "");
        Jellyfin.getPublicInfo(server).then(function (info) {
            const name = info.ServerName || "Jellyfin";
            if (!user) {
                setStatus(el.testResult, t("test.reachable", { name: name, version: info.Version || "?" }), "ok");
                return null;
            }
            return getSession(server, user, pass).then(function (auth) {
                setStatus(el.testResult, t("test.connected", { name: name, user: auth.userName }), "ok");
            });
        }).catch(function (err) {
            setStatus(el.testResult, t("error.prefix", { message: err.message }), "err");
        }).finally(function () {
            el.btnTest.disabled = false;
        });
    });

    /* ------------------------------------------------------------------ *
     *  Bibliothek aktualisieren
     * ------------------------------------------------------------------ */
    function mapItem(it) {
        // Aufloesung/Sprachen: bei Filmen direkt aus den Streams; bei Serien werden
        // sie spaeter aus den Folgen aggregiert (Serien-Container hat keine Streams).
        const mi = Jellyfin.mediaInfo(it);
        return {
            id: it.Id,
            type: it.Type,
            name: it.Name || "",
            sortName: (it.Name || "").toLowerCase(),
            year: it.ProductionYear || null,
            overview: it.Overview || "",
            genres: it.Genres || [],
            rating: typeof it.CommunityRating === "number" ? it.CommunityRating : null,
            artist: it.AlbumArtist || (it.Artists && it.Artists[0]) || "",
            resolution: mi.resolution || "",
            audio: mi.audio || [],
            subs: mi.subs || [],
            episodeCount: 0,
            seasonCount: 0,
            hasImage: !!(it.ImageTags && it.ImageTags.Primary)
        };
    }

    function setProgress(done, total, label) {
        const pct = total ? Math.round((done / total) * 100) : 0;
        el.progressFill.style.width = pct + "%";
        setStatus(el.progressText, label, "");
    }

    /* Bilder in Chunks mit begrenzter Parallelitaet laden und speichern. */
    function syncImagesAndStore(server, token, rawItems, mapped, withImages) {
        const CHUNK = 24;
        const total = rawItems.length;
        let index = 0;

        function nextChunk() {
            if (index >= total) return Promise.resolve();
            const rawSlice = rawItems.slice(index, index + CHUNK);
            const mappedSlice = mapped.slice(index, index + CHUNK);
            index += rawSlice.length;

            const imgPromises = rawSlice.map(function (raw) {
                if (!withImages || !(raw.ImageTags && raw.ImageTags.Primary)) {
                    return Promise.resolve(null);
                }
                return Jellyfin.fetchImageBlob(server, raw, 360).then(function (blob) {
                    return blob ? { id: raw.Id, blob: blob } : null;
                });
            });

            return Promise.all(imgPromises).then(function (images) {
                return DB.putBatch(mappedSlice, images.filter(Boolean));
            }).then(function () {
                setProgress(index, total, t("sync.saving", { done: index, total: total }));
                return nextChunk();
            });
        }
        return nextChunk();
    }

    function uniq(arr) {
        const seen = {}, out = [];
        arr.forEach(function (v) { if (v && !seen[v]) { seen[v] = true; out.push(v); } });
        return out;
    }

    /* Fuer jede Serie die Folgen laden, Staffeln/Folgen speichern und die
     * aggregierte Media-Info (Aufloesung/Sprachen) auf das Serien-Item schreiben. */
    function processSeries(server, token, userId, seriesItem) {
        return Jellyfin.fetchEpisodes(server, token, userId, seriesItem.id)
            .then(function (episodes) {
                const list = episodes.map(function (ep) {
                    const mi = Jellyfin.mediaInfo(ep);
                    return {
                        season: (typeof ep.ParentIndexNumber === "number") ? ep.ParentIndexNumber : null,
                        episode: (typeof ep.IndexNumber === "number") ? ep.IndexNumber : null,
                        name: ep.Name || "",
                        resolution: mi.resolution || "",
                        audio: mi.audio || [],
                        subs: mi.subs || []
                    };
                });
                list.sort(function (a, b) {
                    const sa = a.season == null ? 999 : a.season;
                    const sb = b.season == null ? 999 : b.season;
                    if (sa !== sb) return sa - sb;
                    return (a.episode || 0) - (b.episode || 0);
                });
                // Serien-Item mit aggregierter Info anreichern.
                const seasons = {};
                let res = [], aud = [], sub = [];
                list.forEach(function (e) {
                    if (e.season != null) seasons[e.season] = true;
                    if (e.resolution) res.push(e.resolution);
                    aud = aud.concat(e.audio);
                    sub = sub.concat(e.subs);
                });
                seriesItem.resolution = uniq(res).join(", ");
                seriesItem.audio = uniq(aud);
                seriesItem.subs = uniq(sub);
                seriesItem.episodeCount = list.length;
                seriesItem.seasonCount = Object.keys(seasons).length;
                return Promise.all([
                    DB.putEpisodes(seriesItem.id, list),
                    DB.putBatch([seriesItem], [])
                ]);
            });
    }

    /* Fuer jede Serie die Folgen laden — mit begrenzter Parallelitaet (Worker-Pool),
     * damit bei hunderten Serien nicht hunderte Requests nacheinander laufen. */
    function syncSeriesEpisodes(server, token, userId, rawItems, mapped) {
        const seriesItems = [];
        rawItems.forEach(function (raw, i) {
            if (raw.Type === "Series") seriesItems.push(mapped[i]);
        });
        const total = seriesItems.length;
        if (total === 0) return Promise.resolve();

        const CONCURRENCY = 5;
        let cursor = 0, done = 0;

        function worker() {
            if (cursor >= total) return Promise.resolve();
            const seriesItem = seriesItems[cursor++];
            return processSeries(server, token, userId, seriesItem)
                .catch(function () { /* einzelne Serie ueberspringen */ })
                .then(function () {
                    done++;
                    setProgress(done, total, t("sync.series", { done: done, total: total }));
                    return worker();
                });
        }

        const workers = [];
        for (let w = 0; w < Math.min(CONCURRENCY, total); w++) workers.push(worker());
        return Promise.all(workers);
    }

    el.btnSync.addEventListener("click", function () {
        saveSettingsFromForm();
        const server = el.cfgServer.value.trim();
        const user = el.cfgUser.value.trim();
        const pass = el.cfgPass.value;
        const withImages = el.cfgImages.checked;

        if (!server || !user) {
            setStatus(el.testResult, t("sync.needServerUser"), "err");
            return;
        }

        el.btnSync.disabled = true;
        el.btnTest.disabled = true;
        el.syncProgress.classList.remove("hidden");
        setProgress(0, 1, t("sync.login"));

        let token, userId;
        getSession(server, user, pass).then(function (auth) {
            token = auth.token;
            userId = auth.userId;
            setProgress(0, 1, t("sync.loadingList"));
            return Jellyfin.fetchAllItems(server, token, userId, function (loaded, total) {
                setProgress(0, 1, t("sync.loadingListProgress", { loaded: loaded, total: total }));
            });
        }).then(function (rawItems) {
            const mapped = rawItems.map(mapItem);
            // Alte Daten ersetzen, dann neu schreiben.
            return DB.clearAll().then(function () {
                return syncImagesAndStore(server, token, rawItems, mapped, withImages)
                    .then(function () {
                        return syncSeriesEpisodes(server, token, userId, rawItems, mapped);
                    })
                    .then(function () { return mapped; });
            });
        }).then(function (mapped) {
            const now = Date.now();
            const counts = countByType(mapped);
            return Promise.all([
                DB.setMeta("lastSync", now),
                DB.setMeta("counts", counts)
            ]).then(function () {
                allItems = mapped;
                sortItems();
                setProgress(1, 1, t("sync.done", { count: mapped.length }));
                setStatus(el.progressText, t("sync.doneShort", { count: mapped.length }), "ok");
                renderResults();
                renderLibStats();
            });
        }).catch(function (err) {
            setStatus(el.progressText, t("error.prefix", { message: err.message }), "err");
        }).finally(function () {
            el.btnSync.disabled = false;
            el.btnTest.disabled = false;
        });
    });

    /* ------------------------------------------------------------------ *
     *  Daten löschen
     * ------------------------------------------------------------------ */
    el.btnClear.addEventListener("click", function () {
        if (!confirm(t("settings.confirmClear"))) return;
        DB.clearAll().then(function () {
            return Promise.all([DB.setMeta("lastSync", null), DB.setMeta("counts", null)]);
        }).then(function () {
            allItems = [];
            renderResults();
            renderLibStats();
        });
    });

    /* ------------------------------------------------------------------ *
     *  Hilfsfunktionen
     * ------------------------------------------------------------------ */
    function countByType(items) {
        const c = { Movie: 0, Series: 0, MusicAlbum: 0 };
        items.forEach(function (it) { if (c[it.type] !== undefined) c[it.type]++; });
        return c;
    }

    function sortItems() {
        allItems.sort(function (a, b) {
            return a.sortName < b.sortName ? -1 : a.sortName > b.sortName ? 1 : 0;
        });
    }

    function fmtDate(ts) {
        if (!ts) return t("stats.never");
        const d = new Date(ts);
        return d.toLocaleDateString(I18N.lang) + " " +
            d.toLocaleTimeString(I18N.lang, { hour: "2-digit", minute: "2-digit" });
    }

    function renderLibStats() {
        Promise.all([DB.getMeta("lastSync"), DB.getMeta("counts")])
            .then(function (res) {
                const last = res[0];
                const counts = res[1] || countByType(allItems);
                const b = function (v) { return "<strong>" + v + "</strong>"; };
                el.libStats.innerHTML =
                    t("stats.line", {
                        movies: b(counts.Movie || 0),
                        series: b(counts.Series || 0),
                        albums: b(counts.MusicAlbum || 0)
                    }) + "<br>" + t("stats.last", { date: b(fmtDate(last)) });
            });
    }

    function updateSyncHint() {
        DB.getMeta("lastSync").then(function (ts) {
            el.syncHint.textContent = ts ?
                t("results.synced", { date: new Date(ts).toLocaleDateString(I18N.lang) }) : "";
        });
    }

    /* ------------------------------------------------------------------ *
     *  Start
     * ------------------------------------------------------------------ */
    function init() {
        I18N.init();
        buildLangSelect();
        loadSettingsIntoForm();
        DB.getAllItems().then(function (items) {
            allItems = items || [];
            sortItems();
            renderResults();
            updateSyncHint();
        }).catch(function (err) {
            console.error("DB-Fehler:", err);
            renderResults();
        });
    }

    init();
})();
