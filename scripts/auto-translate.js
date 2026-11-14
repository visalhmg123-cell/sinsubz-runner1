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
