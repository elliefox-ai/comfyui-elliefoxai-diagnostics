"""
PromptPeek — image loader with live prompt inspection.

Select, cycle, or drop an image; the JS extension reads its PNG metadata
client-side and renders the prompt text directly on the node — no execution
needed. Server side, this node behaves as a normal LoadImage-style
passthrough and also extracts prompt text / raw prompt JSON at run time.
"""

import json
import os

import numpy as np
import torch
from PIL import Image, ImageOps

import folder_paths
import node_helpers

# Inputs whose values carry prompt text. Prefix match on purpose, so the
# numbered slots of composite prompt nodes (text_0, text_1, ...) and concat
# halves (string_a, string_b) all qualify.
PREFERRED_TEXT_KEYS = ("text", "string", "prompt", "value")
# Node classes that glue string pieces together: join their parts directly.
CONCAT_HINTS = ("concat", "combine", "merge")
# Node classes whose widget cache mirrors their executed output (display
# refresh nodes). Only these may override prompt-chunk literals with their
# workflow-chunk cache: pickers roll at execution time, so the prompt chunk
# freezes the previous run's sentence while the workflow chunk records what
# THIS run displayed. Other text nodes' caches hold unrelated widget values
# (typed placeholders, delimiters) that must not mask linked inputs.
DISPLAY_HINTS = ("showtext", "show_text", "display", "textviewer")
MAX_RESOLVE_DEPTH = 12


def _is_link(v):
    """API-format link reference, e.g. [node_id, output_slot]."""
    return isinstance(v, (list, tuple)) and len(v) == 2


def _workflow_display_cache(workflow_raw):
    """Map UI-graph node ids to their cached widget text (lines joined).

    The `workflow` chunk is the frontend's canvas state saved with the
    image. Display widgets (ShowText and friends) refresh from execution
    events, so their cache holds the text THIS run actually displayed —
    unlike the `prompt` chunk, whose widget values froze at queue time
    (one roll behind on picker-driven graphs). Subgraph-interior nodes
    aren't mapped here; lookups degrade gracefully to prompt-chunk values.
    """
    try:
        wf = json.loads(workflow_raw) if isinstance(workflow_raw, str) else workflow_raw
    except (json.JSONDecodeError, TypeError):
        return {}
    if not isinstance(wf, dict):
        return {}

    def _collect(value, acc):
        if isinstance(value, str):
            acc.append(value)
        elif isinstance(value, (list, tuple)):
            for item in value:
                _collect(item, acc)
        elif isinstance(value, dict):
            for item in value.values():
                _collect(item, acc)

    cache = {}
    for node in wf.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        node_id = node.get("id")
        widgets = node.get("widgets_values")
        if node_id is None or not isinstance(widgets, list):
            continue
        strings = []
        _collect(widgets, strings)
        if strings:
            cache[str(node_id)] = "\n".join(strings)
    return cache


def _resolve_text(graph, ref, _depth=0, _seen=None, wf_cache=None):
    """Resolve a sampler positive/negative link to its prompt text.

    Prompts are rarely typed straight into a CLIPTextEncode anymore: they
    flow through scene-gen composites, string concat nodes, multiline-string
    helpers. Follow links recursively and collect every literal text piece
    found along the way, so a prompt assembled from numbered slots resolves
    to its full text.

    wf_cache (from _workflow_display_cache) supplies each node's display
    cache from the UI `workflow` chunk. Display-class nodes (ShowText and
    friends) may substitute their cache for their prompt-chunk literals:
    pickers roll at execution time, so the prompt chunk froze the PREVIOUS
    run's sentence, while the workflow chunk records what THIS run displayed.
    """
    if _depth > MAX_RESOLVE_DEPTH or not _is_link(ref):
        return None
    if _seen is None:
        _seen = set()
    node = graph.get(str(ref[0]), graph.get(ref[0]))
    if not isinstance(node, dict) or id(node) in _seen:
        return None
    _seen.add(id(node))
    inputs = node.get("inputs", {})
    if not isinstance(inputs, dict):
        return None
    class_type = str(node.get("class_type", "")).lower()
    sep = "" if any(h in class_type for h in CONCAT_HINTS) else " "
    pieces = []
    for key, val in inputs.items():
        if not str(key).startswith(PREFERRED_TEXT_KEYS):
            continue
        if isinstance(val, str):
            pieces.append(val)
        elif _is_link(val):
            sub = _resolve_text(graph, val, _depth + 1, _seen, wf_cache=wf_cache)
            if sub:
                pieces.append(sub)
    cached = wf_cache.get(str(ref[0]), "") if wf_cache else ""
    if pieces:
        if cached and cached.strip() and any(h in class_type for h in DISPLAY_HINTS):
            return cached.strip()
        joined = sep.join(pieces).strip()
        return joined or None
    # No text-shaped inputs at all: longest bare string literal as a guess.
    literals = [v for v in inputs.values() if isinstance(v, str)]
    return max(literals, key=len) if literals else None


