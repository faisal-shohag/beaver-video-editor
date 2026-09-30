# Audio enhancer benchmark results

Machine: Ryzen 7 7700 (8C/16T), AMD Radeon iGPU (DirectML), 15 GB RAM. RTF = processing time ÷ audio duration (lower is faster; 0.05 = 20× faster than real time). Quality metrics are computed at 16 kHz. PESQ-WB (1–4.5), ESTOI (0–1) and SI-SDR (dB) compare against the clean reference; DNSMOS P.835 OVRL/SIG/BAK and P.808 (1–5) are reference-free MOS predictions.

## Speech + real noise (VoiceBank-DEMAND, 100 clips)

| Model | Group | PESQ | ESTOI | SI-SDR | OVRL | SIG | BAK | P.808 |
|---|---|---|---|---|---|---|---|---|
| *(unprocessed input)* | | 1.98 | 0.76 | 8.1 | 2.60 | 3.22 | 2.99 | 3.06 |
| *(clean reference)* | | 4.64 | 1.00 | 141.9 | 3.22 | 3.50 | 4.04 | 3.52 |
| VoiceFixer | reference | 2.41 | 0.75 | -2.8 | **3.19** | 3.46 | 4.05 | 3.38 |
| facebook/denoiser master64 | reference | 2.92 | 0.85 | 16.6 | **3.14** | 3.47 | 3.96 | 3.38 |
| Resemble Enhance (full) | reference | 2.25 | 0.75 | -6.4 | **3.14** | 3.45 | 3.98 | 3.55 |
| DeepFilterNet3 | shippable | 3.05 | 0.85 | 19.4 | **3.13** | 3.39 | 4.07 | 3.48 |
| MossFormer2-SE-48K (official PyTorch) | reference | 3.08 | 0.87 | 19.7 | **3.13** | 3.39 | 4.07 | 3.53 |
| MossFormer2-SE-48K (int8 ONNX) | shippable | 3.15 | 0.87 | 19.8 | **3.12** | 3.38 | 4.06 | 3.52 |
| Sidon (int8 ONNX) | shippable | 2.00 | 0.74 | -8.1 | **3.11** | 3.41 | 3.96 | 3.42 |
| Sidon — Rust port (in app) | port | 1.99 | 0.74 | -8.1 | **3.11** | 3.41 | 3.95 | 3.42 |
| DPDFNet-8 48k | shippable | 2.88 | 0.84 | 19.4 | **3.10** | 3.36 | 4.06 | 3.53 |
| DPDFNet-2 48k — Rust port (in app) | port | 2.99 | 0.85 | 19.3 | **3.09** | 3.36 | 4.04 | 3.52 |
| DPDFNet-2 48k | shippable | 2.99 | 0.85 | 19.3 | **3.09** | 3.36 | 4.04 | 3.52 |
| Resemble Enhance (denoise only) | reference | 2.77 | 0.85 | 12.7 | **3.09** | 3.40 | 3.98 | 3.51 |
| facebook/denoiser dns64 | reference | 2.51 | 0.83 | 17.9 | **3.04** | 3.32 | 4.00 | 3.37 |
| GTCRN | shippable | 2.55 | 0.80 | 14.6 | **2.87** | 3.21 | 3.84 | 3.37 |
| RNNoise (FFmpeg arnndn) | shippable | 2.29 | 0.79 | 4.9 | **2.81** | 3.33 | 3.44 | 3.18 |
| FFmpeg afftdn (classic DSP) | shippable | 2.14 | 0.75 | 6.0 | **2.66** | 3.27 | 3.10 | 3.11 |

## Old / low-quality recordings (60 clips: phone, MP3, reverb, clipping, hum, combo)

