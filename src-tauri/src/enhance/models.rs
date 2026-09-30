//! Enhancement model registry and on-demand downloads (pinned revisions, SHA-256 verified).
use crate::jobs::{self, JobHandle, Jobs, Reporter};
use crate::model::EnhanceModel;
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct ModelFile {
    pub rel: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
}

pub struct ModelSpec {
    pub id: EnhanceModel,
    /// Files to download; empty = bundled with the app.
    pub files: &'static [ModelFile],
    /// Real-time factor measured in bench/audio-enhance (for ETA).
    pub rtf: f64,
}

pub const MODELS: &[ModelSpec] = &[
    ModelSpec { id: EnhanceModel::Dfn3, files: &[], rtf: 0.045 },
    ModelSpec {
        id: EnhanceModel::Dpdfnet2,
        files: &[ModelFile {
            rel: "dpdfnet2/dpdfnet2_48khz_hr.onnx",
            url: "https://huggingface.co/Ceva-IP/DPDFNet/resolve/dd6818d00f50c836fed43a6243ebe49116de5964/onnx/dpdfnet2_48khz_hr.onnx",
            sha256: "7f0575a5cec0ba4ffd8f8bd657e06d007e4ccdd955d76faab922b9d3291dc14b",
            bytes: 10_493_337,
        }],
        rtf: 0.12,
    },
    ModelSpec {
        id: EnhanceModel::Sidon,
        files: &[
            ModelFile {
                rel: "sidon/sidon-predictor.onnx",
                url: "https://huggingface.co/soniqo/Sidon-ONNX/resolve/a6dce244cbcd0361ef79c030e246e6f9671770c1/int8/sidon-predictor.onnx",
                sha256: "ff50dc41f309903ac5dc071afb969a3f950b15e77f7e226222fd0011e76910c7",
                bytes: 195_258_154,
            },
            ModelFile {
                rel: "sidon/sidon-vocoder.onnx",
                url: "https://huggingface.co/soniqo/Sidon-ONNX/resolve/a6dce244cbcd0361ef79c030e246e6f9671770c1/int8/sidon-vocoder.onnx",
                sha256: "b2598f7fae8913ee42a4ddedc4bb50ccd76f15546ec1f93520c19187f4a33644",
                bytes: 105_055_596,
            },
        ],
        rtf: 0.46,
    },
];

pub fn spec(id: EnhanceModel) -> &'static ModelSpec {
    MODELS.iter().find(|m| m.id == id).expect("model in registry")
}

pub fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?.join("models");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

pub fn file_path(app: &AppHandle, f: &ModelFile) -> Result<PathBuf, String> {
    Ok(models_dir(app)?.join(f.rel))
}

pub fn installed(app: &AppHandle, s: &ModelSpec) -> bool {
    if s.id == EnhanceModel::Dfn3 {
        return super::dfn3::binary().exists();
    }
    s.files.iter().all(|f| {
        file_path(app, f).ok().and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len() == f.bytes).unwrap_or(false)
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    id: EnhanceModel,
    installed: bool,
    download_bytes: u64,
    rtf: f64,
}

#[tauri::command]
pub fn enhance_models(app: AppHandle) -> Vec<ModelStatus> {
    MODELS
        .iter()
        .map(|s| ModelStatus {
            id: s.id,
            installed: installed(&app, s),
            download_bytes: s.files.iter().map(|f| f.bytes).sum(),
            rtf: s.rtf,
        })
        .collect()
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Stream `url` to `dest` (via `.part`), verifying size and SHA-256.
pub fn download_file(f: &ModelFile, dest: &Path, job: &JobHandle, mut on_bytes: impl FnMut(u64)) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let part = dest.with_extension("part");
    let result = (|| {
        let client = reqwest::blocking::Client::builder()
            .timeout(None)
            .user_agent("beaver-video-editor")
            .build()
            .map_err(|e| e.to_string())?;
        let mut resp = client.get(f.url).send().and_then(|r| r.error_for_status()).map_err(|e| e.to_string())?;
        let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1 << 16];
        let mut total = 0u64;
        loop {
            job.check()?;
            let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            total += n as u64;
            on_bytes(n as u64);
        }
        file.flush().map_err(|e| e.to_string())?;
        verify(total, &hex(&hasher.finalize()), f)
    })();
    match result {
        Ok(()) => std::fs::rename(&part, dest).map_err(|e| e.to_string()),
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

fn verify(total: u64, sha: &str, f: &ModelFile) -> Result<(), String> {
    if total != f.bytes {
        return Err(format!("Download incomplete ({total} of {} bytes)", f.bytes));
    }
    if sha != f.sha256 {
        return Err("Downloaded model failed its integrity check (SHA-256 mismatch)".into());
    }
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadDone {
    job_id: String,
    model: EnhanceModel,
    ok: bool,
    cancelled: bool,
    error: Option<String>,
}

#[tauri::command]
pub fn download_model(
    app: AppHandle,
    state: State<'_, Jobs>,
    job_id: String,
    model: EnhanceModel,
) -> Result<(), String> {
    let job = state.register(&job_id);
    std::thread::spawn(move || {
        let rep = Reporter::new(&app, "model", &job_id);
        let s = spec(model);
        let total: u64 = s.files.iter().map(|f| f.bytes).sum::<u64>().max(1);
        let mut done = 0u64;
        let result = (|| {
            for f in s.files {
                let dest = file_path(&app, f)?;
                if std::fs::metadata(&dest).map(|m| m.len() == f.bytes).unwrap_or(false) {
                    done += f.bytes;
                    continue;
                }
                download_file(f, &dest, &job, |n| {
                    done += n;
                    rep.stage(done as f64 / total as f64, "Downloading model");
                })?;
            }
            Ok::<(), String>(())
        })();
        let cancelled = matches!(&result, Err(e) if e == "cancelled");
        let _ = app.emit(
            "model://done",
            DownloadDone {
                job_id: job_id.clone(),
                model,
                ok: result.is_ok(),
                cancelled,
                error: result.err().filter(|_| !cancelled),
            },
        );
        jobs::unregister(&app, &job_id);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_rejects_bad_hash_and_size() {
        let f = ModelFile { rel: "x", url: "", sha256: "abc", bytes: 3 };
        assert!(verify(3, "abc", &f).is_ok());
        assert!(verify(2, "abc", &f).unwrap_err().contains("incomplete"));
        assert!(verify(3, "abd", &f).unwrap_err().contains("SHA-256"));
    }

    #[test]
    fn hex_encodes() {
        assert_eq!(hex(&[0, 15, 255]), "000fff");
    }
}
