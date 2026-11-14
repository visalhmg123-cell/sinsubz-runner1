#!/usr/bin/env node
/* SinSubz auto-translate runner (GitHub Actions, .github/workflows/auto-translate.yml).

   In the LAST HOUR before the Gemini quota resets (midnight Pacific = 13:30 in Sri Lanka, so it starts about 12:40) it uses
   the quota that is still unused (it would be lost anyway) to translate the episodes / films listed in
   auto-queue.json that are not on the site yet. It stops at the reset, so visitors get the fresh quota, and stores them as "Ready" subtitles (api/_ready.js) so anybody can
   download them from the home page.

   It drives the REAL website in a headless browser (same code path as a visitor: SubDL search -> download -> clean ->
   40-line chunks -> Gemini -> word notes -> credit line), so the result is identical to a normal translation. The only
   difference: every /api/translate call carries the admin key, so there is no sign-in and no daily limit.

   Env:  ADMIN_KEY (required, same value as in Vercel)    SITE_URL (default https://sinsubs.site)
         MAX_PER_RUN (override queue file)   MAX_MINUTES (default 70)   FORCE=1 (skip the "is it quota-reset time?" check)

   WHAT it translates (api/_autoq.js keeps the list in the database):
     1. titles listed by hand in auto-queue.json (worked first)
     2. the SERIES LIST, in order: the first series until every episode is done (over as many days as it takes), then the
        next one. Every Sunday up to 10 new series WITHOUT a Sinhala subtitle (baiscope / cineru / sinhalasub) are added
        to the end: demand (what visitors translated / searched) first, then newly released, then random good ones.
        The very first run fills the list at once (REFILL=1 forces a refill any day).
   Stops by itself when Gemini says the quota is used up, at the quota reset, or after 3 failures in a row.  Safe to
   run again: finished episodes are skipped and the next run continues where this one stopped. */
"use strict";

const fs = require("fs");
const path = require("path");

const SITE = (process.env.SITE_URL || "https://sinsubs.site").replace(/\/$/, "");
const KEY = process.env.ADMIN_KEY || "";
const MAX_MS = (Number(process.env.MAX_MINUTES) || 60) * 60 * 1000;
let started = Date.now();

function log() { console.log.apply(console, ["[" + new Date().toISOString().slice(11, 19) + "]"].concat([].slice.call(arguments))); }

function pacificHour() {
    return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false }).format(new Date())) % 24;
}

async function api(pathAndQuery, opts) {
    const res = await fetch(SITE + pathAndQuery, opts);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { ok: res.ok, status: res.status, json, text };
}

function wanted(queue) {
    const out = [];
    (queue.titles || []).forEach(t => {
        if (!/^tt\d{5,10}$/.test(String(t.imdb || ""))) { log("skip (bad imdb id):", t.title); return; }
        if (t.type === "tv") {
            (t.episodes || []).forEach(e => out.push({ t, season: Number(t.season), episode: Number(e) }));
        } else {
            out.push({ t, season: 0, episode: 0 });
        }
    });
    return out;
}

