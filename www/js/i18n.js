/* Mini-i18n fuer JellyLibrary (kein Framework).
 *
 * Neue Sprache hinzufuegen:
 *   1. www/lang/<code>.js anlegen (Kopie von en.js, Texte uebersetzen) und
 *      darin I18N.register("<code>", { name: "...", strings: {...} }) aufrufen.
 *   2. In www/index.html ein <script src="lang/<code>.js"> ergaenzen.
 * Fertig: Die Sprache erscheint automatisch in der Auswahl, und die
 * Systemsprache wird erkannt. Fehlende Schluessel fallen auf Englisch zurueck.
 *
 * HTML:  data-i18n="key" (Text), data-i18n-placeholder / data-i18n-title.
 * JS:    I18N.t("key", { name: "x" })  ersetzt {name} im Text.
 *        Mit { n: 3 } wird die Plural-Form "key.one" / "key.other" (Intl.PluralRules)
 *        gewaehlt.
 */
window.I18N = (function () {
    "use strict";

    const FALLBACK = "en";
    const LS_KEY = "jelly_lang";          // "auto" oder Sprachcode
    const langs = {};                     // code -> { name, strings }
    let current = FALLBACK;
    let plural = new Intl.PluralRules(FALLBACK);

    function register(code, def) { langs[code] = def; }

    function available() {
        return Object.keys(langs).sort().map(function (c) {
            return { code: c, name: langs[c].name };
        });
    }

    /* Beste passende Sprache aus der Systemliste (navigator.languages). */
    function detect() {
        const prefs = (navigator.languages && navigator.languages.length) ?
            navigator.languages : [navigator.language || FALLBACK];
        for (let i = 0; i < prefs.length; i++) {
            const base = String(prefs[i]).toLowerCase().split("-")[0];
            if (langs[base]) return base;
        }
        return FALLBACK;
    }

    function choice() {
        try { return localStorage.getItem(LS_KEY) || "auto"; } catch (e) { return "auto"; }
    }

    function resolve(c) {
        return (c && c !== "auto" && langs[c]) ? c : detect();
    }

    function lookup(key, code) {
        const l = langs[code];
        return l && Object.prototype.hasOwnProperty.call(l.strings, key) ?
            l.strings[key] : undefined;
    }

    function t(key, params) {
        let s;
        if (params && typeof params.n === "number") {
            s = lookup(key + "." + plural.select(params.n), current);
            if (s === undefined) s = lookup(key + ".other", current);
        }
        if (s === undefined) s = lookup(key, current);
        if (s === undefined) s = lookup(key, FALLBACK);
        if (s === undefined && params && typeof params.n === "number") {
            s = lookup(key + ".other", FALLBACK);
        }
        if (s === undefined) return key;
        if (params) {
            s = s.replace(/\{(\w+)\}/g, function (m, k) {
                return params[k] === undefined ? m : params[k];
            });
        }
        return s;
    }

    function applyDom() {
        document.documentElement.lang = current;
        document.title = t("app.title");
        document.querySelectorAll("[data-i18n]").forEach(function (n) {
            n.textContent = t(n.getAttribute("data-i18n"));
        });
        document.querySelectorAll("[data-i18n-placeholder]").forEach(function (n) {
            n.setAttribute("placeholder", t(n.getAttribute("data-i18n-placeholder")));
        });
        document.querySelectorAll("[data-i18n-title]").forEach(function (n) {
            n.setAttribute("title", t(n.getAttribute("data-i18n-title")));
        });
    }

    /* choiceCode: "auto" oder Sprachcode. */
    function setLanguage(choiceCode) {
        try { localStorage.setItem(LS_KEY, choiceCode); } catch (e) { /* egal */ }
        current = resolve(choiceCode);
        plural = new Intl.PluralRules(current);
        applyDom();
    }

    /* Beim Start: gespeicherte Wahl bzw. Systemsprache anwenden. */
    function init() {
        current = resolve(choice());
        plural = new Intl.PluralRules(current);
        applyDom();
    }

    return {
        register: register,
        available: available,
        choice: choice,
        init: init,
        setLanguage: setLanguage,
        applyDom: applyDom,
        t: t,
        get lang() { return current; }
    };
})();
