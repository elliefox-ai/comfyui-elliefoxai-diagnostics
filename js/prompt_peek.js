/**
 * PromptPeek v1.7 — live prompt inspection on the node canvas
 *
 * Select, cycle (◀ ▶), or drop an image on the node: the prompt it was
 * generated with is parsed client-side from PNG tEXt chunks and drawn
 * directly on the node — no execution needed.
 *
 * v1.7 (2026-09-04): the panel's browser-side mirror resolved from the
 * `prompt` chunk only, so the panel still showed the one-behind sentence
 * even after the server-side v1.6 fix. The mirror now parses the `workflow`
 * chunk too and prefers display-node caches (ShowText and friends), same
 * rule as prompt_peek.py. Hard-refresh the browser; no server restart.
 *
 * v1.6 (2026-09-04): stale-prompt fix proper — the Python resolver now
 * prefers the UI `workflow` chunk's display cache (ShowText and friends)
 * over the queue-time `prompt` chunk. Pickers roll at EXECUTION, so the
 * prompt chunk freezes the PREVIOUS run's sentence, while the workflow
 * chunk records what THIS run displayed. Falls back to prompt-chunk values
 * when no display cache exists. Server-side change — needs a restart.
 *
 * v1.5 (2026-09-04): hit-tests compared node-local layout rects against
 * GRAPH coords (e.canvasX/Y) — offset by node.pos, so the copy button
 * (and scrollbar/page/wheel/hover) only worked with the node near the
 * canvas origin. All mouse handlers now convert to node-local first.
 * Also the true root of the v1.1 lockup: the unbounded track test
 * matched the entire node once pos.x > scrollbarX.
 *
 * v1.4 (2026-09-04): copy button now works on insecure origins (plain-http
 * http://IP:8188 has no navigator.clipboard — legacy textarea+execCommand
 * fallback) and flashes "copied ✓" / "copy failed" on the button so the
 * click visibly reacts.
 *
 * v1.3 (2026-09-04): display now reconciles against the widget value every
 * draw — combo changes that bypass (or precede) the callback used to leave
 * the panel showing the PREVIOUS image's prompt. Callback uses the new-value
 * argument directly as a second layer.
 *
 * v1.2 (2026-09-04): scrollbar hit-test bounded to the real track and a
 * window-level mouse-up backstop (a scroll-drag release that landed off-node
 * used to wedge all node input until reload/recreate); rendered state fully
 * reset on image change (header used to stick to the first image); drop
 * upload routed through the widget callback chain, plus a "loaded: filename"
 * readout on the copy row and a drop-target highlight.
 *
 * Layout (per Alexander): text on top, image preview at the bottom,
 * scales with node size, scrollbar when text overflows.
 */

import { app } from "../../../scripts/app.js";

console.log("[PromptPeek] v1.7 loading");

const NODE_TYPE = "PromptPeek";
const PAD = 10;
const LINE_H = 13;
const FONT = "11px monospace";
const HEADER_FONT = "bold 11px monospace";
const PREVIEW_MIN_H = 60;

// ─── PNG tEXt chunk parsing (client-side) ────────────────────────────────────

function parsePngTextChunks(buffer) {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    // PNG signature check
    if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
    let off = 8;
    const texts = {};
    const decoder = new TextDecoder("utf-8", { fatal: false });
    while (off + 8 <= bytes.length) {
        const len = view.getUint32(off);
        const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
        const dataStart = off + 8;
        if (type === "tEXt") {
            const data = bytes.subarray(dataStart, dataStart + len);
            const nul = data.indexOf(0);
            if (nul > 0) {
                const key = decoder.decode(data.subarray(0, nul));
                const val = decoder.decode(data.subarray(nul + 1));
                texts[key] = val;
            }
        } else if (type === "iTXt") {
            // Compressed iTXt unsupported; try uncompressed (compression flag = 0)
            const data = bytes.subarray(dataStart, dataStart + len);
            const nul = data.indexOf(0);
            if (nul > 0 && data[nul + 1] === 0) {
                const key = decoder.decode(data.subarray(0, nul));
                const val = decoder.decode(data.subarray(nul + 3)); // skip comp flag + method
                texts[key] = val;
            }
        } else if (type === "IEND") {
            break;
        }
        off = dataStart + len + 4; // skip CRC
    }
    return texts;
}