// runs inside the website page
async function translateInPage(job) {
    const item = {
        imdbID: job.imdb, title: job.title, year: job.year || "", poster: job.poster || "",
        type: job.type === "tv" ? "series" : "movie"
    };
    const isTv = job.type === "tv";
    const q = new URLSearchParams({ imdb_id: job.imdb, type: isTv ? "episode" : "movie" });
    if (isTv) { q.set("season", String(job.season)); q.set("episode", String(job.episode)); }
    let r, d, list = [];
    for (let attempt = 0; attempt < 2 && !list.length; attempt++) {      // an empty answer may be a hiccup: ask once more
        if (attempt) { await new Promise(res => setTimeout(res, 6000)); }
        r = await fetch("/api/subtitles?" + q);
        d = await r.json();
        if (!r.ok) { throw new Error("subtitle search: " + (d.error || r.status)); }
        list = (d.results || []).filter(s => !s.hearingImpaired).concat((d.results || []).filter(s => s.hearingImpaired));
    }
    if (!list.length) { return { skip: "no English subtitle on SubDL" }; }

    let subs = null, release = "", dlFailed = 0, tried = 0, why = "", rate429 = false;
    const seenUrl = new Set();
    for (const cand of list.slice(0, 20)) {          // not only the first few: go on down the results until one file is usable
        const u0 = cand.downloadUrl || cand.url || cand.download_url;
        if (u0 && seenUrl.has(u0)) { continue; }
        if (u0) { seenUrl.add(u0); }
        if (tried) { await new Promise(r => setTimeout(r, 4000)); }
        try {
            const url = cand.downloadUrl || cand.url || cand.download_url;
            if (!url) { continue; }
            const dr = await fetch("/api/subtitle-download?url=" + encodeURIComponent(url.startsWith("/") ? "https://dl.subdl.com" + url : url));
            tried++;
            const dd = await dr.json().catch(() => ({}));
            if (dr.status === 429) { rate429 = true; why = "429 SubDL download rate limit"; break; }   // do not hammer it with the other results
            if (!dr.ok || !dd.data) { dlFailed++; why = dr.status + " " + String(dd.error || "no data").replace(/api_key=[^&\s]+/g, "api_key=***").slice(0, 80); continue; }
            const bin = atob(dd.data);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); }
            if (isZipFile(bytes)) { continue; }
            const parsed = parseSRT(decodeSubtitleBytes(bytes));
            if (parsed.length >= (isTv ? 150 : 400)) { subs = parsed; release = String(cand.release || cand.fileName || ""); break; }
        } catch (e) { dlFailed++; why = String(e && e.message || e).slice(0, 80); /* try the next file */ }
    }
    // every download failed (SubDL busy / throttling us): that says nothing about the episode, try again later
    if (!subs && rate429) { return { retry: "subtitle download failed: " + why }; }
    if (!subs && tried && dlFailed >= tried) { return { retry: "subtitle download failed: " + why }; }
    if (!subs) { return { skip: "no usable English file (too short / bad)" }; }

    const translated = await translateWithLibrary(subs, item, job.season || null, job.episode || null,
        { title: job.title + (job.year ? " (" + job.year + ")" : "") });
    const srt = buildSRT(addSinSubzCredit(typeof applyWordNotes === "function" ? applyWordNotes(translated) : translated));
    const base = getSubtitleBaseName(item, job.season, job.episode);
    return { srt, count: translated.length, filename: base + ".Sinhala.SinSubz.srt", release };
}

// "Stop" button in the admin panel sets a flag in Redis; checked between episodes and while waiting
async function stopRequested() {
    try { const r = await api("/api/stats?cron=runner&act=flag", { headers: AK() }); return !!(r.json && r.json.stop); } catch (e) { return false; }
}

const AK = () => ({ "x-admin-key": KEY });
const post = (p, body) => api(p, { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, AK()), body: JSON.stringify(body) });

function sriLankaWeekday() {
    return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Colombo", weekday: "short" }).format(new Date());
}

// does one of the Sinhala sites already have a subtitle for this series?  (null = could not check)
async function hasSinhala(c) {
    try {
        const r = await api("/api/sinhala-search?title=" + encodeURIComponent(c.title) + "&year=" + encodeURIComponent(c.year || "") + "&type=series");
        if (!r.ok || !r.json) { return null; }
        return !!r.json.found;
    } catch (e) { return null; }
}