| Model | Group | PESQ | ESTOI | SI-SDR | OVRL | SIG | BAK | P.808 |
|---|---|---|---|---|---|---|---|---|
| *(unprocessed input)* | | 2.33 | 0.75 | 4.1 | 2.62 | 3.02 | 3.30 | 3.10 |
| *(clean reference)* | | 4.64 | 1.00 | 142.6 | 3.27 | 3.54 | 4.06 | 3.66 |
| Resemble Enhance (full) | reference | 2.15 | 0.57 | -11.4 | **3.25** | 3.51 | 4.08 | 3.70 |
| Sidon (int8 ONNX) | shippable | 1.96 | 0.78 | -9.3 | **3.20** | 3.49 | 4.01 | 3.56 |
| Sidon — Rust port (in app) | port | 1.96 | 0.78 | -9.4 | **3.20** | 3.48 | 4.00 | 3.56 |
| VoiceFixer | reference | 2.02 | 0.71 | -5.8 | **3.16** | 3.42 | 4.06 | 3.49 |
| facebook/denoiser dns64 | reference | 2.44 | 0.75 | 6.0 | **2.91** | 3.18 | 3.97 | 3.24 |
| MossFormer2-SE-48K (int8 ONNX) | shippable | 2.62 | 0.78 | 5.7 | **2.88** | 3.23 | 3.80 | 3.34 |
| GTCRN | shippable | 2.36 | 0.74 | 5.3 | **2.87** | 3.15 | 3.97 | 3.35 |
| DeepFilterNet3 | shippable | 2.31 | 0.73 | 5.6 | **2.87** | 3.17 | 3.90 | 3.33 |
| DPDFNet-8 48k | shippable | 2.19 | 0.70 | 4.0 | **2.86** | 3.15 | 4.04 | 3.28 |
| MossFormer2-SE-48K (official PyTorch) | reference | 2.57 | 0.78 | 5.7 | **2.86** | 3.22 | 3.77 | 3.32 |
| facebook/denoiser master64 | reference | 2.51 | 0.69 | 5.4 | **2.85** | 3.14 | 4.00 | 3.11 |
| DPDFNet-2 48k | shippable | 2.21 | 0.69 | 4.4 | **2.83** | 3.11 | 3.99 | 3.27 |
| DPDFNet-2 48k — Rust port (in app) | port | 2.21 | 0.69 | 4.4 | **2.83** | 3.11 | 3.99 | 3.27 |
| Resemble Enhance (denoise only) | reference | 2.55 | 0.77 | 6.1 | **2.81** | 3.14 | 3.68 | 3.26 |
| RNNoise (FFmpeg arnndn) | shippable | 2.44 | 0.75 | -0.9 | **2.78** | 3.12 | 3.69 | 3.20 |
| FFmpeg afftdn (classic DSP) | shippable | 2.38 | 0.74 | -0.2 | **2.63** | 3.02 | 3.36 | 3.17 |

### Degraded set by problem (DNSMOS OVRL / PESQ)

