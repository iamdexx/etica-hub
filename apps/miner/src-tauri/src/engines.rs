use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

pub const XMRIG_VERSION: &str = "6.26.0";
pub const LOLMINER_VERSION: &str = "1.98a";
pub const ETI_POOL: &str = "etipool.eticahub.com";
pub const EGAZ_POOL: &str = "pool.eticahub.com:8008";
const XMRIG_API_PORT: u16 = 44101;
const LOLMINER_API_PORT: u16 = 44102;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum EngineKind {
    Xmrig,
    LolMiner,
}

pub struct Engine {
    pub exe: PathBuf,
}

struct Release {
    url: String,
    sha256: String,
    exe_name: &'static str,
}

/// Pinned upstream releases with their published SHA-256 sums.
fn release(kind: EngineKind) -> Result<Release, String> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    match kind {
        EngineKind::Xmrig => {
            let (file, sha, exe) = match (os, arch) {
                ("windows", "x86_64") => (
                    format!("xmrig-{XMRIG_VERSION}-windows-x64.zip"),
                    "bba8097cb37d9b458a1cb1137876b27cde6740d17fe4ccbc086ba07d87d9e147",
                    "xmrig.exe",
                ),
                ("linux", "x86_64") => (
                    format!("xmrig-{XMRIG_VERSION}-linux-static-x64.tar.gz"),
                    "fc6f8ae5f64e4f17481f7e3be29a1c56949f216a998414188003eae1db20c9e5",
                    "xmrig",
                ),
                ("macos", "aarch64") => (
                    format!("xmrig-{XMRIG_VERSION}-macos-arm64.tar.gz"),
                    "6ae4eb4216e99a201ae9a3d2c3a7c275207c5165cfc25da1f3d735d6c4829c18",
                    "xmrig",
                ),
                ("macos", "x86_64") => (
                    format!("xmrig-{XMRIG_VERSION}-macos-x64.tar.gz"),
                    "1da924b358c0089e361540c4a9e6f8b09538b29efeafa2379590e0f6db358ff4",
                    "xmrig",
                ),
                _ => return Err(format!("No CPU miner build for {os}/{arch}")),
            };
            Ok(Release {
                url: format!(
                    "https://github.com/xmrig/xmrig/releases/download/v{XMRIG_VERSION}/{file}"
                ),
                sha256: sha.into(),
                exe_name: exe,
            })
        }
        EngineKind::LolMiner => {
            let (file, sha, exe) = match (os, arch) {
                ("windows", "x86_64") => (
                    format!("lolMiner_v{LOLMINER_VERSION}_Win64.zip"),
                    "f2bbda2d2255155d50935967b8c55105b9aeefbd27cda3e8d01beaf535a16762",
                    "lolMiner.exe",
                ),
                ("linux", "x86_64") => (
                    format!("lolMiner_v{LOLMINER_VERSION}_Lin64.tar.gz"),
                    "0b8078299654a12846e4967f1db3506409cfb8b1031687a910965d1a99c6f270",
                    "lolMiner",
                ),
                _ => return Err(format!("No GPU miner build for {os}/{arch}")),
            };
            Ok(Release {
                url: format!(
                    "https://github.com/Lolliedieb/lolMiner-releases/releases/download/{LOLMINER_VERSION}/{file}"
                ),
                sha256: sha.into(),
                exe_name: exe,
            })
        }
    }
}

fn find_file(root: &Path, name: &str) -> Option<PathBuf> {
    let rd = std::fs::read_dir(root).ok()?;
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            if let Some(f) = find_file(&p, name) {
                return Some(f);
            }
        } else if p.file_name().map(|n| n == name).unwrap_or(false) {
            return Some(p);
        }
    }
    None
}

impl Engine {
    /// Download (once), verify and unpack the pinned miner engine into `dir`.
    pub async fn ensure(app: &AppHandle, dir: &Path, kind: EngineKind) -> Result<Engine, String> {
        let rel = release(kind)?;
        let label = match kind {
            EngineKind::Xmrig => format!("xmrig-{XMRIG_VERSION}"),
            EngineKind::LolMiner => format!("lolminer-{LOLMINER_VERSION}"),
        };
        let target = dir.join(&label);
        if let Some(exe) = find_file(&target, rel.exe_name) {
            return Ok(Engine { exe });
        }
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let _ = app.emit("log", format!("Downloading {label}..."));
        let bytes = download(app, &rel.url).await?;
        let digest = hex::encode(Sha256::digest(&bytes));
        if digest != rel.sha256 {
            return Err(format!(
                "{label} download failed its checksum; not running it"
            ));
        }
        let tmp = dir.join(format!("{label}.part"));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        if rel.url.ends_with(".zip") {
            let mut z =
                zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
            z.extract(&tmp).map_err(|e| e.to_string())?;
        } else {
            let gz = flate2::read::GzDecoder::new(std::io::Cursor::new(bytes));
            tar::Archive::new(gz)
                .unpack(&tmp)
                .map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
        let exe = find_file(&target, rel.exe_name).ok_or("engine binary missing after unpack")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755));
        }
        let _ = app.emit("log", format!("{label} ready"));
        Ok(Engine { exe })
    }

    pub fn spawn_cpu(&self, wallet: &str, threads: usize, percent: u8) -> Result<Running, String> {
        // eticapool ports are starting-difficulty tiers; pick by thread count.
        let port = match threads {
            0..=4 => 3333,
            5..=12 => 5555,
            13..=32 => 7777,
            _ => 9999,
        };
        let use_threads = ((threads as u32 * percent as u32) / 100).max(1);
        let child = Command::new(&self.exe)
            .args([
                "-o",
                &format!("{ETI_POOL}:{port}"),
                "-u",
                &format!("{wallet}.eticahub-miner"),
                "-p",
                "x",
                "-a",
                "rx/0",
                "-k",
                "--no-color",
                "--threads",
                &use_threads.to_string(),
                "--http-host",
                "127.0.0.1",
                "--http-port",
                &XMRIG_API_PORT.to_string(),
                "--donate-level",
                "1",
            ])
            .current_dir(self.exe.parent().unwrap())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("could not start CPU miner: {e}"))?;
        Ok(Running::new(EngineKind::Xmrig, child))
    }

    pub fn spawn_gpu(&self, wallet: &str) -> Result<Running, String> {
        let child = Command::new(&self.exe)
            .args([
                "--algo",
                "ETCHASH",
                "--pool",
                EGAZ_POOL,
                "--user",
                &format!("{wallet}.eticahub-miner"),
                "--apihost",
                "127.0.0.1",
                "--apiport",
                &LOLMINER_API_PORT.to_string(),
                "--nocolor",
                "on",
            ])
            .current_dir(self.exe.parent().unwrap())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("could not start GPU miner: {e}"))?;
        Ok(Running::new(EngineKind::LolMiner, child))
    }
}