// ─── Prompt graph summarizer (mirrors prompt_peek.py) ───────────────────────

// Inputs whose values carry prompt text. Prefix match on purpose, so the
// numbered slots of composite prompt nodes (text_0, text_1, ...) and concat
// halves (string_a, string_b) all qualify. Mirrors prompt_peek.py.
const PREFERRED_TEXT_KEYS = ["text", "string", "prompt", "value"];
// Node classes that glue string pieces together: join their parts directly.
const CONCAT_HINTS = ["concat", "combine", "merge"];
// Node classes whose widget cache mirrors their executed output (display
// refresh nodes). Only these may substitute the workflow chunk's display
// cache for queue-time prompt-chunk literals — other text nodes' caches
// hold unrelated widget values that must not mask linked inputs.
const DISPLAY_HINTS = ["showtext", "show_text", "display", "textviewer"];
const MAX_RESOLVE_DEPTH = 12;

function isLink(v) {
    return Array.isArray(v) && v.length === 2;
}

function keyIsText(key) {
    return PREFERRED_TEXT_KEYS.some((p) => String(key).startsWith(p));
}

function resolveText(graph, ref, depth = 0, seen = new Set(), wfCache = null) {
    if (depth > MAX_RESOLVE_DEPTH || !isLink(ref)) return null;
    const node = graph[String(ref[0])];
    if (!node || typeof node !== "object" || seen.has(node)) return null;
    seen.add(node);
    const inputs = node.inputs || {};
    const ct = String(node.class_type || "").toLowerCase();
    const sep = CONCAT_HINTS.some((h) => ct.includes(h)) ? "" : " ";
    const pieces = [];
    for (const [key, val] of Object.entries(inputs)) {
        if (!keyIsText(key)) continue;
        if (typeof val === "string") {
            pieces.push(val);
        } else if (isLink(val)) {
            const sub = resolveText(graph, val, depth + 1, seen, wfCache);
            if (sub) pieces.push(sub);
        }
    }
    if (pieces.length) {
        // Display-class nodes refresh their widget from the execution event,
        // so the workflow chunk's cache holds what THIS run displayed while
        // the prompt chunk froze the PREVIOUS run's sentence. Only display
        // classes may short-circuit here (mirrors prompt_peek.py).
        const cached = wfCache ? wfCache[String(ref[0])] : "";
        if (cached && cached.trim() && DISPLAY_HINTS.some((h) => ct.includes(h))) {
            return cached.trim();
        }
        const joined = pieces.join(sep).trim();
        return joined || null;
    }
    const literals = Object.values(inputs).filter((v) => typeof v === "string");
    return literals.length ? literals.reduce((a, b) => (b.length > a.length ? b : a)) : null;
}

function summarizeGraph(graph, wfCache = null) {
    const meta = { positive: "", negative: "", model: "", loras: [], seed: "", steps: "", cfg: "", sampler: "" };
    let anchor = null; // KSampler-style inputs, or CFGGuider for advanced chains
    for (const id of Object.keys(graph)) {
        const node = graph[id];
        if (!node || typeof node !== "object") continue;
        const ct = String(node.class_type || "").toLowerCase();
        const inputs = node.inputs || {};
        if (!anchor && inputs.positive && (ct.includes("sampler") || ct.includes("guider"))) {
            anchor = inputs;
            meta.positive = resolveText(graph, inputs.positive, 0, new Set(), wfCache) || meta.positive;
            meta.negative = resolveText(graph, inputs.negative, 0, new Set(), wfCache) || meta.negative;
        }
        if (!meta.model) {
            for (const k of ["ckpt_name", "unet_name"]) {
                if (typeof inputs[k] === "string") { meta.model = inputs[k]; break; }
            }
        }
        if (typeof inputs.lora_name === "string") meta.loras.push(inputs.lora_name);
    }
    if (!meta.positive) {
        // Longest text-shaped input is the positive prompt
        for (const id of Object.keys(graph)) {
            const node = graph[id];
            const inputs = node && typeof node === "object" ? node.inputs || {} : {};
            for (const [key, val] of Object.entries(inputs)) {
                if (typeof val === "string" && keyIsText(key) && val.length > meta.positive.length) {
                    meta.positive = val;
                }
            }
        }
    }
    if (anchor) {
        meta.seed = String(anchor.seed ?? anchor.noise_seed ?? "");
        meta.steps = String(anchor.steps ?? "");
        meta.cfg = String(anchor.cfg ?? "");
        meta.sampler = String(anchor.sampler_name ?? "");
        // Advanced chains (CFGGuider + RandomNoise + scheduler) split the
        // sampler's fields across nodes — fill the gaps from wherever they live.
        if (!meta.seed || !meta.steps) {
            for (const id of Object.keys(graph)) {
                const node = graph[id];
                const inputs = node && typeof node === "object" ? node.inputs || {} : {};
                if (!meta.seed && typeof inputs.noise_seed === "number") meta.seed = String(inputs.noise_seed);
                if (!meta.steps && typeof inputs.steps === "number") meta.steps = String(inputs.steps);
            }
        }
    }
    return meta;
}

