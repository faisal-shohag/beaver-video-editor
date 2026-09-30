# Audio enhancer benchmark

This benchmark compares speech enhancement and restoration models to decide what Beaver ships for "Enhance voice". Results are in [`results.md`](results.md). A listening page is generated at `listen.html`; open it locally after a run.

Nothing here ships with the app. The Python environments exist only to measure the models.

## Models

- **Shippable** (no Python needed at runtime):
  - FFmpeg `afftdn`
  - RNNoise (FFmpeg `arnndn`)
  - DeepFilterNet3
  - GTCRN
  - DPDFNet-2 and DPDFNet-8 (48 kHz)
  - MossFormer2-SE-48K (int8 ONNX)
  - Sidon (int8 ONNX)
- **Reference** (quality ceiling; each has a shipping catch):
  - MossFormer2 (PyTorch)
  - facebook/denoiser dns64 and master64: non-commercial licence
  - Resemble Enhance, denoise-only and full modes
  - VoiceFixer
- **External** (manual, see [`external/README.md`](external/README.md)):
  - Adobe Podcast
  - Krisp
  - NVIDIA Broadcast

Details (licence, size, runtime) are in [`registry.py`](registry.py).

## Test data

| Set | Clips | Has clean reference | Source |
|---|---|---|---|
| `vbd` | 100 | ✓ | VoiceBank-DEMAND test (CC-BY-4.0) |
| `degraded` | 60 | ✓ | VCTK clean speech degraded with: phone band, 32 kbps MP3, reverb (RT60 0.7 s), clipping, hum+hiss, and a combo (reverb + noise + phone) |
| `real` | 11 | – | DNS Challenge real recordings |
| `speed` | 1 × 10 min | – | Concatenated noisy speech, used for RTF and RAM |

## Reproduce (Windows)

```powershell
py -m pip install uv
# Download VoiceBank-DEMAND test (clean_testset_wav.zip, noisy_testset_wav.zip) into data/ and unzip,
# and the DNS real recordings listed in data/real_picks.txt into data/real_raw/ (see git history for URLs)
uv venv envs/onnx --python 3.12
uv pip install --python envs/onnx/Scripts/python.exe onnxruntime-directml numpy soundfile soxr pesq pystoi psutil scipy librosa dpdfnet transformers
uv venv envs/torch --python 3.11          # torch torchaudio (CPU), denoiser, clearvoice, onnxruntime-directml,
                                          # resemble-enhance --no-deps + omegaconf==2.3.0 resampy tabulate rich celluloid ptflops
uv venv envs/voicefixer --python 3.9      # torch (CPU), voicefixer
envs/onnx/Scripts/python prepare_data.py
envs/onnx/Scripts/python run.py           # all models x all sets (+ 1-thread and DirectML speed runs)
envs/onnx/Scripts/python score.py         # writes results.md, results.json, listen.html
```

Model files go into `models/` (the download URLs are in the adapters and in the git history of this folder).

## Metrics

- **PESQ-WB, ESTOI, SI-SDR:** compare against the clean reference at 16 kHz. Before scoring, up to 50 ms of constant model latency is compensated by cross-correlation.
- **DNSMOS P.835 (SIG/BAK/OVRL) and P.808:** Microsoft's reference-free MOS predictors, run through their official ONNX models.
- **Generative models (Sidon, Resemble Enhance, VoiceFixer):** these re-synthesise the waveform, so PESQ and SI-SDR punish them even when they sound clean. Judge them on DNSMOS and on listening.
- **RTF:** processing time ÷ audio duration, on the 10-minute file. *model* RTF counts only inference time; the plain figure includes Python overhead, and streaming models run a Python loop per frame, so in-app Rust would be faster.