// Sunday (or the very first run): add up to <weekly> new series without a Sinhala subtitle to the list
async function refillIfDue(weekly, meta, emptyList) {
    const due = process.env.REFILL === "1" || emptyList || !meta.lastRefill || (sriLankaWeekday() === "Sun" && Date.now() - meta.lastRefill > 5 * 86400000);
    if (!due) { log("Weekly refill: not due (next Sunday)."); return false; }
    log("Weekly refill: looking for up to " + weekly + " series without a Sinhala subtitle ...");
    const cand = await api("/api/stats?autoq=candidates", { headers: AK() });
    const items = (cand.json && cand.json.items) || [];
    if (!cand.ok) { log("  candidates failed: " + cand.status + " " + cand.text.slice(0, 120)); return false; }
    log("  " + items.length + " candidates (demand first, then new, then random).");
    const picked = [];
    for (const c of items) {
        if (picked.length >= weekly) { break; }
        const found = await hasSinhala(c);
        if (found === true) { log("  skip " + c.title + " (" + c.src + "): already has a Sinhala subtitle"); continue; }
        if (found === null) { log("  " + c.title + ": could not check Sinhala sites, adding anyway"); }
        picked.push(c);
        log("  + " + c.title + " (" + c.year + ", " + c.src + ", " + c.total + " episodes)");
    }
    if (picked.length) {
        const r = await post("/api/stats?autoq=add", { items: picked });
        log("  added " + ((r.json && r.json.added) || 0) + " series, list size " + ((r.json && r.json.size) || "?"));
    } else { log("  nothing new to add this week."); }
    await post("/api/stats?autoq=meta", { lastRefill: true });
    return true;
}