async fn download(app: &AppHandle, url: &str) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt;
    let resp = reqwest::Client::new()
        .get(url)
        .header("User-Agent", "EticaHub-Miner")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut out = Vec::with_capacity(total as usize);
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let c = chunk.map_err(|e| e.to_string())?;
        out.extend_from_slice(&c);
        if total > 0 {
            let _ = app.emit("progress", (out.len() as f64 / total as f64 * 100.0) as u8);
        }
    }
    let _ = app.emit("progress", 100u8);
    Ok(out)
}

pub struct Running {
    pub child: Child,
    pub log: Arc<Mutex<Vec<String>>>,
}

impl Running {
    fn new(kind: EngineKind, mut child: Child) -> Running {
        let log = Arc::new(Mutex::new(Vec::new()));
        let tag = match kind {
            EngineKind::Xmrig => "[eti] ",
            EngineKind::LolMiner => "[egaz] ",
        };
        for pipe in [
            child
                .stdout
                .take()
                .map(|s| Box::new(s) as Box<dyn Read + Send>),
            child
                .stderr
                .take()
                .map(|s| Box::new(s) as Box<dyn Read + Send>),
        ]
        .into_iter()
        .flatten()
        {
            let log = log.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(pipe);
                for line in reader.lines().map_while(Result::ok) {
                    let mut l = log.lock().unwrap();
                    l.push(format!("{tag}{line}"));
                    if l.len() > 300 {
                        l.remove(0);
                    }
                }
            });
        }
        Running { child, log }
    }

    fn take_logs(&self) -> Vec<String> {
        std::mem::take(&mut *self.log.lock().unwrap())
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Serialize, Default, Clone)]
pub struct Status {
    pub cpu_running: bool,
    pub gpu_running: bool,
    pub cpu_hashrate: f64,
    pub gpu_hashrate: f64,
    pub cpu_shares: u64,
    pub gpu_shares: u64,
    pub log: Vec<String>,
}

#[derive(Default)]
pub struct MinerState {
    pub cpu: Option<Running>,
    pub gpu: Option<Running>,
    pub log: Vec<String>,
}

#[derive(Deserialize)]
struct XmrigSummary {
    hashrate: XmrigHashrate,
    results: XmrigResults,
}
#[derive(Deserialize)]
struct XmrigHashrate {
    total: Vec<Option<f64>>,
}
#[derive(Deserialize)]
struct XmrigResults {
    shares_good: u64,
}

#[derive(Deserialize)]
struct LolSummary {
    #[serde(rename = "Algorithms")]
    algorithms: Vec<LolAlgo>,
}
#[derive(Deserialize)]
struct LolAlgo {
    #[serde(rename = "Total_Performance")]
    total_performance: f64,
    #[serde(rename = "Total_Accepted")]
    total_accepted: u64,
}

impl MinerState {
    pub fn stop_all(&mut self) {
        self.cpu = None; // Running kills its child on drop
        self.gpu = None;
    }

    pub async fn status(&mut self) -> Status {
        let mut s = Status::default();
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .unwrap();
        if let Some(r) = self.cpu.as_mut() {
            self.log.extend(r.take_logs());
            s.cpu_running = matches!(r.child.try_wait(), Ok(None));
            if let Ok(resp) = client
                .get(format!("http://127.0.0.1:{XMRIG_API_PORT}/2/summary"))
                .send()
                .await
            {
                if let Ok(j) = resp.json::<XmrigSummary>().await {
                    s.cpu_hashrate = j.hashrate.total.first().copied().flatten().unwrap_or(0.0);
                    s.cpu_shares = j.results.shares_good;
                }
            }
        }
        if let Some(r) = self.gpu.as_mut() {
            self.log.extend(r.take_logs());
            s.gpu_running = matches!(r.child.try_wait(), Ok(None));
            if let Ok(resp) = client
                .get(format!("http://127.0.0.1:{LOLMINER_API_PORT}/summary"))
                .send()
                .await
            {
                if let Ok(j) = resp.json::<LolSummary>().await {
                    if let Some(a) = j.algorithms.first() {
                        s.gpu_hashrate = a.total_performance; // MH/s for etchash
                        s.gpu_shares = a.total_accepted;
                    }
                }
            }
        }
        s.log = std::mem::take(&mut self.log); // only lines since the last poll
        s
    }
}
