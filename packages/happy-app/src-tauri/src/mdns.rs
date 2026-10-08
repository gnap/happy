use std::collections::HashMap;
use std::time::{Duration, Instant};

use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::Serialize;

/// One resolved service. The fields mirror what `ZeroconfService` carries on the native path so
/// the App's discovery filter and everything downstream run unchanged on desktop.
#[derive(Serialize)]
pub struct MdnsService {
    name: String,
    host: Option<String>,
    port: u16,
    addresses: Vec<String>,
    txt: HashMap<String, String>,
}

/// Browses `service_type` for `timeout_ms` and returns everything resolved in that window.
///
/// A one-shot command rather than a start/stop pair driven by events: the App's native path
/// (`zeroconf.scan`) is itself a bounded scan that resolves to a list, so matching that shape
/// keeps the bridge free of lifecycle state on both sides.
#[tauri::command]
pub async fn mdns_browse(service_type: String, timeout_ms: u64) -> Result<Vec<MdnsService>, String> {
    // The mdns-sd receiver is blocking, so keep it off the async runtime's worker threads.
    tauri::async_runtime::spawn_blocking(move || browse_blocking(&service_type, timeout_ms))
        .await
        .map_err(|e| format!("mdns browse task failed: {e}"))?
}

fn browse_blocking(service_type: &str, timeout_ms: u64) -> Result<Vec<MdnsService>, String> {
    let daemon = ServiceDaemon::new().map_err(|e| format!("mdns daemon: {e}"))?;
    let receiver = daemon
        .browse(service_type)
        .map_err(|e| format!("mdns browse {service_type}: {e}"))?;

    let hard_deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut deadline = hard_deadline;
    // Once something has resolved, answers from the rest of the network arrive within a moment of
    // each other; waiting out the full window after that only delays the caller.
    let settle = Duration::from_millis(700);
    // Keyed by fullname: the same instance can be reported more than once as its records arrive,
    // and the later report is the resolved one we want.
    let mut found: HashMap<String, MdnsService> = HashMap::new();

    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        match receiver.recv_timeout(remaining) {
            Ok(ServiceEvent::ServiceResolved(info)) => {
                let txt = info
                    .get_properties()
                    .iter()
                    .filter_map(|property| {
                        // `val()` is None for a boolean key — a TXT record written without a value.
                        // Skipping those keeps the map to real key/value pairs rather than emitting
                        // an empty string for them (`val_str()` would have).
                        property.val().map(|value| {
                            (
                                property.key().to_string(),
                                String::from_utf8_lossy(value).to_string(),
                            )
                        })
                    })
                    .collect();

                deadline = std::cmp::min(hard_deadline, Instant::now() + settle);

                let fullname = info.get_fullname().to_string();
                found.insert(
                    fullname.clone(),
                    MdnsService {
                        name: fullname,
                        host: Some(info.get_hostname().to_string()),
                        port: info.get_port(),
                        addresses: info.get_addresses().iter().map(|addr| addr.to_string()).collect(),
                        txt,
                    },
                );
            }
            // Found/Removed and the search lifecycle carry nothing we use; the resolved event does.
            Ok(_) => {}
            // Timeout, or the daemon stopped — either way there is nothing more coming.
            Err(_) => break,
        }
    }

    // Best-effort teardown; the browse result is already collected and a failure here is not the
    // caller's problem.
    let _ = daemon.stop_browse(service_type);
    let _ = daemon.shutdown();

    Ok(found.into_values().collect())
}
