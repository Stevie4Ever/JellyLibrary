/* IndexedDB-Wrapper fuer JellyLibrary.
 *
 * Zwei Object-Stores:
 *   - "items"  : Metadaten pro Medium (Id, Name, Typ, Jahr, ...), OHNE Bild.
 *   - "images" : { id, blob } — die Titelbilder als Blob, getrennt gespeichert,
 *                damit die Suche nur die (leichten) Metadaten laden muss und
 *                Bilder erst beim Anzeigen (lazy) nachgeladen werden.
 *   - "meta"   : Key/Value fuer lastSync, Zaehler usw.
 */
window.DB = (function () {
    "use strict";

    const DB_NAME = "jellylibrary";
    const DB_VERSION = 2;
    let dbp = null;

    function open() {
        if (dbp) return dbp;
        dbp = new Promise(function (resolve, reject) {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = function (e) {
                const db = e.target.result;
                if (!db.objectStoreNames.contains("items")) {
                    const s = db.createObjectStore("items", { keyPath: "id" });
                    s.createIndex("type", "type", { unique: false });
                    s.createIndex("sortName", "sortName", { unique: false });
                }
                if (!db.objectStoreNames.contains("images")) {
                    db.createObjectStore("images", { keyPath: "id" });
                }
                if (!db.objectStoreNames.contains("meta")) {
                    db.createObjectStore("meta", { keyPath: "key" });
                }
                if (!db.objectStoreNames.contains("episodes")) {
                    // Ein Datensatz pro Serie: { seriesId, list: [ {season, episode, name, ...} ] }
                    db.createObjectStore("episodes", { keyPath: "seriesId" });
                }
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
        return dbp;
    }

    function tx(stores, mode) {
        return open().then(function (db) {
            return db.transaction(stores, mode);
        });
    }

    function reqAsPromise(request) {
        return new Promise(function (resolve, reject) {
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () { reject(request.error); };
        });
    }

    function txDone(transaction) {
        return new Promise(function (resolve, reject) {
            transaction.oncomplete = function () { resolve(); };
            transaction.onerror = function () { reject(transaction.error); };
            transaction.onabort = function () { reject(transaction.error); };
        });
    }

    /* Alle Medien (Metadaten, ohne Bilder) laden. */
    function getAllItems() {
        return tx(["items"], "readonly").then(function (t) {
            return reqAsPromise(t.objectStore("items").getAll());
        });
    }

    /* Ein Titelbild-Blob per Id laden (oder null). */
    function getImage(id) {
        return tx(["images"], "readonly").then(function (t) {
            return reqAsPromise(t.objectStore("images").get(id));
        }).then(function (rec) {
            return rec ? rec.blob : null;
        });
    }

    /* Einen Batch Items + zugehoerige Bilder schreiben.
     * items: Array von Metadaten-Objekten.
     * images: Array von { id, blob }. */
    function putBatch(items, images) {
        return tx(["items", "images"], "readwrite").then(function (t) {
            const itemStore = t.objectStore("items");
            const imgStore = t.objectStore("images");
            items.forEach(function (it) { itemStore.put(it); });
            images.forEach(function (im) {
                if (im && im.blob) imgStore.put(im);
            });
            return txDone(t);
        });
    }

    /* Komplette Mediathek loeschen (bei "Alles ersetzen" oder Reset). */
    function clearAll() {
        return tx(["items", "images", "episodes"], "readwrite").then(function (t) {
            t.objectStore("items").clear();
            t.objectStore("images").clear();
            t.objectStore("episodes").clear();
            return txDone(t);
        });
    }

    /* Folgenliste einer Serie speichern. */
    function putEpisodes(seriesId, list) {
        return tx(["episodes"], "readwrite").then(function (t) {
            t.objectStore("episodes").put({ seriesId: seriesId, list: list });
            return txDone(t);
        });
    }

    /* Folgenliste einer Serie laden (oder [] ). */
    function getEpisodes(seriesId) {
        return tx(["episodes"], "readonly").then(function (t) {
            return reqAsPromise(t.objectStore("episodes").get(seriesId));
        }).then(function (rec) {
            return rec ? rec.list : [];
        });
    }

    function setMeta(key, value) {
        return tx(["meta"], "readwrite").then(function (t) {
            t.objectStore("meta").put({ key: key, value: value });
            return txDone(t);
        });
    }

    function getMeta(key) {
        return tx(["meta"], "readonly").then(function (t) {
            return reqAsPromise(t.objectStore("meta").get(key));
        }).then(function (rec) {
            return rec ? rec.value : null;
        });
    }

    return {
        open: open,
        getAllItems: getAllItems,
        getImage: getImage,
        putBatch: putBatch,
        clearAll: clearAll,
        putEpisodes: putEpisodes,
        getEpisodes: getEpisodes,
        setMeta: setMeta,
        getMeta: getMeta
    };
})();