// Node-id → cached widget text from the UI `workflow` chunk (lines joined).
// Display widgets refresh from execution events, so their cache holds the
// text THIS run displayed — the prompt chunk froze at queue time, one roll
// behind on picker-driven graphs. Mirrors prompt_peek.py's
// _workflow_display_cache; subgraph-interior nodes aren't mapped and
// degrade gracefully to prompt-chunk values.
function workflowDisplayCache(workflowRaw) {
    if (!workflowRaw) return null;
    let wf;
    try { wf = JSON.parse(workflowRaw); } catch (_) { return null; }
    if (!wf || typeof wf !== "object" || !Array.isArray(wf.nodes)) return null;
    function collect(value, acc) {
        if (typeof value === "string") acc.push(value);
        else if (Array.isArray(value)) { for (const item of value) collect(item, acc); }
        else if (value && typeof value === "object") { for (const item of Object.values(value)) collect(item, acc); }
    }
    const cache = {};
    for (const node of wf.nodes) {
        if (!node || typeof node !== "object" || node.id == null) continue;
        if (!Array.isArray(node.widgets_values)) continue;
        const strings = [];
        collect(node.widgets_values, strings);
        if (strings.length) cache[String(node.id)] = strings.join("\n");
    }
    return cache;
}

function textsToInfo(texts) {
    if (!texts) return null;
    let meta = null;
    if (texts.prompt) {
        try {
            const graph = JSON.parse(texts.prompt);
            if (graph && typeof graph === "object") {
                meta = summarizeGraph(graph, workflowDisplayCache(texts.workflow));
            }
        } catch (_) { /* fall through */ }
    }
    if (!meta && texts.parameters) {
        meta = { positive: texts.parameters, negative: "", model: "", loras: [], seed: "", steps: "", cfg: "", sampler: "" };
    }
    return meta;
}

// ─── Fetch + cache ───────────────────────────────────────────────────────────

const metaCache = new Map();   // filename -> {meta, raw} | {meta:null}
const imgCache = new Map();    // filename -> HTMLImageElement

async function inspectImage(filename) {
    if (metaCache.has(filename)) return metaCache.get(filename);
    let entry = { meta: null, raw: "" };
    try {
        const resp = await fetch(`/view?filename=${encodeURIComponent(filename)}&type=input`);
        if (resp.ok) {
            const buf = await resp.arrayBuffer();
            const texts = parsePngTextChunks(buf);
            entry = { meta: textsToInfo(texts), raw: (texts && (texts.prompt || texts.parameters)) || "" };
        }
    } catch (e) {
        console.warn("[PromptPeek] fetch/parse failed for", filename, e);
    }
    metaCache.set(filename, entry);
    return entry;
}

function getImageEl(filename, cb) {
    if (imgCache.has(filename)) { cb(imgCache.get(filename)); return; }
    const img = new Image();
    img.onload = () => { imgCache.set(filename, img); cb(img); };
    img.onerror = () => cb(null);
    img.src = `/view?filename=${encodeURIComponent(filename)}&type=input`;
}

// ─── Text layout helpers ─────────────────────────────────────────────────────

function wrapText(ctx, text, maxWidth) {
    const lines = [];
    for (const para of String(text).split("\n")) {
        if (!para) { lines.push(""); continue; }
        let line = "";
        for (const word of para.split(/\s+/)) {
            const test = line ? line + " " + word : word;
            if (ctx.measureText(test).width > maxWidth && line) {
                lines.push(line);
                line = word;
            } else {
                line = test;
            }
        }
        lines.push(line);
    }
    return lines;
}

