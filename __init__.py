from .prompt_peek import PromptPeek
from .diagnostics import VAERoundTrip, LatentBoundaryAnalyzer

NODE_CLASS_MAPPINGS = {
    "PromptPeek": PromptPeek,
    "VAERoundTrip": VAERoundTrip,
    "LatentBoundaryAnalyzer": LatentBoundaryAnalyzer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptPeek": "🔍 PromptPeek (image → prompt)",
    "VAERoundTrip": "🔧 VAE Round-Trip",
    "LatentBoundaryAnalyzer": "🔧 Latent Boundary Analyzer",
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
