/* NitroAI Tauri backend. The frontend holds the app logic; the native side owns
   the one thing the browser can't do securely: storing the BYO API key in the OS
   keychain (macOS Keychain / Windows Credential Manager / Secret Service). The
   web/dev build falls back to localStorage — see src/lib/engine/keys.ts. */

use base64::{engine::general_purpose, Engine as _};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use tauri::Manager;

const SERVICE: &str = "com.nitroai.app";
const ACCOUNT: &str = "api_key";

#[tauri::command]
fn save_api_key(key: String) -> Result<(), String> {
    keyring::Entry::new(SERVICE, ACCOUNT)
        .and_then(|e| e.set_password(&key))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn load_api_key() -> Result<String, String> {
    match keyring::Entry::new(SERVICE, ACCOUNT).and_then(|e| e.get_password()) {
        Ok(pw) => Ok(pw),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn clear_api_key() -> Result<(), String> {
    match keyring::Entry::new(SERVICE, ACCOUNT).and_then(|e| e.delete_credential()) {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/* YouTube import. YouTube's 2026 bot-gating makes browser caption fetches
   return empty, so the reliable free path is yt-dlp on the desktop: try captions
   first, fall back to extracting the audio (returned base64 for the frontend to
   transcribe with Whisper). yt-dlp must be installed / bundled. Audio is used
   transiently for transcription and not persisted. */

#[derive(serde::Serialize)]
struct YoutubeResult {
    transcript: Option<String>,
    #[serde(rename = "audioBase64")]
    audio_base64: Option<String>,
    #[serde(rename = "audioExt")]
    audio_ext: Option<String>,
    title: Option<String>,
}

fn ytdlp_asset() -> &'static str {
    if cfg!(target_os = "windows") {
        "yt-dlp.exe"
    } else if cfg!(target_os = "macos") {
        "yt-dlp_macos"
    } else {
        "yt-dlp"
    }
}

/* Ensure a yt-dlp binary exists, downloading the official standalone build into
   the app's data dir on first use so a non-technical user never has to install
   anything by hand. */
fn ensure_ytdlp(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("bin");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let bin = dir.join(if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" });
    if bin.exists() {
        return Ok(bin);
    }
    let url = format!(
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/{}",
        ytdlp_asset()
    );
    let bytes = reqwest::blocking::Client::builder()
        .user_agent("NitroAI")
        .build()
        .map_err(|e| e.to_string())?
        .get(&url)
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.bytes())
        .map_err(|e| format!("Couldn't download yt-dlp: {e}"))?;
    fs::write(&bin, &bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&bin).map_err(|e| e.to_string())?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&bin, perms).map_err(|e| e.to_string())?;
    }
    Ok(bin)
}

fn run_ytdlp(bin: &Path, args: &[&str]) -> Result<Output, String> {
    Command::new(bin)
        .args(args)
        .output()
        .map_err(|e| format!("Couldn't run yt-dlp ({e})."))
}

/* Strip WEBVTT timing/markup down to plain spoken text, de-duplicating the
   repeated rolling-caption lines auto-subs emit. */
fn vtt_to_text(vtt: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    for raw in vtt.lines() {
        let line = raw.trim();
        if line.is_empty()
            || line == "WEBVTT"
            || line.contains("-->")
            || line.starts_with("Kind:")
            || line.starts_with("Language:")
        {
            continue;
        }
        let mut s = String::new();
        let mut in_tag = false;
        for c in line.chars() {
            match c {
                '<' => in_tag = true,
                '>' => in_tag = false,
                _ if !in_tag => s.push(c),
                _ => {}
            }
        }
        let s = s.trim().to_string();
        if s.is_empty() || out.last().map(|l| l == &s).unwrap_or(false) {
            continue;
        }
        out.push(s);
    }
    out.join(" ")
}

#[tauri::command]
fn youtube_extract(app: tauri::AppHandle, url: String) -> Result<YoutubeResult, String> {
    let bin = ensure_ytdlp(&app)?;
    let dir = std::env::temp_dir().join(format!("nitroai-yt-{}", std::process::id()));
    let _ = fs::create_dir_all(&dir);
    let out_tmpl = dir.join("%(id)s.%(ext)s").to_string_lossy().to_string();

    let title = run_ytdlp(&bin, &["--no-warnings", "--print", "title", &url])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());

    // 1) captions (human + auto)
    let _ = run_ytdlp(&bin, &[
        "--no-warnings",
        "--skip-download",
        "--write-auto-sub",
        "--write-sub",
        "--sub-langs",
        "en.*",
        "--sub-format",
        "vtt",
        "-o",
        &out_tmpl,
        &url,
    ]);
    if let Ok(entries) = fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().map(|x| x == "vtt").unwrap_or(false) {
                if let Ok(vtt) = fs::read_to_string(&p) {
                    let text = vtt_to_text(&vtt);
                    if text.split_whitespace().count() > 5 {
                        let _ = fs::remove_dir_all(&dir);
                        return Ok(YoutubeResult {
                            transcript: Some(text),
                            audio_base64: None,
                            audio_ext: None,
                            title,
                        });
                    }
                }
            }
        }
    }

    // 2) audio fallback (native container; Whisper accepts m4a/webm/mp3/wav/ogg)
    let out = run_ytdlp(&bin, &["--no-warnings", "-f", "bestaudio", "-o", &out_tmpl, &url])?;
    if !out.status.success() {
        let _ = fs::remove_dir_all(&dir);
        return Err(format!(
            "yt-dlp failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let mut audio_path: Option<PathBuf> = None;
    if let Ok(entries) = fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("");
            if matches!(ext, "m4a" | "webm" | "mp3" | "opus" | "wav" | "mp4" | "aac" | "ogg") {
                audio_path = Some(p);
                break;
            }
        }
    }
    let path = audio_path.ok_or_else(|| "yt-dlp produced no audio file.".to_string())?;
    let ext = path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("m4a")
        .to_string();
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let b64 = general_purpose::STANDARD.encode(&bytes);
    let _ = fs::remove_dir_all(&dir);
    Ok(YoutubeResult {
        transcript: None,
        audio_base64: Some(b64),
        audio_ext: Some(ext),
        title,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            save_api_key,
            load_api_key,
            clear_api_key,
            youtube_extract
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