// ─── Extension ───────────────────────────────────────────────────────────────

app.registerExtension({
    name: "EllieFoxAI.PromptPeek",

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== NODE_TYPE) return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = origCreated?.apply(this, arguments);

            if (!this.properties) this.properties = {};
            this._ppScroll = 0;
            this._ppLines = [];
            this._ppMeta = null;
            this._ppHeaderLines = [];
            this._ppScrollDrag = false;
            this._ppCopyHover = false;
            this._ppInspected = null;      // filename currently shown
            this._ppDnDOver = false;
            this._ppLoading = false;

            // sensible default size — tall enough for header + text + preview
            this.size = [360, 480];

            // Suppress the stock widget image preview: the frontend sets
            // node.imgs on image_upload combos (drawn scaled to image aspect,
            // auto-grows the node). We render our own preview, so clear it
            // every frame (the frontend sets it async, post-callback) and
            // disable the aspect auto-resize.
            this.setSizeForImage = function () {};
            this.onDrawBackground = function (ctx) {
                if (this.imgs && this.imgs.length) this.imgs = null;
                if (this.imageIndex != null) this.imageIndex = null;
            };

            const imgWidget = this.widgets?.find((w) => w.name === "image");

            const refresh = (filename) => {
                if (!filename) return;
                this._ppInspected = filename;
                // reset ALL rendered state — a new image must never inherit
                // the previous one's header/body (v1.1 header stuck forever)
                this._ppMeta = null;
                this._ppHeaderLines = [];
                this._ppLines = [];
                this._ppWrapKey = null;
                this._ppScroll = 0;
                this._ppLoading = true;
                inspectImage(filename).then(({ meta }) => {
                    // ignore stale responses if the widget changed meanwhile
                    if (this._ppInspected !== filename) return;
                    this._ppMeta = meta;
                    this._ppLoading = false;
                    this.setDirtyCanvas(true, true);
                });
                getImageEl(filename, () => this.setDirtyCanvas(true, true));
                this.setDirtyCanvas(true, true);
            };

            // exposed for the draw-loop reconciler (see onDrawForeground)
            this._ppRefresh = refresh;
            this._ppImgWidget = imgWidget || null;

            // Backstop: clear scroll-drag on ANY window mouse/pointer-up. A
            // release off-node (mid-resize, drag-away) never reaches the
            // node's own onMouseUp — the stuck flag then ate every node
            // event until reload/recreate.
            this._ppWinUp = () => { this._ppScrollDrag = false; };
            window.addEventListener("mouseup", this._ppWinUp);
            window.addEventListener("pointerup", this._ppWinUp);

            if (imgWidget) {
                const origCb = imgWidget.callback;
                imgWidget.callback = (...args) => {
                    const r = origCb?.apply(imgWidget, args);
                    // use the new value from the callback args when the
                    // frontend fires the callback BEFORE assigning .value
                    const v = typeof args[0] === "string" ? args[0] : imgWidget.value;
                    refresh(v);
                    return r;
                };
                // Initial paint (deferred so widgets are populated)
                this._ppInitTimer = setTimeout(() => refresh(imgWidget.value), 100);
            }

            this.onRemoved = function () {
                clearTimeout(this._ppInitTimer);
                window.removeEventListener("mouseup", this._ppWinUp);
                window.removeEventListener("pointerup", this._ppWinUp);
            };

            return result;
        };

        // Layout regions (recomputed every draw)
        const regions = (node) => {
            const w = node.size[0];
            const h = node.size[1];
            // start below the image combo widget, not just below the title bar
            const lastW = node.widgets && node.widgets.length ? node.widgets[node.widgets.length - 1] : null;
            let top = 56; // static fallback: title bar (~26) + combo widget (~26)
            if (lastW && typeof lastW.y === "number" && lastW.y > 0) {
                top = lastW.y + (lastW.height || 26) + 8;
            }
            const copyBarH = 18;
            const textTop = top + 2;
            const headerH = node._ppHeaderLines ? node._ppHeaderLines.length * LINE_H + 6 : 0;
            const previewH = Math.max(PREVIEW_MIN_H, Math.min(h * 0.32, h - top - 140));
            const textAreaTop = textTop + copyBarH;
            const textAreaH = h - textAreaTop - previewH - PAD;
            return {
                w, h, top, textTop, copyBarH, headerH, previewH,
                textX: PAD, textAreaTop, textAreaH,
                textW: w - PAD * 2 - 8,       // room for scrollbar
                scrollbarX: w - PAD - 4,
                copyRect: [PAD, textTop, 90, copyBarH],
            };
        };

        // enforce a minimum size so the layout never collapses
        const origResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            const MIN_W = 320, MIN_H = 440;
            if (size) {
                if (size[0] < MIN_W) size[0] = MIN_W;
                if (size[1] < MIN_H) size[1] = MIN_H;
            }
            this.size[0] = Math.max(this.size[0], MIN_W);
            this.size[1] = Math.max(this.size[1], MIN_H);
            return origResize?.apply(this, arguments);
        };

        nodeType.prototype.onDrawForeground = function (ctx) {
            if (this.flags?.collapsed) return;
            // Reconciler: the display must ALWAYS converge to the widget's
            // current value, however the change happened — combo arrows,
            // dropdown, drop, or a callback that fired before .value was
            // assigned (that ordering is what made the panel show the
            // previous image's prompt). One string compare per draw.
            const w = this._ppImgWidget || this.widgets?.find((x) => x.name === "image");
            if (w?.value && w.value !== this._ppInspected) this._ppRefresh?.(w.value);

            const r = regions(this);

            // background panel
            ctx.fillStyle = "rgba(20,20,25,0.92)";
            ctx.fillRect(0, r.top, r.w, r.h - r.top);

            // drop-target highlight
            if (this._ppDnDOver) {
                ctx.strokeStyle = "rgba(138,180,248,0.9)";
                ctx.lineWidth = 2;
                ctx.strokeRect(1, r.top + 1, r.w - 2, r.h - r.top - 2);
                ctx.lineWidth = 1;
            }

            // copy button (flash feedback so the click visibly reacts)
            const [cx, cy, cw, ch] = r.copyRect;
            ctx.font = FONT;
            ctx.textBaseline = "middle";
            const flash = this._ppCopyFlash;
            if (flash && Date.now() - flash.t < 1500) {
                ctx.fillStyle = flash.ok ? "#81c995" : "#f28b82";
                ctx.fillText(flash.ok ? "⧉ copied ✓" : "⧉ copy failed", cx + 2, cy + ch / 2);
            } else {
                ctx.fillStyle = this._ppCopyHover ? "#8ab4f8" : "#9aa0a6";
                ctx.fillText("⧉ copy prompt", cx + 2, cy + ch / 2);
            }

            // loaded-file readout, right side of the copy row: mirrors the
            // widget value — what a queue run will actually serialize — so a
            // widget/display mismatch is visible at a glance.
            if (this._ppInspected) {
                ctx.fillStyle = "#7f8790";
                let label = "loaded: " + this._ppInspected;
                const maxW = r.w - PAD * 2 - 96;
                while (ctx.measureText(label).width > maxW && label.length > 4) {
                    label = "…" + label.slice(4);
                }
                ctx.fillText(label, r.w - PAD - ctx.measureText(label).width, cy + ch / 2);
            }

            if (!this._ppInspected) {
                ctx.fillStyle = "#9aa0a6";
                ctx.fillText("select / drop an image…", r.textX, r.textTop + r.copyBarH + 14);
                return;
            }

            const meta = this._ppMeta;
            // header: model · seed · steps · loras
            if (!this._ppLoading && this._ppHeaderLines.length === 0 && meta) {
                const bits = [];
                if (meta.model) bits.push(meta.model);
                if (meta.seed) bits.push(`seed ${meta.seed}`);
                if (meta.steps) bits.push(`${meta.steps} steps`);
                if (meta.sampler) bits.push(meta.sampler);
                if (meta.loras && meta.loras.length) bits.push(meta.loras.map((l) => l.replace(/^.*[\\/]/, "")).join(" + "));
                if (bits.length) this._ppHeaderLines = wrapText({ measureText: (t) => ctx.measureText(t) }, bits.join(" · "), r.textW);
            }
            if (this._ppHeaderLines.length) {
                ctx.font = HEADER_FONT;
                ctx.fillStyle = "#8ab4f8";
                let y = r.textAreaTop + LINE_H;
                for (const hl of this._ppHeaderLines) {
                    ctx.fillText(hl, r.textX, y);
                    y += LINE_H;
                }
                ctx.fillStyle = "rgba(138,180,248,0.25)";
                ctx.fillRect(r.textX, y + 2, r.textW, 1);
            }

            const bodyTop = r.textAreaTop + r.headerH;

            if (this._ppLoading) {
                ctx.font = FONT;
                ctx.fillStyle = "#9aa0a6";
                ctx.fillText("reading image…", r.textX, bodyTop + LINE_H);
            } else if (meta === null) {
                ctx.font = FONT;
                ctx.fillStyle = "#f28b82";
                ctx.fillText("(no prompt metadata found in PNG)", r.textX, bodyTop + LINE_H);
            } else if (meta) {
                // wrap lazily, cache per size
                const wrapKey = `${this._ppInspected}:${Math.round(r.textW)}`;
                if (this._ppWrapKey !== wrapKey) {
                    const lines = [];
                    if (meta.positive) {
                        ctx.font = FONT;
                        for (const l of wrapText(ctx, meta.positive, r.textW)) lines.push({ t: l, c: "#e8eaed" });
                    }
                    if (meta.negative && meta.negative.trim()) {
                        lines.push({ t: "", c: "#e8eaed" });
                        lines.push({ t: "— negative —", c: "#f28b82" });
                        for (const l of wrapText(ctx, meta.negative, r.textW)) lines.push({ t: l, c: "#f28b82" });
                    }
                    this._ppLines = lines;
                    this._ppWrapKey = wrapKey;
                }
                const total = this._ppLines.length;
                const visible = Math.max(0, Math.floor((r.textAreaH - r.headerH - 8) / LINE_H));
                const maxScroll = Math.max(0, total - visible);
                this._ppScroll = Math.min(this._ppScroll, maxScroll);
                ctx.font = FONT;
                ctx.textBaseline = "alphabetic";
                let y = bodyTop + LINE_H;
                const clipH = r.textAreaH - r.headerH;
                ctx.save();
                ctx.beginPath();
                ctx.rect(0, bodyTop, r.w, Math.max(0, clipH));
                ctx.clip();
                for (let i = this._ppScroll; i < Math.min(total, this._ppScroll + visible + 1); i++) {
                    ctx.fillStyle = this._ppLines[i].c;
                    ctx.fillText(this._ppLines[i].t, r.textX, y);
                    y += LINE_H;
                }
                ctx.restore();

                // scrollbar
                if (total > visible) {
                    const trackH = clipH - 4;
                    const thumbH = Math.max(18, (visible / total) * trackH);
                    const thumbY = bodyTop + 2 + (this._ppScroll / maxScroll) * (trackH - thumbH);
                    ctx.fillStyle = "rgba(255,255,255,0.12)";
                    ctx.fillRect(r.scrollbarX, bodyTop + 2, 4, trackH);
                    ctx.fillStyle = "rgba(255,255,255,0.45)";
                    ctx.fillRect(r.scrollbarX, thumbY, 4, thumbH);
                }
            }

            // image preview band at the bottom
            const pvTop = r.h - r.previewH;
            ctx.fillStyle = "rgba(0,0,0,0.35)";
            ctx.fillRect(0, pvTop, r.w, r.previewH);
            const img = imgCache.get(this._ppInspected);
            if (img && img.naturalWidth) {
                const maxW = r.w - PAD * 2;
                const maxH = r.previewH - PAD;
                const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
                const dw = img.naturalWidth * scale;
                const dh = img.naturalHeight * scale;
                ctx.drawImage(img, (r.w - dw) / 2, pvTop + (r.previewH - dh) / 2, dw, dh);
            } else {
                ctx.fillStyle = "#5f6368";
                ctx.font = FONT;
                ctx.fillText("(image preview)", PAD + 4, pvTop + r.previewH / 2);
            }
        };

        // ── interaction: scrollbar drag + copy ──
        const origMouseDown = nodeType.prototype.onMouseDown;
        nodeType.prototype.onMouseDown = function (e, ...rest) {
            const r = regions(this);
            // Hit-tests run in NODE-LOCAL coords: e.canvasX/Y are graph-world
            // coords (LiteGraph's adjustMouseEvent), so raw comparisons were
            // off by node.pos — fixed in v1.5.
            const lx = e.canvasX - this.pos[0];
            const ly = e.canvasY - this.pos[1];
            // copy button
            const [cx, cy, cw, ch] = r.copyRect;
            if (lx >= cx && lx <= cx + cw && ly >= cy && ly <= cy + ch) {
                const text = this._ppMeta?.positive;
                const nodeRef = this;
                const done = (ok) => {
                    nodeRef._ppCopyFlash = { t: Date.now(), ok };
                    if (ok) console.log("[PromptPeek] prompt copied to clipboard");
                    else console.warn("[PromptPeek] clipboard copy failed");
                };
                if (!text) {
                    done(false);
                } else if (navigator.clipboard && window.isSecureContext) {
                    navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
                } else {
                    // insecure context (plain http, e.g. the Tailscale IP):
                    // navigator.clipboard is undefined — fall back to a hidden
                    // textarea + the legacy execCommand copy.
                    try {
                        const ta = document.createElement("textarea");
                        ta.value = text;
                        ta.style.position = "fixed";
                        ta.style.left = "-9999px";
                        document.body.appendChild(ta);
                        ta.focus();
                        ta.select();
                        const ok = document.execCommand("copy");
                        document.body.removeChild(ta);
                        done(ok);
                    } catch (err) {
                        done(false);
                    }
                }
                return true;
            }
            const bodyTop = r.textAreaTop + r.headerH;
            const clipH = r.textAreaH - r.headerH;
            const total = this._ppLines.length;
            const visible = Math.max(1, Math.floor((clipH - 8) / LINE_H));
            const maxScroll = Math.max(0, total - visible);
            // scrollbar track/thumb — BOUNDED to the real track. The old test
            // ("right of X, anything below the header") reached the bottom
            // edge and swallowed resize-corner grabs; a release off-node then
            // stuck the drag flag and wedged the node.
            if (maxScroll > 0
                && lx >= r.scrollbarX - 6 && lx <= r.scrollbarX + 6
                && ly >= bodyTop && ly <= bodyTop + clipH) {
                this._ppScrollDrag = true;
                return true;
            }
            // wheel-less fallback: click inside the TEXT rect = page down.
            // Confined to the body (not preview band / copy row) and left of
            // the scrollbar — any other click falls through to normal node
            // interaction (drag, resize) instead of being swallowed.
            if (maxScroll > 0
                && lx >= 0 && lx <= r.scrollbarX - 6
                && ly >= bodyTop && ly <= r.h - r.previewH) {
                this._ppScroll = Math.min(maxScroll, this._ppScroll + visible);
                this.setDirtyCanvas(true, true);
                return true;
            }
            return origMouseDown?.apply(this, [e, ...rest]);
        };

        const origMouseMove = nodeType.prototype.onMouseMove;
        nodeType.prototype.onMouseMove = function (e, ...rest) {
            const r = regions(this);
            const lx = e.canvasX - this.pos[0];
            const ly = e.canvasY - this.pos[1];
            const [cx, cy, cw, ch] = r.copyRect;
            const hover = lx >= cx && lx <= cx + cw && ly >= cy && ly <= cy + ch;
            if (hover !== this._ppCopyHover) {
                this._ppCopyHover = hover;
                this.setDirtyCanvas(true, true);
            }
            if (this._ppScrollDrag) {
                const clipH = r.textAreaH - r.headerH;
                const total = this._ppLines.length;
                const visible = Math.max(1, Math.floor((clipH - 8) / LINE_H));
                const maxScroll = Math.max(0, total - visible);
                const frac = Math.min(1, Math.max(0, (ly - r.textAreaTop - r.headerH) / Math.max(1, clipH)));
                this._ppScroll = Math.round(frac * maxScroll);
                this.setDirtyCanvas(true, true);
                return true;
            }
            return origMouseMove?.apply(this, [e, ...rest]);
        };

        const origMouseUp = nodeType.prototype.onMouseUp;
        nodeType.prototype.onMouseUp = function (...args) {
            if (this._ppScrollDrag) {
                this._ppScrollDrag = false;
                return true;
            }
            return origMouseUp?.apply(this, args);
        };

        // wheel to scroll when hovering the text area
        const origOnWheel = nodeType.prototype.onWheel;
        nodeType.prototype.onWheel = function (e, ...rest) {
            const r = regions(this);
            const lx = e.canvasX - this.pos[0];
            const ly = e.canvasY - this.pos[1];
            if (lx >= 0 && lx <= r.w && ly >= r.textAreaTop && ly <= r.h - r.previewH) {
                const dir = e.deltaY > 0 ? 3 : -3;
                const visible = Math.max(1, Math.floor((r.textAreaH - r.headerH - 8) / LINE_H));
                const maxScroll = Math.max(0, this._ppLines.length - visible);
                this._ppScroll = Math.min(Math.max(0, maxScroll), Math.max(0, this._ppScroll + dir));
                this.setDirtyCanvas(true, true);
                return true;
            }
            return origOnWheel?.apply(this, [e, ...rest]);
        };

        console.log("[PromptPeek] node registered:", NODE_TYPE);
    },
});