(async () => {
    if (!KEY) { console.error("ADMIN_KEY is not set"); process.exit(1); }

    const manual = (process.env.GITHUB_EVENT_NAME === "workflow_dispatch" && process.env.FROM_CRON !== "1") || process.env.FORCE === "1";
    // Vercel's free cron can fire up to an hour early/late: if it came early (Pacific hour 22) just wait for hour 23.
    if (!manual && pacificHour() === 22) {
        log("Started early (Pacific hour 22): waiting for the last hour before the reset (23) ...");
        for (let w = 0; w < 130 && pacificHour() === 22; w++) { await new Promise(r => setTimeout(r, 30000)); }
        started = Date.now();
    }
    if (!manual && pacificHour() !== 23) {
        log("Pacific hour is " + pacificHour() + ", not the last hour before the reset (23): nothing to do (the other cron entry covers it).");
        return;
    }

    if (await stopRequested()) { log("Stop flag is set (admin panel): not starting."); return; }
    const queue = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "auto-queue.json"), "utf8"));
    const maxRun = Number(process.env.MAX_PER_RUN) || Number(queue.max_per_run) || 200;
    const weekly = Number(process.env.WEEKLY_SERIES) || Number(queue.weekly_series) || 10;

    let aq = await api("/api/stats?autoq=get", { headers: AK() });
    if (!aq.ok) { console.error("Could not read the series list: " + aq.status + " " + aq.text.slice(0, 120)); process.exit(1); }
    const remaining = () => ((aq.json && aq.json.list) || []).reduce((a, sr) => a + ((sr.todo || []).length), 0);
    log("Series list: " + (((aq.json && aq.json.list) || []).length) + " series, " + remaining() + " episodes still to do" +
        (((aq.json && aq.json.list) || []).length ? " (" + ((aq.json.list)).map(sr => sr.title + ": " + (sr.todo || []).length + " left, " + (sr.skipped || 0) + " skipped").join("; ") + ")" : "") + ".");
    // nothing left in the list (finished, or all skipped/cleared): fill it again now instead of waiting for Sunday
    const emptyList = remaining() === 0 && wanted(queue).length === 0;
    try { if (await refillIfDue(weekly, (aq.json && aq.json.meta) || {}, emptyList)) { aq = await api("/api/stats?autoq=get", { headers: AK() }); } } catch (e) { log("refill failed: " + e.message); }

    const list = await api("/api/stats?ready=list");
    const have = new Set();
    ((list.json && list.json.items) || []).forEach(it => it.eps.forEach(e => have.add(it.id + "|" + (it.type === "tv" ? e.s : 0) + "|" + (it.type === "tv" ? e.e : 0))));

    // 1) hand-picked titles first, then 2) the series list in order (first series completely, then the next)
    let all = wanted(queue);
    ((aq.json && aq.json.list) || []).forEach(sr => {
        (sr.todo || []).forEach(p => all.push({ t: { imdb: sr.imdb, title: sr.title, year: sr.year, poster: sr.poster, type: sr.type === "movie" ? "movie" : "tv" }, season: p[0], episode: p[1], queued: true }));
    });
    if (process.env.LIST_ONLY === "1") { log("LIST_ONLY: would work on " + [...new Set(all.map(j => j.t.title))].join(", ")); return; }
    const todo = all.filter(j => !have.has(j.t.imdb + "|" + j.season + "|" + j.episode));
    log("Queue: " + todo.length + " episodes / films to do in " + new Set(todo.map(j => j.t.imdb)).size + " titles, this run does at most " + maxRun + ".");
    if (!todo.length) { return; }

    const { chromium } = require("playwright");
    const browser = await chromium.launch();
    const ctx = await browser.newContext();
    // no Google sign-in in the runner: pretend there is a token (the server accepts the admin key instead)
    await ctx.addInitScript(() => {
        try { Object.defineProperty(window, "__sinsubzIdToken", { value: async () => "runner", configurable: false, writable: false }); } catch (e) { /* ignore */ }
    });
    await ctx.route(/\/api\/(translate|subtitle-download)/, route => route.continue({ headers: Object.assign({}, route.request().headers(), { "x-admin-key": KEY }) }));
    const page = await ctx.newPage();
    await page.goto(SITE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof translateWithLibrary === "function" && typeof buildSRT === "function", null, { timeout: 60000 });

    let done = 0, failsInRow = 0;
    const noSub = {};      // series -> consecutive episodes without an English subtitle (= not aired / not on SubDL yet)
    const closed = new Set();   // series given up for now (7 days)
    let quotaWaits = 0, noSubAll = 0;
    const subdlWaits = {}, dlGiveUp = {}, outsideRetries = {};
    stop: for (let i = 0; i < todo.length; i++) {
        const job = todo[i];
        const id = job.t.imdb;
        if (closed.has(id)) { continue; }
        if (done >= maxRun) { log("Reached the per-run limit."); break; }
        if (Date.now() - started > MAX_MS) { log("Time limit reached (" + Math.round(MAX_MS / 60000) + " minutes): stopping."); break; }
        if (await stopRequested()) { log("Stopped from the admin panel."); break; }
        if (!manual && pacificHour() !== 23) { log("Quota reset reached: the fresh quota is for visitors, stopping."); break; }
        if (i > 0) { await new Promise(r => setTimeout(r, 6000)); }   // be gentle with SubDL
        const label = job.t.title + (job.t.type === "tv" ? " S" + String(job.season).padStart(2, "0") + "E" + String(job.episode).padStart(2, "0") : "");
        log("Translating " + label + " ...");
        try {
            const out = await page.evaluate(translateInPage, Object.assign({}, job.t, { season: job.season, episode: job.episode }));
            if (out.retry) { throw new Error("SUBDL_RETRY " + out.retry); }
            if (out.skip) {
                log("  skipped: " + out.skip);
                if (job.queued && /no English subtitle/.test(out.skip) && ++noSubAll >= 6) {
                    // many different episodes in a row without an English subtitle: SubDL is most likely failing, not the series
                    log("6 episodes in a row without an English subtitle: SubDL looks unavailable, stopping WITHOUT marking them.");
                    break stop;
                }
                if (job.queued) {
                    await post("/api/stats?autoq=mark", { imdb: id, eps: [[job.season, job.episode]] }).catch(() => null);
                    if (/no English subtitle/.test(out.skip) && (noSub[id] = (noSub[id] || 0) + 1) >= 3) {
                        // 3 in a row: the rest is not available yet -> leave the series for now, go on with the next one
                        const rest = todo.filter(j => j.t.imdb === id && j.queued).map(j => [j.season, j.episode]);
                        await post("/api/stats?autoq=mark", { imdb: id, eps: rest }).catch(() => null);
                        closed.add(id);
                        log("  3 episodes in a row without an English subtitle: leaving " + job.t.title + " for 7 days, next series.");
                    }
                }
                continue;
            }
            noSub[id] = 0; noSubAll = 0;
            const put = await post("/api/stats?ready=put", { imdb: id, title: job.t.title, year: job.t.year, poster: job.t.poster, type: job.t.type === "tv" ? "tv" : "movie", season: job.season, episode: job.episode, filename: out.filename, srt: out.srt, count: out.count, release: out.release });
            if (!put.ok) { throw new Error("store failed " + put.status + " " + put.text.slice(0, 120)); }
            log("  done: " + out.count + " lines");
            done++; failsInRow = 0;
        } catch (e) {
            const msg = String(e && e.message || e);
            log("  failed: " + msg.replace(/api_key=[^&\s]+/g, "api_key=***"));
            if (/SUBDL_RETRY.*429|429.*SubDL/i.test(msg)) {
                // SubDL's free plan allows 50 file downloads per day (resets 05:30 Sri Lanka time): nothing to wait for
                log("SubDL daily download limit reached (free plan: 50 downloads a day, resets 05:30 SL). Stopping: nothing is marked, the next run continues.");
                break stop;
            }
            if (/SUBDL_RETRY|subtitle search|service_busy|SubDL/i.test(msg)) {
                // SubDL throttles fast callers: wait and try this episode again (not marked, not a Gemini problem)
                subdlWaits[id + job.season + "x" + job.episode] = (subdlWaits[id + job.season + "x" + job.episode] || 0) + 1;
                if (subdlWaits[id + job.season + "x" + job.episode] <= 4) {
                    const waitS = 60 * subdlWaits[id + job.season + "x" + job.episode];     // 60, 120, 180, 240 s: SubDL's limit needs time
                    log("SubDL download is limited: waiting " + waitS + " seconds, then trying " + label + " again (" + subdlWaits[id + job.season + "x" + job.episode] + "/4).");
                    await new Promise(r => setTimeout(r, waitS * 1000));
                    i--; continue;
                }
                log("Download still failing for " + label + ": leaving it for the next run.");
                if ((dlGiveUp[id] = (dlGiveUp[id] || 0) + 1) >= 2) { closed.add(id); log("  2 episodes of " + job.t.title + " could not be downloaded: skipping this series for this run (not marked), next series."); }
                if (++failsInRow >= 3) { log("3 failures in a row: stopping."); break stop; }
                continue;
            }
            if (/quota|limit|busy|exhaust|try again/i.test(msg)) {
                // Not a reason to give up: wait a little and try this episode again, until the quota resets (the loop top
                // stops at the reset hour). Outside the last hour before the reset (manual test runs) there is nothing to wait for.
                if (pacificHour() !== 23) {
                    // the server already tried every key; a per-minute limit clears in a minute and then a key works again, so try this episode twice more before giving up
                    if ((outsideRetries[label] = (outsideRetries[label] || 0) + 1) <= 2) {
                        log("Gemini says no key can answer right now: waiting 60 seconds, then trying " + label + " again (" + outsideRetries[label] + "/2).");
                        await new Promise(r => setTimeout(r, 60000));
                        i--; continue;
                    }
                    log("Gemini quota is used up on every key and the reset is far away: stopping."); break stop;
                }
                quotaWaits++;
                log("Gemini quota is used up: waiting 2 minutes, then trying " + label + " again (wait " + quotaWaits + ").");
                for (let w = 0; w < 8; w++) {                      // 8 x 15 s, watching the clock
                    await new Promise(r => setTimeout(r, 15000));
                    if (pacificHour() !== 23 && !manual) { break; }
                    if (Date.now() - started > MAX_MS || (w === 3 && await stopRequested())) { break; }
                }
                i--;                                               // same episode again
                continue;
            }
            if (++failsInRow >= 3) { log("3 failures in a row: stopping."); break stop; }
        }
    }
    await browser.close();
    log("Finished. Translated " + done + " this run.");
})().catch(e => { console.error(e); process.exit(1); });
