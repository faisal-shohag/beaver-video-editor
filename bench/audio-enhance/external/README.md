# Manual tools (Adobe Podcast, Krisp, NVIDIA Broadcast)

These tools can't be scripted (cloud-only, live-mic-only, or hardware-locked), so they're compared on a 12-clip pack built by `prepare_data.py`: `external/input/*.wav` has 4 speech+noise clips, 4 degraded and 4 real recordings.

## Adobe Podcast Enhance Speech
1. Open https://podcast.adobe.com/enhance (free Adobe account).
2. Upload the 12 files from `external/input/`, keeping the settings at their defaults.
3. Download all results into a single folder.
4. `envs/onnx/Scripts/python import_external.py adobe <that folder>`
5. `envs/onnx/Scripts/python score.py`

## Krisp (optional)
Krisp only processes a live microphone. With Krisp and VB-Cable installed, set Krisp's microphone to *CABLE Output* and play each pack file into *CABLE Input* while recording the "Krisp Microphone" device. Save the recordings with the same names, then run `import_external.py krisp <folder>`.

## NVIDIA Broadcast / Maxine
Needs an NVIDIA RTX GPU, so it isn't measured on the reference machine. On an RTX PC, use NVIDIA Broadcast's file processing (or the Maxine AFX SDK sample) on the pack, then import the results with `import_external.py nvidia_broadcast <folder>`.
