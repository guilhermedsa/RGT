window.RGT_SOURCES = [["world/","../RGT-mapas/"],["char/body_","../RGT-sprites1/"],["char/head_","../RGT-sprites1/"],["char/weapon_","../RGT-sprites1/"],["char/index","../RGT-sprites1/"],["char/hat_","../RGT-sprites2/"],["char/robe_","../RGT-sprites2/"]];
// Ragnarok Tactics on the web: where the converted RO files are (RGT_ASSETS, a folder URL ending in
// "/", ro_assets/ next to the page by default), and how they get into the game's file system.
// Assets.has_file() and Assets.prefetch() (scripts/autoload/assets.gd) call these through
// JavaScriptBridge; files land in /ro_assets/ of the engine's file system (engine.copyToFS).
// RGT_SOURCES ([[path prefix, folder URL]...], set before this script) sends some files elsewhere:
// the GitHub Pages build splits ro_assets across several sites (tools/web/make_pages.mjs).
// Downloads are kept in the browser's Cache Storage under the assets' version (web.json), so a
// second visit reads them from disk; a new conversion (a new version) starts a new cache.
window.RGT_ASSETS = window.RGT_ASSETS || "ro_assets/";
window.RGT_SOURCES = window.RGT_SOURCES || [];
(function () {
	const DIR = "/ro_assets/";
	const base = (rel) => {
		for (const [prefix, folder] of RGT_SOURCES) {
			if (rel.startsWith(prefix)) {
				return folder;
			}
		}
		return RGT_ASSETS;
	};
	const url = (rel) => base(rel) + rel.split("/").map(encodeURIComponent).join("/");
	// What was downloaded, for the console; with ?trace in the URL, rgtTrace lists each file the
	// game had to wait for.
	window.rgtStats = { now: 0, ahead: 0, cached: 0, warmed: 0, packs: 0, boot: 0, bytes: 0, ms_waiting: 0 };
	window.RGT_TRACE = window.RGT_TRACE || /[?&]trace\b/.test(location.search);
	window.rgtTrace = [];

	// The cache of this assets version (null until web.json says which, or without Cache Storage).
	let cache = Promise.resolve(null);
	const openCache = (version) => {
		if (!version || typeof caches === "undefined") {
			return;
		}
		const name = "rgt-" + version;
		cache = caches.open(name).catch(() => null);
		caches
			.keys()
			.then((keys) => keys.filter((k) => k.startsWith("rgt-") && k !== name).forEach((k) => caches.delete(k)))
			.catch(() => {});
	};
	// A file's bytes: from the cache, else downloaded (and cached). null if it isn't there.
	const bytesOf = async (rel) => {
		const where = url(rel);
		const store = await cache;
		if (store) {
			const hit = await store.match(where).catch(() => null);
			if (hit) {
				rgtStats.cached++;
				return new Uint8Array(await hit.arrayBuffer());
			}
		}
		const response = await fetch(where);
		if (!response.ok) {
			return null;
		}
		const buffer = await response.arrayBuffer();
		if (store) {
			store.put(where, new Response(buffer.slice(0))).catch(() => {});
		}
		rgtStats.bytes += buffer.byteLength;
		return new Uint8Array(buffer);
	};

	// One file, right now: the game waits for it. 1 if it was stored, 0 if not.
	window.rgtGet = function (rel) {
		const start = performance.now();
		const x = new XMLHttpRequest();
		x.open("GET", url(rel), false);
		x.overrideMimeType("text/plain; charset=x-user-defined"); // bytes, in a synchronous request
		try {
			x.send();
		} catch (e) {
			return 0;
		}
		if (x.status !== 200) {
			return 0;
		}
		const text = x.responseText;
		const bytes = new Uint8Array(text.length);
		for (let i = 0; i < text.length; i++) {
			bytes[i] = text.charCodeAt(i) & 0xff;
		}
		engine.copyToFS(DIR + rel, bytes);
		rgtStats.now++;
		rgtStats.bytes += bytes.length;
		rgtStats.ms_waiting += performance.now() - start;
		if (window.RGT_TRACE) {
			rgtTrace.push(rel);
		}
		return 1;
	};

	// Many files, in the background (a loading screen): a job id for rgtLeft. Many at once:
	// GitHub Pages speaks HTTP/2, so they share one connection.
	const jobs = {};
	let nextJob = 1;
	let busy = 0; // prefetch jobs not done (warming waits for them)
	window.rgtPrefetch = function (list) {
		const id = nextJob++;
		const queue = list.slice();
		jobs[id] = queue.length;
		if (queue.length > 0) {
			busy++;
		}
		const worker = async () => {
			for (let rel = queue.shift(); rel !== undefined; rel = queue.shift()) {
				try {
					const bytes = await bytesOf(rel);
					if (bytes) {
						engine.copyToFS(DIR + rel, bytes);
						rgtStats.ahead++;
					}
				} catch (e) {}
				if (--jobs[id] === 0) {
					busy--;
				}
			}
		};
		for (let i = 0; i < 24; i++) {
			worker();
		}
		return id;
	};

	// Files of a prefetch job still on their way.
	window.rgtLeft = (id) => jobs[id] || 0;
	// Prefetch jobs still going (for the console: how long a loading screen took).
	window.rgtBusy = () => busy;

	// Files the game will likely want soon (the next battles' maps, the town's other maps), into the
	// cache only (not memory), a few at a time and only while no prefetch is waited for.
	const warmQueue = [];
	const warmSeen = new Set();
	let warming = 0;
	const idle = () => new Promise((resolve) => setTimeout(resolve, 250));
	const warmer = async () => {
		warming++;
		while (warmQueue.length > 0) {
			if (busy > 0) {
				await idle();
				continue;
			}
			const rel = warmQueue.shift();
			try {
				const store = await cache;
				if (store && !(await store.match(url(rel)))) {
					await bytesOf(rel);
					rgtStats.warmed++;
				}
			} catch (e) {}
		}
		warming--;
	};
	window.rgtWarm = function (list) {
		for (const rel of list) {
			if (!warmSeen.has(rel)) {
				warmSeen.add(rel);
				warmQueue.push(rel);
			}
		}
		while (warming < 4 && warmQueue.length > 0) {
			warmer();
		}
		return warmQueue.length;
	};

	// Packs (tools/web/make_manifest.mjs), one after another in the background: each one many
	// small files in a single download, stored before the game asks for them.
	const loadPacks = async (names) => {
		for (const name of names) {
			try {
				const data = await bytesOf("packs/" + name + ".pack");
				if (!data) {
					continue;
				}
				const length = new DataView(data.buffer, data.byteOffset).getUint32(0, true);
				const header = JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + length)));
				let at = 4 + length;
				for (const [rel, size] of header) {
					engine.copyToFS(DIR + rel, data.slice(at, at + size));
					at += size;
				}
				rgtStats.packs++;
			} catch (e) {
				console.warn("rgt pack", name, e);
			}
		}
	};

	// Before the game starts: the files web.json lists under "boot", downloaded (or read from the
	// cache) along with the engine, so the title screen doesn't wait for them one by one; the
	// engine starts once they are in. Then the packs.
	document.addEventListener("DOMContentLoaded", () => {
		if (typeof engine === "undefined") {
			return;
		}
		const none = { version: "", boot: ["manifest.json"], packs: [] };
		const ready = fetch(url("web.json"), { cache: "no-cache" })
			.then((r) => (r.ok ? r.json() : none))
			.catch(() => none)
			.then((web) => {
				openCache(web.version);
				const load = (rel) =>
					bytesOf(rel).then((bytes) => (bytes ? engine.preloadFile(bytes, DIR + rel) : null));
				return Promise.allSettled(web.boot.map(load)).then(() => web);
			});
		const start = engine.start;
		engine.start = function (...args) {
			return ready.then((web) =>
				start.apply(this, args).then((result) => {
					rgtStats.boot = web.boot.length;
					loadPacks(web.packs);
					return result;
				}),
			);
		};
	});
})();
