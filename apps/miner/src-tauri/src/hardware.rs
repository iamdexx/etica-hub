use serde::Serialize;
use std::process::Command;

#[derive(Serialize, Clone)]
pub struct Hardware {
    pub cpu_name: String,
    pub cpu_threads: usize,
    pub ram_gb: u64,
    pub gpus: Vec<String>,
    pub gpu_supported: bool,
    pub os: String,
}

pub fn detect() -> Hardware {
    let mut sys = sysinfo::System::new();
    sys.refresh_cpu_all();
    sys.refresh_memory();
    let cpu_name = sys
        .cpus()
        .first()
        .map(|c| c.brand().trim().to_string())
        .unwrap_or_else(|| "CPU".into());
    let cpu_threads = sys.cpus().len().max(1);
    let ram_gb = sys.total_memory() / 1_073_741_824;
    let gpus = list_gpus();
    let gpu_supported = cfg!(any(target_os = "windows", target_os = "linux"))
        && gpus.iter().any(|g| {
            let l = g.to_lowercase();
            (l.contains("nvidia")
                || l.contains("geforce")
                || l.contains("rtx")
                || l.contains("gtx")
                || l.contains("radeon")
                || l.contains("amd")
                || l.contains("intel arc"))
                && !l.contains("virtio")
                && !l.contains("vmware")
                && !l.contains("llvmpipe")
        });
    Hardware {
        cpu_name,
        cpu_threads,
        ram_gb,
        gpus,
        gpu_supported,
        os: std::env::consts::OS.into(),
    }
}

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(cmd).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

fn list_gpus() -> Vec<String> {
    let mut gpus: Vec<String> = Vec::new();
    #[cfg(target_os = "windows")]
    {
        if let Some(o) = run(
            "powershell",
            &[
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
            ],
        ) {
            gpus.extend(
                o.lines()
                    .map(|l| l.trim().to_string())
                    .filter(|l| !l.is_empty()),
            );
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(o) = run("nvidia-smi", &["--query-gpu=name", "--format=csv,noheader"]) {
            gpus.extend(
                o.lines()
                    .map(|l| l.trim().to_string())
                    .filter(|l| !l.is_empty()),
            );
        }
        if let Some(o) = run("lspci", &[]) {
            gpus.extend(
                o.lines()
                    .filter(|l| {
                        l.contains("VGA")
                            || l.contains("3D controller")
                            || l.contains("Display controller")
                    })
                    .map(|l| l.splitn(2, ": ").nth(1).unwrap_or(l).to_string()),
            );
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(o) = run("system_profiler", &["SPDisplaysDataType"]) {
            gpus.extend(
                o.lines()
                    .filter(|l| l.trim_start().starts_with("Chipset Model:"))
                    .map(|l| l.split(':').nth(1).unwrap_or("").trim().to_string()),
            );
        }
    }
    gpus.sort();
    gpus.dedup();
    gpus
}