def summarize_graph(graph, wf_cache=None):
    """Pull the interesting bits out of a ComfyUI prompt graph."""
    meta = {"positive": "", "negative": "", "model": "", "loras": []}
    anchor = None  # KSampler-style inputs, or CFGGuider for advanced chains
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs", {})
        if not isinstance(inputs, dict):
            continue
        ct = str(node.get("class_type", "")).lower()
        if anchor is None and "positive" in inputs and ("sampler" in ct or "guider" in ct):
            anchor = inputs
            meta["positive"] = _resolve_text(graph, inputs.get("positive"), wf_cache=wf_cache) or meta["positive"]
            meta["negative"] = _resolve_text(graph, inputs.get("negative"), wf_cache=wf_cache) or meta["negative"]
        if not meta["model"]:
            for k in ("ckpt_name", "unet_name"):
                if isinstance(inputs.get(k), str):
                    meta["model"] = inputs[k]
                    break
        if isinstance(inputs.get("lora_name"), str):
            meta["loras"].append(inputs["lora_name"])
    if not meta["positive"]:
        # Fallback heuristic: longest text-shaped input is the positive.
        longest = ""
        for node in graph.values():
            if not isinstance(node, dict):
                continue
            inputs = node.get("inputs", {})
            if not isinstance(inputs, dict):
                continue
            for key, val in inputs.items():
                if (isinstance(val, str) and str(key).startswith(PREFERRED_TEXT_KEYS)
                        and len(val) > len(longest)):
                    longest = val
        meta["positive"] = longest
    if anchor is not None:
        meta["seed"] = str(anchor.get("seed", anchor.get("noise_seed", "")))
        meta["steps"] = str(anchor.get("steps", ""))
        meta["cfg"] = str(anchor.get("cfg", ""))
        meta["sampler"] = str(anchor.get("sampler_name", ""))
        # Advanced chains (CFGGuider + RandomNoise + scheduler) split the
        # sampler's fields across nodes — fill the gaps from wherever they live.
        if not meta["seed"] or not meta["steps"]:
            for node in graph.values():
                if not isinstance(node, dict):
                    continue
                inputs = node.get("inputs", {})
                if not isinstance(inputs, dict):
                    continue
                if not meta["seed"] and isinstance(inputs.get("noise_seed"), (int, float)):
                    meta["seed"] = str(inputs["noise_seed"])
                if not meta["steps"] and isinstance(inputs.get("steps"), (int, float)):
                    meta["steps"] = str(inputs["steps"])
    return meta


def extract_prompt_info(png_path):
    """Extract ComfyUI (or A1111) prompt metadata from a PNG file."""
    img = node_helpers.pillow(Image.open, png_path)
    raw = img.info or {}

    prompt_json = raw.get("prompt", "")
    workflow_raw = raw.get("workflow", "")
    wf_cache = _workflow_display_cache(workflow_raw) if workflow_raw else {}
    params = raw.get("parameters", "")  # A1111-style fallback

    text = ""
    if prompt_json:
        try:
            graph = json.loads(prompt_json)
            if isinstance(graph, dict):
                text = summarize_graph(graph, wf_cache=wf_cache).get("positive", "")
        except (json.JSONDecodeError, TypeError):
            pass
    if not text and params:
        text = params
    return text, prompt_json or params


class PromptPeek:
    @classmethod
    def INPUT_TYPES(cls):
        input_dir = folder_paths.get_input_directory()
        files = [f for f in os.listdir(input_dir) if os.path.isfile(os.path.join(input_dir, f))]
        files = folder_paths.filter_files_content_types(files, ["image"])
        return {
            "required": {
                "image": (sorted(files), {
                    "image_upload": True,
                    "tooltip": "Image to inspect. Drop a file onto the node, upload, or cycle the input folder. The prompt it was generated with is shown live on the node.",
                }),
            }
        }

    RETURN_TYPES = ("IMAGE", "STRING", "STRING")
    RETURN_NAMES = ("image", "prompt_text", "prompt_json")
    FUNCTION = "load"
    CATEGORY = "EllieFoxAI"

    def load(self, image):
        path = folder_paths.get_annotated_filepath(image)
        img = node_helpers.pillow(Image.open, path)
        img = node_helpers.pillow(ImageOps.exif_transpose, img)
        img = img.convert("RGB")
        tensor = torch.from_numpy(np.array(img).astype(np.float32) / 255.0)[None,]
        text, raw = extract_prompt_info(path)
        return (tensor, text, raw)

    @classmethod
    def VALIDATE_INPUTS(cls, image):
        if not folder_paths.exists_annotated_filepath(image):
            return f"Invalid image file: {image}"
        return True

    @classmethod
    def IS_CHANGED(cls, image):
        return os.path.getmtime(folder_paths.get_annotated_filepath(image))
