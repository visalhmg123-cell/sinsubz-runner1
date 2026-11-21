/* Weekly Redis backup: pulls every key through the site's admin API into backups/sinsubz-YYYY-MM-DD.json.
   Env: ADMIN_KEY (required)   SITE_URL (default https://sinsubs.site) */
"use strict";
const fs = require("fs");
const zlib = require("zlib");
const SITE = (process.env.SITE_URL || "https://sinsubs.site").replace(/\/$/, "");
const H = { "x-admin-key": process.env.ADMIN_KEY || "", "Content-Type": "application/json" };
async function call(path, opt) {
    for (let a = 0; a < 4; a++) {
        try {
            const r = await fetch(SITE + "/api/stats?backup=" + path, Object.assign({ headers: H }, opt || {}));
            if (r.ok) { return await r.json(); }
            if (r.status === 401) { throw new Error("401: wrong ADMIN_KEY"); }
        } catch (e) { if (/401/.test(e.message)) { throw e; } }
        await new Promise(r => setTimeout(r, 2000 * (a + 1)));
    }
    throw new Error("failed: " + path);
}
(async () => {
    if (!H["x-admin-key"]) { console.error("ADMIN_KEY is not set"); process.exit(1); }
    let keys = [], cur = "0";
    do { const d = await call("keys&cursor=" + cur); keys = keys.concat(d.keys || []); cur = d.cursor || "0"; } while (cur !== "0");
    console.log("keys:", keys.length);
    let items = [];
    for (let i = 0; i < keys.length; i += 40) {
        const d = await call("dump", { method: "POST", body: JSON.stringify({ keys: keys.slice(i, i + 40) }) });
        items = items.concat(d.items || []);
    }
    if (items.length < 10) { console.error("too few items, not saving"); process.exit(1); }
    fs.mkdirSync("backups", { recursive: true });
    const name = "backups/sinsubz-" + new Date().toISOString().slice(0, 10) + ".json.gz";   // gzip: the plain file passes GitHub's 100 MB limit
    fs.writeFileSync(name, zlib.gzipSync(JSON.stringify({ app: "sinsubz", t: Date.now(), items }), { level: 9 }));
    // keep only the newest 8 files
    fs.readdirSync("backups").filter(f => /^sinsubz-.*\.json(\.gz)?$/.test(f)).sort().slice(0, -8).forEach(f => fs.unlinkSync("backups/" + f));
    console.log("saved", name, items.length, "items");
})().catch(e => { console.error(e.message); process.exit(1); });
