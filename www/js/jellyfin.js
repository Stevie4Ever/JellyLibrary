/* Jellyfin-API-Client fuer JellyLibrary.
 *
 * Deckt genau das ab, was die App braucht:
 *   - Verbindungstest (oeffentliche Server-Info)
 *   - Login per Benutzername/Passwort  -> AccessToken + UserId
 *     (nur das Token wird gespeichert, nie das Passwort)
 *   - Paginiertes Laden aller Filme / Serien / Musik-Alben
 *   - Bau der Titelbild-URL
 *
 * Alle Requests laufen ueber fetch(). Jellyfin sendet standardmaessig
 * permissive CORS-Header, sodass das aus der Capacitor-WebView heraus klappt.
 * Sollte ein Server CORS blocken, waere CapacitorHttp (@capacitor/core, native
 * Requests) die Fallback-Option.
 */
window.Jellyfin = (function () {
    "use strict";

    const CLIENT = "JellyLibrary";
    const VERSION = "1.0.0";
    const PAGE_SIZE = 200;

    /* Persistente, zufaellige Geraete-ID (fuer den Auth-Header). */
    function deviceId() {
        let id = localStorage.getItem("jelly_device_id");
        if (!id) {
            id = "jl-" + Math.random().toString(36).slice(2) +
                Date.now().toString(36);
            localStorage.setItem("jelly_device_id", id);
        }
        return id;
    }

    function authHeader(token) {
        let h = 'MediaBrowser Client="' + CLIENT + '", Device="Android", DeviceId="' +
            deviceId() + '", Version="' + VERSION + '"';
        if (token) h += ', Token="' + token + '"';
        return h;
    }

    /* Server-URL vereinheitlichen: Schema ergaenzen, Slash am Ende entfernen. */
    function normalizeUrl(url) {
        let u = (url || "").trim();
        if (!u) return "";
        if (!/^https?:\/\//i.test(u)) u = "http://" + u;
        return u.replace(/\/+$/, "");
    }

    /* Moderner "Authorization"-Header. Die alten X-Emby-*-Header sind ab
     * Jellyfin 12 standardmaessig abgeschaltet (401). */
    function baseHeaders(token) {
        return {
            "Authorization": authHeader(token),
            "Accept": "application/json"
        };
    }

    /* Verbindungstest: oeffentliche System-Info (ohne Login). */
    function getPublicInfo(server) {
        const url = normalizeUrl(server) + "/System/Info/Public";
        return fetch(url, { method: "GET" }).then(function (r) {
            if (!r.ok) throw new Error(I18N.t("error.http", { status: r.status }));
            return r.json();
        });
    }

    /* Login. Liefert { token, userId, userName, serverName }. */
    function authenticate(server, username, password) {
        const url = normalizeUrl(server) + "/Users/AuthenticateByName";
        return fetch(url, {
            method: "POST",
            headers: Object.assign({ "Content-Type": "application/json" },
                baseHeaders(null)),
            body: JSON.stringify({ Username: username, Pw: password || "" })
        }).then(function (r) {
            if (r.status === 401) throw new Error(I18N.t("error.badLogin"));
            if (!r.ok) throw new Error(I18N.t("error.loginFailed", { status: r.status }));
            return r.json();
        }).then(function (data) {
            return {
                token: data.AccessToken,
                userId: data.User && data.User.Id,
                userName: data.User && data.User.Name,
                serverName: data.ServerName
            };
        });
    }

    /* Prueft ein gespeichertes Token. Liefert { token, userId, userName }
     * oder wirft Error mit code "auth" bei 401. */
    function validateToken(server, token) {
        const url = normalizeUrl(server) + "/Users/Me";
        return fetch(url, { method: "GET", headers: baseHeaders(token) })
            .then(function (r) {
                if (r.status === 401) {
                    const e = new Error(I18N.t("error.sessionExpired"));
                    e.code = "auth";
                    throw e;
                }
                if (!r.ok) throw new Error(I18N.t("error.http", { status: r.status }));
                return r.json();
            }).then(function (u) {
                return { token: token, userId: u.Id, userName: u.Name };
            });
    }

    /* Eine Seite Items laden. */
    function fetchPage(server, token, userId, startIndex) {
        const params = new URLSearchParams({
            Recursive: "true",
            IncludeItemTypes: "Movie,Series,MusicAlbum",
            Fields: "Overview,ProductionYear,Genres,CommunityRating,OfficialRating,PremiereDate,MediaSources,MediaStreams",
            SortBy: "SortName",
            SortOrder: "Ascending",
            ImageTypeLimit: "1",
            EnableImageTypes: "Primary",
            StartIndex: String(startIndex),
            Limit: String(PAGE_SIZE)
        });
        const url = normalizeUrl(server) + "/Users/" + userId + "/Items?" + params.toString();
        return fetch(url, { method: "GET", headers: baseHeaders(token) })
            .then(function (r) {
                if (r.status === 401) {
                    const e = new Error(I18N.t("error.sessionExpired"));
                    e.code = "auth";
                    throw e;
                }
                if (!r.ok) throw new Error(I18N.t("error.loadFailed", { status: r.status }));
                return r.json();
            });
    }

    /* Alle Items paginiert laden.
     * onProgress(loaded, total) wird nach jeder Seite aufgerufen.
     * Liefert das rohe Array der Jellyfin-Item-Objekte. */
    function fetchAllItems(server, token, userId, onProgress) {
        const all = [];
        function next(startIndex) {
            return fetchPage(server, token, userId, startIndex).then(function (data) {
                const items = data.Items || [];
                const total = data.TotalRecordCount || items.length;
                items.forEach(function (it) { all.push(it); });
                if (onProgress) onProgress(all.length, total);
                if (all.length < total && items.length > 0) {
                    return next(startIndex + items.length);
                }
                return all;
            });
        }
        return next(0);
    }

    /* Alle Folgen einer Serie laden (mit Media-Info, ohne Bilder/Overview).
     * Liefert das rohe Array der Episode-Objekte. */
    function fetchEpisodes(server, token, userId, seriesId) {
        const params = new URLSearchParams({
            userId: userId,
            Fields: "MediaSources,MediaStreams",
            EnableImages: "false"
        });
        const url = normalizeUrl(server) + "/Shows/" + seriesId + "/Episodes?" +
            params.toString();
        return fetch(url, { method: "GET", headers: baseHeaders(token) })
            .then(function (r) {
                if (!r.ok) throw new Error(I18N.t("error.http", { status: r.status }));
                return r.json();
            }).then(function (data) { return data.Items || []; })
            .catch(function () { return []; });
    }

    /* ---- Media-Info (Aufloesung / Sprachen / Untertitel) aus einem Item ---- */

    function streamsOf(item) {
        if (item.MediaStreams && item.MediaStreams.length) return item.MediaStreams;
        if (item.MediaSources && item.MediaSources.length &&
            item.MediaSources[0].MediaStreams) {
            return item.MediaSources[0].MediaStreams;
        }
        return [];
    }

    /* Aufloesungslabel aus der Video-Hoehe/-Breite. */
    function resolutionLabel(streams) {
        let best = 0, w = 0;
        streams.forEach(function (s) {
            if (s.Type === "Video") {
                if ((s.Height || 0) > best) best = s.Height || 0;
                if ((s.Width || 0) > w) w = s.Width || 0;
            }
        });
        if (!best && !w) return "";
        if (best >= 2000 || w >= 3400) return "4K";
        if (best >= 1400 || w >= 2000) return "1440p";
        if (best >= 1000 || w >= 1800) return "1080p";
        if (best >= 700 || w >= 1200) return "720p";
        if (best >= 560) return "DVD (576p)";
        if (best >= 460) return "DVD (480p)";
        return "SD";
    }

    /* Sprachen aus Streams eines bestimmten Typs (eindeutige Liste der Rohcodes). */
    function langsOf(streams, type) {
        const seen = {};
        const out = [];
        streams.forEach(function (s) {
            if (s.Type !== type) return;
            const code = (s.Language || "").toLowerCase();
            const key = code || "und";
            if (!seen[key]) { seen[key] = true; out.push(key); }
        });
        return out;
    }

    /* Kompakte Media-Info fuer ein Item mit Streams. */
    function mediaInfo(item) {
        const streams = streamsOf(item);
        return {
            resolution: resolutionLabel(streams),
            audio: langsOf(streams, "Audio"),
            subs: langsOf(streams, "Subtitle")
        };
    }

    /* Titelbild-URL fuer ein Item (Primary). */
    function imageUrl(server, item, maxHeight) {
        const tags = item.ImageTags || {};
        if (!tags.Primary) return null;
        const params = new URLSearchParams({
            tag: tags.Primary,
            maxHeight: String(maxHeight || 360),
            quality: "90"
        });
        return normalizeUrl(server) + "/Items/" + item.Id + "/Images/Primary?" +
            params.toString();
    }

    /* Titelbild als Blob laden (oder null bei Fehler / keinem Bild). */
    function fetchImageBlob(server, item, maxHeight) {
        const url = imageUrl(server, item, maxHeight);
        if (!url) return Promise.resolve(null);
        return fetch(url).then(function (r) {
            if (!r.ok) return null;
            return r.blob();
        }).catch(function () { return null; });
    }

    return {
        normalizeUrl: normalizeUrl,
        getPublicInfo: getPublicInfo,
        authenticate: authenticate,
        validateToken: validateToken,
        fetchAllItems: fetchAllItems,
        fetchEpisodes: fetchEpisodes,
        mediaInfo: mediaInfo,
        imageUrl: imageUrl,
        fetchImageBlob: fetchImageBlob
    };
})();
