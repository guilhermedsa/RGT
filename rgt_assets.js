window.RGT_SOURCES = [["world/","../RGT-mapas/"],["char/body_","../RGT-sprites1/"],["char/head_","../RGT-sprites1/"],["char/weapon_","../RGT-sprites1/"],["char/index","../RGT-sprites1/"],["char/hat_","../RGT-sprites2/"],["char/robe_","../RGT-sprites2/"]];
// Ragnarok Tactics on the web: where the converted RO files are (RGT_ASSETS, a folder URL ending in
// "/", ro_assets/ next to the page by default), and how they get into the game's file system.
// Assets.has_file() and Assets.prefetch() (scripts/autoload/assets.gd) call these through
// JavaScriptBridge; files land in /ro_assets/ of the engine's file system (engine.copyToFS).
// RGT_SOURCES ([[path prefix, folder URL]...], set before this script) sends some files elsewhere:
// the GitHub Pages build splits ro_assets across several sites (tools/web/make_pages.mjs).
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
	window.rgtStats = { now: 0, ahead: 0, bytes: 0, ms_waiting: 0 };
	window.RGT_TRACE = window.RGT_TRACE || /[?&]trace\b/.test(location.search);
	window.rgtTrace = [];

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

	// Many files, in the background (a loading screen): a job id for rgtLeft.
	const jobs = {};
	let nextJob = 1;
	window.rgtPrefetch = function (list) {
		const id = nextJob++;
		const queue = list.slice();
		jobs[id] = queue.length;
		const worker = () => {
			const rel = queue.shift();
			if (rel === undefined) {
				return Promise.resolve();
			}
			return fetch(url(rel))
				.then((r) => (r.ok ? r.arrayBuffer() : null))
				.then((buffer) => {
					if (buffer) {
						engine.copyToFS(DIR + rel, new Uint8Array(buffer));
						rgtStats.ahead++;
						rgtStats.bytes += buffer.byteLength;
					}
				})
				.catch(() => {})
				.then(() => {
					jobs[id]--;
					return worker();
				});
		};
		for (let i = 0; i < 12; i++) {
			worker();
		}
		return id;
	};

	// Files of a prefetch job still on their way.
	window.rgtLeft = (id) => jobs[id] || 0;
})();
