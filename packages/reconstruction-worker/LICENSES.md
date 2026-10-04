# Licence review — reconstruction worker

Required by the [#16](https://github.com/OxyHQ/GoWay/issues/16) licensing
gate: code licences and model/weight licences are reviewed **separately**, the
reviewed versions are pinned (`uv.lock`, and SHA-256 for every weight file in
`src/goway_reconstruction/models.py`), and attribution duties are recorded.
Nothing in this package is redistributed to end users. The worker runs it, and
publishes only Gaussian scenes it produced.

## Code

| Component | Version | Licence | Use | Notes |
| --- | --- | --- | --- | --- |
| PyTorch | 2.14.1 (cu130) | BSD-3-Clause (+ bundled permissive notices) | tensors, training | |
| torchvision | 0.29.1 (cu130) | BSD-3-Clause | Mask R-CNN architecture | weights reviewed below |
| gsplat | 1.5.3 | Apache-2.0 | Gaussian rasterization and densification | kernels compiled on the worker |
| pycolmap / COLMAP | 4.2.1 | BSD-3-Clause (“new BSD”) | features, matching, SfM | wheel bundles GCC runtime libraries (GPL with runtime exception) |
| OpenCV (headless) | 5.0 | Apache-2.0 | image ops, ONNX inference | wheel bundles LGPL FFmpeg, dynamically linked |
| PyAV | 19 | BSD-3-Clause | video decoding | wheel bundles LGPL FFmpeg and its codec libraries, dynamically linked |
| Pillow | 12 | MIT-CMU | JPEG decode/encode | |
| NumPy | 2 | BSD-3-Clause | | |
| boto3 / botocore | 1.43 | Apache-2.0 | S3, SQS | |
| pydantic | 2 | MIT | contract models | |
| nvidia-ml-py | 13 | BSD-3-Clause | read-only GPU health | |
| NVIDIA CUDA toolkit wheels (nvcc, runtime, headers) | 13.0 | NVIDIA CUDA EULA | compile and run gsplat kernels | installed from PyPI on the worker, not redistributed |
| SPZ format | — | MIT (Niantic Labs) | asset format | `recon/spz.py` is an independent implementation written from the MIT reference; notice retained in its docstring |

The worker never links GPL code into a distributed binary. The LGPL FFmpeg
libraries stay the separately replaceable shared objects their wheels ship.

## Model weights

| Model | File (SHA-256 pinned) | Weight licence | Training data | Assessment |
| --- | --- | --- | --- | --- |
| YuNet face detector | `face_detection_yunet_2023mar.onnx` | MIT (OpenCV Zoo) | WIDER FACE | Commercial use permitted. Used only to locate regions to destroy. |
| LPD-YuNet plate detector | `license_plate_detection_lpd_yunet_2023mar.onnx` | Apache-2.0 (OpenCV Zoo) | CCPD (Chinese plates) | Commercial use permitted. Recall on non-Chinese plates is limited, so plates are protected primarily by blurring and masking every detected vehicle whole. Post-processing follows the Apache-2.0 `lpd_yunet.py`, attributed in `privacy/detectors.py`. |
| Mask R-CNN ResNet-50-FPN v2 | `maskrcnn_resnet50_fpn_v2_coco-73cbd019.pth` | BSD-3-Clause (torchvision code); torchvision documents that pretrained weights may carry dataset terms | COCO 2017 (annotations CC BY 4.0; images under Flickr terms) | Acceptable for internal detection: weights are not redistributed and no COCO pixels reach any output. People and vehicles are only excluded, never learned. Revisit if weights are ever shipped to clients. |

No face recognition, plate reading (OCR) or identity model is used. Detectors
only decide which pixels to destroy and exclude.

## Data used for the pilot

The end-to-end pilot uses street imagery from Panoramax (IGN instance), licensed
under the French **Licence Ouverte / Open Licence 2.0 (etalab-2.0)**, which
permits commercial reuse with attribution. The attribution is carried into the
published scene manifest. No personal imagery is used for the pilot.

## Viewer (frontend, recorded here for the epic gate)

Spark (`@sparkjsdev/spark`) and three.js are MIT. They render the published SPZ
assets and use no model weights.
