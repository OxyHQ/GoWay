"""GoWay Street 3D reconstruction worker."""

__version__ = "0.1.0"

# Recorded in every result. Bump when a change can alter what a pipeline
# produces from the same inputs, so scenes and derivatives stay attributable.
# /3: blur and exclusion separated (outlines, heads and plate bands instead of
# whole vehicle boxes), an upper ring of panorama views with stated pitch,
# keyframes over a video's whole length, sRGB colour, q95 4:4:4 derivatives.
PRIVACY_PIPELINE_VERSION = "goway-privacy/3"
RECONSTRUCTION_PIPELINE_VERSION = "goway-reconstruction/2"
