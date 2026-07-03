# Netometer 🌐

**Real-time network monitoring dashboard** — tracks ping, download, upload, jitter, packet loss, and DNS latency with a live scrolling chart.

🔗 **Live site:** [aa4474.github.io/Netometer](https://aa4474.github.io/Netometer)

---

## Features

| Metric | Description |
|---|---|
| **Ping / Latency** | Measured every 5 s via Google's connectivity endpoint |
| **Download Speed** | Tested every 30 s using Cloudflare's speed CDN (25 MB) |
| **Upload Speed** | Tested every 60 s (2 MB POST to Cloudflare) |
| **Jitter** | Exponentially-weighted mean of |Δping| |
| **Packet Loss** | % of ping requests that timed out |
| **DNS Latency** | Round-trip to Google DNS-over-HTTPS |
| **RTT Range** | Min / Max across all samples |
| **Quality Score** | A+ → F grade based on combined metrics |
| **IP / ISP / Location** | Detected automatically via ip-api.com |
| **Connection Type** | From the Network Information API |

## Charts

- **Speedometer gauges** — animated SVG arcs for ping, download, and upload
- **Scrolling timeline** — Canvas line chart showing ping quality over the last 5 minutes; colored green/amber/red by quality; offline periods shaded dark red; download/upload test events marked with triangles

## Tech Stack

- Pure **HTML + CSS + JavaScript** (no frameworks, no build step)
- Hosted on **GitHub Pages**
- External APIs: [ip-api.com](https://ip-api.com), [Cloudflare Speed](https://speed.cloudflare.com), [Google DNS-over-HTTPS](https://dns.google)

## Development

Just open `index.html` in a browser — no build step needed.

```bash
git clone https://github.com/aa4474/Netometer.git
cd Netometer
# open index.html in your browser
```

## License

MIT
