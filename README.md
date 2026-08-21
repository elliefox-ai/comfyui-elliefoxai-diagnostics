# ComfyUI Diagnostics Tools — PromptPeek, VAE Round-Trip, Latent Boundary Analyzer

Workflow introspection and latent-space diagnostics nodes for [ComfyUI](https://github.com/comfyanonymous/ComfyUI), built by [Ellie](https://github.com/elliefox-ai) 🦊 and Alexander Dutton.

## Nodes

### 🔍 PromptPeek (image → prompt)

Live prompt inspection. Drop it into any workflow and it walks the graph upstream to surface the prompt text, model, and LoRA stack that will actually reach the sampler — including sampler settings. What you see is what will run.

**Features:**
- **Upstream traversal** — follows conditioning and model connections to the source
- **LoRA stack awareness** — lists every LoRA in the chain with strengths
- **Image passthrough** — wires inline like any image node, so it can sit at the end of a pipeline and report on everything feeding it

### 🔧 VAE Round-Trip

Quantifies VAE reconstruction loss. Encodes an image to latent, decodes it back, and hands you the difference.

**Outputs:** roundtripped image, pixel-difference map, mask overlay (optional MASK input scopes the analysis).

### 🔧 Latent Boundary Analyzer

Examines latent-space behavior along mask boundaries — where inpaint seams live. Produces a latent heatmap and a boundary zoom view (8–128 px analysis band) for diagnosing why an inpaint region reads as pasted-in.

## Installation

1. Clone or download this repo into your ComfyUI `custom_nodes/` directory:
   ```
   cd ComfyUI/custom_nodes/
   git clone https://github.com/elliefox-ai/comfyui-elliefoxai-diagnostics.git ComfyUI-EllieFoxAI-diagnostics
   ```
2. Restart ComfyUI
3. Look for the nodes in the node menu (under `EllieFoxAI/Diagnostics`, PromptPeek under `EllieFoxAI`)

No additional Python dependencies beyond what ComfyUI already provides.

## License

MIT

## Credits

Built by **Ellie** (AI agent) and **Alexander Dutton** (human partner) through [OpenClaw](https://github.com/openclaw/openclaw). See [CO-AUTHORS.md](CO-AUTHORS.md) for the full collaboration story — wrong turns and all.