| Model | clipping | combo | hum_hiss | mp3_32k | phone | reverb |
|---|---|---|---|---|---|---|
| *(input)* | 2.99 / 2.35 | 1.55 / 1.32 | 2.92 / 1.66 | 3.24 / 3.59 | 3.22 / 3.89 | 1.81 / 1.17 |
| Resemble Enhance (full) | 3.19 / 2.51 | 3.24 / 1.24 | 3.26 / 2.50 | 3.28 / 2.70 | 3.20 / 2.75 | 3.29 / 1.19 |
| Sidon (int8 ONNX) | 3.11 / 2.30 | 3.23 / 1.49 | 3.15 / 2.01 | 3.19 / 2.26 | 3.16 / 2.02 | 3.38 / 1.66 |
| Sidon — Rust port (in app) | 3.09 / 2.25 | 3.25 / 1.49 | 3.13 / 2.03 | 3.18 / 2.26 | 3.16 / 2.03 | 3.38 / 1.70 |
| VoiceFixer | 3.02 / 2.00 | 3.15 / 1.47 | 3.25 / 2.30 | 3.22 / 2.25 | 3.14 / 2.51 | 3.17 / 1.56 |
| facebook/denoiser dns64 | 3.01 / 2.21 | 2.45 / 1.32 | 3.24 / 2.76 | 3.22 / 3.55 | 3.25 / 3.63 | 2.31 / 1.20 |
| MossFormer2-SE-48K (int8 ONNX) | 3.00 / 2.46 | 2.24 / 1.37 | 3.22 / 3.19 | 3.24 / 3.60 | 3.24 / 3.88 | 2.32 / 1.23 |
| GTCRN | 3.05 / 2.09 | 2.27 / 1.35 | 3.19 / 2.58 | 3.24 / 3.56 | 3.15 / 3.36 | 2.33 / 1.20 |
| DeepFilterNet3 | 3.06 / 2.43 | 2.26 / 1.42 | 3.27 / 3.20 | 3.26 / 3.04 | 3.08 / 2.56 | 2.27 / 1.22 |
| DPDFNet-8 48k | 3.15 / 2.12 | 1.91 / 1.07 | 3.24 / 3.09 | 3.27 / 2.67 | 2.96 / 2.90 | 2.62 / 1.27 |
| MossFormer2-SE-48K (official PyTorch) | 3.00 / 2.35 | 2.17 / 1.37 | 3.24 / 3.04 | 3.24 / 3.56 | 3.24 / 3.88 | 2.27 / 1.21 |
| facebook/denoiser master64 | 3.06 / 2.30 | 1.81 / 1.11 | 3.27 / 3.23 | 3.26 / 3.69 | 3.23 / 3.55 | 2.47 / 1.16 |
| DPDFNet-2 48k | 3.22 / 2.05 | 1.61 / 1.13 | 3.26 / 3.12 | 3.26 / 2.68 | 3.10 / 3.04 | 2.52 / 1.25 |
| DPDFNet-2 48k — Rust port (in app) | 3.22 / 2.05 | 1.61 / 1.13 | 3.26 / 3.12 | 3.26 / 2.68 | 3.10 / 3.04 | 2.52 / 1.25 |
| Resemble Enhance (denoise only) | 3.01 / 2.33 | 2.22 / 1.35 | 3.29 / 3.04 | 3.25 / 3.54 | 3.24 / 3.87 | 1.86 / 1.17 |
| RNNoise (FFmpeg arnndn) | 3.12 / 2.23 | 1.86 / 1.36 | 3.08 / 2.34 | 3.32 / 3.59 | 3.19 / 3.90 | 2.11 / 1.20 |
| FFmpeg afftdn (classic DSP) | 3.01 / 2.30 | 1.61 / 1.31 | 2.99 / 2.12 | 3.24 / 3.59 | 3.22 / 3.82 | 1.70 / 1.17 |

## Real-world recordings (DNS Challenge, no reference)

| Model | Group | PESQ | ESTOI | SI-SDR | OVRL | SIG | BAK | P.808 |
|---|---|---|---|---|---|---|---|---|
| *(unprocessed input)* | | – | – | – | 2.03 | 2.65 | 2.30 | 2.99 |
| Sidon (int8 ONNX) | shippable | – | – | – | **3.26** | 3.53 | 4.08 | 3.86 |
| Sidon — Rust port (in app) | port | – | – | – | **3.26** | 3.53 | 4.07 | 3.87 |
| Resemble Enhance (full) | reference | – | – | – | **3.16** | 3.45 | 4.04 | 3.89 |
| VoiceFixer | reference | – | – | – | **2.94** | 3.24 | 3.95 | 3.47 |
| MossFormer2-SE-48K (int8 ONNX) | shippable | – | – | – | **2.90** | 3.29 | 3.80 | 3.66 |
| facebook/denoiser master64 | reference | – | – | – | **2.88** | 3.13 | 4.04 | 3.53 |
| DPDFNet-8 48k | shippable | – | – | – | **2.88** | 3.12 | 4.08 | 3.64 |
| MossFormer2-SE-48K (official PyTorch) | reference | – | – | – | **2.87** | 3.26 | 3.80 | 3.64 |
| facebook/denoiser dns64 | reference | – | – | – | **2.85** | 3.11 | 4.00 | 3.46 |
| DPDFNet-2 48k — Rust port (in app) | port | – | – | – | **2.84** | 3.10 | 4.02 | 3.62 |
| DPDFNet-2 48k | shippable | – | – | – | **2.84** | 3.09 | 4.02 | 3.62 |
| Resemble Enhance (denoise only) | reference | – | – | – | **2.83** | 3.27 | 3.66 | 3.59 |
| DeepFilterNet3 | shippable | – | – | – | **2.79** | 3.11 | 3.89 | 3.56 |
| GTCRN | shippable | – | – | – | **2.61** | 2.98 | 3.72 | 3.49 |
| RNNoise (FFmpeg arnndn) | shippable | – | – | – | **2.43** | 3.02 | 3.13 | 3.18 |
| FFmpeg afftdn (classic DSP) | shippable | – | – | – | **2.09** | 2.75 | 2.42 | 3.07 |