// ─── Drag & drop (canvas-level, pattern from inpaint_painter) ───────────────

let dndAttached = false;

function canvasCoords(e) {
    if (app.canvas?.adjustMouseEvent) {
        try {
            app.canvas.adjustMouseEvent(e);
            if (e.canvasX !== undefined) return [e.canvasX, e.canvasY];
        } catch (_) {}
    }
    const el = app.canvas?.canvas || document.querySelector("#graph-canvas");
    if (!el) return [0, 0];
    const rect = el.getBoundingClientRect();
    return [(e.clientX - rect.left) / (app.canvas?.scale || 1), (e.clientY - rect.top) / (app.canvas?.scale || 1)];
}

function nodeAt(x, y) {
    for (const n of app.graph?._nodes || []) {
        if (n.type !== NODE_TYPE) continue;
        const [nx, ny] = n.pos;
        const [nw, nh] = n.size;
        if (x >= nx && x <= nx + nw && y >= ny && y <= ny + nh) return n;
    }
    return null;
}

async function uploadFile(file) {
    const fd = new FormData();
    fd.append("image", file);
    fd.append("type", "input");
    fd.append("overwrite", "false");
    const resp = await fetch("/upload/image", { method: "POST", body: fd });
    return resp.json();
}

function attachDnD() {
    if (dndAttached) return;
    const el = app.canvas?.canvas || document.querySelector("#graph-canvas");
    if (!el) { setTimeout(attachDnD, 500); return; }
    dndAttached = true;

    el.addEventListener("dragover", (e) => {
        if (!e.dataTransfer?.types?.includes("Files")) return;
        const [cx, cy] = canvasCoords(e);
        const node = nodeAt(cx, cy);
        if (node) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            if (!node._ppDnDOver) {
                node._ppDnDOver = true;
                node.setDirtyCanvas(true, true);
            }
            // only one node highlights at a time
            for (const n of app.graph?._nodes || []) {
                if (n !== node && n.type === NODE_TYPE && n._ppDnDOver) {
                    n._ppDnDOver = false;
                    n.setDirtyCanvas(true, true);
                }
            }
        }
    });

    el.addEventListener("dragleave", () => {
        // drag cancelled or left the canvas: clear any lingering highlight
        for (const n of app.graph?._nodes || []) {
            if (n.type === NODE_TYPE && n._ppDnDOver) {
                n._ppDnDOver = false;
                n.setDirtyCanvas(true, true);
            }
        }
    });

    el.addEventListener("drop", async (e) => {
        const [cx, cy] = canvasCoords(e);
        const node = nodeAt(cx, cy);
        if (!node) return;
        e.preventDefault();
        e.stopPropagation();
        node._ppDnDOver = false;
        const file = e.dataTransfer?.files?.[0];
        if (!file) return;
        try {
            const data = await uploadFile(file);
            if (data?.name) {
                const w = node.widgets?.find((x) => x.name === "image");
                if (w) {
                    // add to combo options if missing, then change the value
                    // through the widget's own callback chain — the same path
                    // as a manual combo selection — and mark the graph
                    // changed. A bare w.value assignment can lag the
                    // frontend's state by one change.
                    if (w.options?.values && !w.options.values.includes(data.name)) w.options.values.push(data.name);
                    w.value = data.name;
                    if (typeof w.callback === "function") w.callback(data.name);
                    app.graph.change?.();
                    node.setDirtyCanvas(true, true);
                }
            } else {
                console.warn("[PromptPeek] upload returned no filename:", data);
            }
        } catch (err) {
            console.error("[PromptPeek] drop upload failed:", err);
        }
    });
}

app.ui?.config?.addEventListener?.("loaded", attachDnD);
attachDnD();