## Speed & footprint (10-minute speech file)

| Model | Group | RTF all cores | RTF 1 thread | RTF DirectML | Peak RAM | Load | Model size | Band | Licence | Runtime |
|---|---|---|---|---|---|---|---|---|---|---|
| FFmpeg afftdn (classic DSP) | shippable | 0.002 | 0.002 | – | 518 MB | 0.0 s | 0 MB | 48k | LGPL/GPL (bundled FFmpeg) | FFmpeg sidecar (already bundled) |
| RNNoise (FFmpeg arnndn) | shippable | 0.005 | 0.005 | – | 533 MB | 0.0 s | 0.3 MB | 48k | BSD-3 (model) / FFmpeg | FFmpeg sidecar (already bundled) |
| DeepFilterNet3 | shippable | 0.039 | 0.040 | – | 471 MB | 0.0 s | 8 MB | 48k | MIT / Apache-2.0 | Rust (tract) — official deep-filter binary |
| GTCRN | shippable | 0.046 | 0.041 | – | 910 MB | 0.1 s | 0.5 MB | 16k | MIT | ONNX (streaming) |
| DPDFNet-2 48k | shippable | 0.113 | 0.111 | – | 1961 MB | 1.1 s | 10.5 MB | 48k | Apache-2.0 | ONNX (streaming) |
| DPDFNet-8 48k | shippable | 0.303 | 0.308 | – | 1978 MB | 0.8 s | 14.9 MB | 48k | Apache-2.0 | ONNX (streaming) |
| MossFormer2-SE-48K (int8 ONNX) | shippable | 0.107 | 0.254 | – | 1539 MB | 2.1 s | 94 MB | 48k | Apache-2.0 | ONNX (int8, 4 s windows) — features computed with torchaudio here; DirectML crashes on this int8 graph |
| Sidon (int8 ONNX) | shippable | 0.438 | 0.982 | 0.439 | 4138 MB | 11.8 s | 286 MB | 48k | MIT | ONNX (w2v-BERT predictor + DAC vocoder) |
| MossFormer2-SE-48K (official PyTorch) | reference | 0.149 | 0.479 | – | 1377 MB | 1.9 s | 221 MB | 48k | Apache-2.0 | PyTorch (ClearerVoice) |
| facebook/denoiser dns64 | reference | 0.061 | 0.167 | – | 1387 MB | 0.2 s | 128 MB | 16k | CC-BY-NC 4.0 (non-commercial) | PyTorch |
| facebook/denoiser master64 | reference | 0.052 | 0.160 | – | 1402 MB | 0.2 s | 128 MB | 16k | CC-BY-NC 4.0 (non-commercial) | PyTorch |
| Resemble Enhance (denoise only) | reference | 0.172 | 0.452 | – | 4001 MB | 7.4 s | 50 MB | 44.1k | MIT | PyTorch |
| Resemble Enhance (full) | reference | 3.631 | – | – | 9137 MB | 6.5 s | 360 MB | 44.1k | MIT | PyTorch — RTF from a 2-min clip; 9 GB peak RAM |
| VoiceFixer | reference | 0.422 | 1.219 | – | 4916 MB | 8.6 s | 490 MB | 44.1k | MIT | PyTorch — speed run partly overlapped a Rust compile (slightly pessimistic) |
| DPDFNet-2 48k — Rust port (in app) | port | 0.121 | – | – | – MB | 0.0 s | 10.5 MB | 48k | Apache-2.0 | Rust + ONNX Runtime (ort) |
| Sidon — Rust port (in app) | port | 0.438 | – | – | – MB | 0.0 s | 286 MB | 48k | MIT | Rust + ONNX Runtime (ort) |
| Adobe Podcast Enhance Speech | external | – | – | – | – MB | – s | 0 MB | 48k | Proprietary (cloud) | Web service, no API |
| Krisp | external | – | – | – | – MB | – s | 0 MB | 48k | Proprietary | Desktop app (live mic) |
| NVIDIA Broadcast / Maxine | external | – | – | – | – MB | – s | 0 MB | 48k | Proprietary (NVIDIA RTX only) | RTX GPU required — not runnable on this PC |
